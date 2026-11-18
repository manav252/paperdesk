import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseLatexLog, type LogEntry } from '../src/lib/latexLog';
import { parseTypstLog, type ProjectLanguage } from '../src/lib/typstLog';

/**
 * The document compilers behind POST /api/projects/:id/compile. The route owns everything the two languages share
 * (queueing, cancellation, the warm build folder, timeouts, caching and the response); a compiler only decides
 * which commands to run and how to read their output into the shared diagnostics.
 */
export type CompileOptions = { mainFile: string; engine: string; draft: boolean; stopOnFirstError: boolean };
export type ToolRun = {
  stdout: string;
  stderr: string;
  killed: boolean;
  reason?: 'timeout' | 'output_limit';
  code: number | null;
};
export type CompileContext = {
  dir: string;
  /** The main file without its extension: where `<base>.pdf` and `<base>.log` are written. */
  base: string;
  options: CompileOptions;
  /** The build folder is new, so there is no previous output to build on. */
  fresh: boolean;
  /** Files written or removed by this compile's sync. */
  changed: string[];
  /** The previous compile in this folder succeeded with the same main file. */
  lastSucceeded: boolean;
  run: (argv: string[]) => Promise<ToolRun>;
  aborted: () => boolean;
  /** A cached pdfLaTeX preamble format, when one matches; `reject` marks it unusable. */
  preamble?: { format: string; reject: () => void };
};
export type CompileRun = { run: ToolRun; passes: number; preamble: boolean };
export type Diagnostics = { errors: LogEntry[]; warnings: LogEntry[]; log: string };

export interface Compiler {
  language: ProjectLanguage;
  sourceExtension: '.tex' | '.typ';
  /** Why these options cannot be compiled, or null. */
  invalid(options: CompileOptions): string | null;
  /** Build folders are kept apart per engine, because their auxiliary files differ. */
  workspaceKey(options: CompileOptions): string;
  /** Whether this compile can use a cached preamble format. */
  cachesPreamble(options: CompileOptions): boolean;
  compile(context: CompileContext): Promise<CompileRun>;
  diagnostics(context: CompileContext, output: string, failed: boolean): Promise<Diagnostics>;
  /** A message when the run shows that the compiler itself is not installed, or null. */
  unavailable(run: ToolRun): string | null;
}

const readText = (dir: string, name: string) => fs.readFile(path.join(dir, name), 'utf8').catch(() => '');

export const LATEX_ENGINES: Record<string, string> = { pdflatex: '-pdf', xelatex: '-xelatex', lualatex: '-lualatex' };

export function latexmkArgs({ engine, mainFile, stopOnFirstError, draft }: CompileOptions, format?: string) {
  const fmt = format ? ` -fmt=${format}` : '';
  const command =
    engine === 'pdflatex'
      ? `$pdflatex = "pdflatex -shell-restricted${fmt} %O %S";`
      : engine === 'xelatex'
        ? '$xelatex = "xelatex -shell-restricted %O %S";'
        : '$lualatex = "lualatex -shell-restricted %O %S";';
  return [
    'latexmk',
    LATEX_ENGINES[engine]!,
    '-e',
    command,
    '-synctex=1',
    '-interaction=nonstopmode',
    '-file-line-error',
    ...(stopOnFirstError ? ['-halt-on-error'] : []),
    ...(draft ? ['-draftmode'] : []),
    '-norc',
    mainFile,
  ];
}

/** One engine pass without latexmk, whose startup alone costs most of a second on a small instance. */
function directArgs({ engine, mainFile, stopOnFirstError }: CompileOptions, format?: string) {
  return [
    engine,
    '-shell-restricted',
    ...(format ? [`-fmt=${format}`] : []),
    '-synctex=1',
    '-interaction=nonstopmode',
    '-file-line-error',
    ...(stopOnFirstError ? ['-halt-on-error'] : []),
    mainFile,
  ];
}

/** The log asks for another pass when references, citations or the bibliography changed. */
export const needsRerun = (log: string) =>
  /Rerun to get|Label\(s\) may have changed|Please \(re\)run|run BibTeX|run Biber|Rerun LaTeX/i.test(log);

export const latex: Compiler = {
  language: 'latex',
  sourceExtension: '.tex',
  invalid: (options) => (LATEX_ENGINES[options.engine] ? null : 'Unsupported compiler'),
  workspaceKey: (options) => options.engine,
  cachesPreamble: (options) => options.engine === 'pdflatex' && !options.draft,

  async compile(context) {
    const { dir, base, options } = context;
    let format = context.preamble?.format;
    const auxState = async () =>
      (
        await Promise.all(
          ['aux', 'toc', 'lof', 'lot', 'out', 'nav', 'snm'].map((ext) =>
            fs.readFile(path.join(dir, `${base}.${ext}`)).then(
              (b) => crypto.createHash('sha1').update(b).digest('hex'),
              () => '-',
            ),
          ),
        )
      ).join(',');
    // In a warm folder whose last compile succeeded, one direct engine pass is usually enough. latexmk runs only
    // when the references, contents or bibliography changed, or the log asks for another pass.
    const bibChanged = context.changed.some((name) => /\.(bib|bst|bbx|cbx|bcf)$/i.test(name));
    const fast = !context.fresh && !options.draft && !bibChanged && context.lastSucceeded;
    let run: ToolRun;
    let passes: number;
    if (fast) {
      const before = await auxState();
      run = await context.run(directArgs(options, format));
      passes = 1;
      const more =
        run.code === 0 &&
        !run.killed &&
        (before !== (await auxState()) || needsRerun(await readText(dir, `${base}.log`)));
      if (more && !context.aborted()) {
        run = await context.run(latexmkArgs(options, format));
        passes = 2;
      }
    } else {
      run = await context.run(latexmkArgs(options, format));
      passes = 2;
    }
    // A cached preamble that the document disagrees with must never cost a working compile: retry without it.
    if (format && run.code !== 0 && !run.killed && !context.aborted()) {
      context.preamble?.reject();
      format = undefined;
      run = await context.run(latexmkArgs(options));
    }
    return { run, passes, preamble: !!format };
  },

  async diagnostics({ dir, base, options }, output) {
    const texLog = await readText(dir, `${base}.log`);
    const blg = await readText(dir, `${base}.blg`);
    const { errors, warnings } = parseLatexLog(texLog, blg, options.mainFile);
    const log = [
      texLog || output,
      blg && `\nBibTeX log (${base}.blg):\n${blg}`,
      texLog && `\nlatexmk output:\n${output}`,
    ]
      .filter(Boolean)
      .join('\n');
    return { errors, warnings, log };
  },

  unavailable: () => null,
};

export const typst: Compiler = {
  language: 'typst',
  sourceExtension: '.typ',
  invalid: () => null,
  workspaceKey: () => 'typst',
  cachesPreamble: () => false,

  // `--root .` confines every file the document reads to the project folder; fonts come from the project and
  // Typst's built-in set, and diagnostics are printed one per line for parseTypstLog.
  async compile({ base, options, run }) {
    const result = await run([
      'typst',
      'compile',
      '--root',
      '.',
      '--ignore-system-fonts',
      '--font-path',
      '.',
      '--diagnostic-format',
      'short',
      options.mainFile,
      `${base}.pdf`,
    ]);
    return { run: result, passes: 1, preamble: false };
  },

  async diagnostics({ options }, output, failed) {
    const { errors, warnings } = parseTypstLog(output, options.mainFile);
    const log = output.trim() || (failed ? '' : 'Typst compiled the document without errors or warnings.');
    return { errors, warnings, log };
  },

  unavailable: (run) =>
    /executable file not found|typst: No such file|failed to execute/i.test(run.stderr)
      ? 'Typst is not installed in this service.'
      : null,
};

export const compilers: Record<ProjectLanguage, Compiler> = { latex, typst };

/**
 * Identifies the inputs of a compile: every source file's hash and the options. The same key means the same
 * output, so the previous result can be returned without running the compiler again.
 */
export function sourcesKey(language: ProjectLanguage, options: CompileOptions, hashes: Map<string, string>) {
  const files = [...hashes].sort(([a], [b]) => (a < b ? -1 : 1));
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([language, options, files]))
    .digest('hex');
}
