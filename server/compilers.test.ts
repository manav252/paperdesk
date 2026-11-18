import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compilers, needsRerun, sourcesKey, type CompileContext, type ToolRun } from './compilers';

const ok: ToolRun = { stdout: '', stderr: '', killed: false, code: 0 };
let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A compile context whose commands are recorded and answered by `answer` instead of being run. */
function context(
  language: 'latex' | 'typst',
  overrides: Partial<CompileContext> = {},
  answer = (_argv: string[]) => ok,
) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'paperdesk-compiler-test-'));
  dirs.push(dir);
  const runs: string[][] = [];
  const mainFile = language === 'typst' ? 'main.typ' : 'main.tex';
  const ctx: CompileContext = {
    dir,
    base: 'main',
    options: { mainFile, engine: 'pdflatex', draft: false, stopOnFirstError: true },
    fresh: true,
    changed: [mainFile],
    lastSucceeded: false,
    run: async (argv) => {
      runs.push(argv);
      return answer(argv);
    },
    aborted: () => false,
    ...overrides,
  };
  return { ctx, runs, dir };
}

describe.each(['latex', 'typst'] as const)('the %s compiler', (language) => {
  const compiler = compilers[language];

  it('runs the compiler on the main file and reports success', async () => {
    const { ctx, runs } = context(language);
    const result = await compiler.compile(ctx);
    expect(result.run.code).toBe(0);
    expect(runs.length).toBe(1);
    expect(runs[0]!.at(language === 'typst' ? -2 : -1)).toBe(ctx.options.mainFile);
  });

  it('passes a failed or timed-out run through unchanged', async () => {
    for (const run of [
      { ...ok, code: 1, stdout: 'error output' },
      { ...ok, code: null, killed: true, reason: 'timeout' as const },
    ]) {
      const { ctx } = context(language, {}, () => run);
      expect((await compiler.compile(ctx)).run).toEqual(run);
    }
  });

  it('reads its output into the shared diagnostics: file, line and message, split into errors and warnings', async () => {
    const { ctx, dir } = context(language);
    const output =
      language === 'typst'
        ? 'main.typ:4:2: error: unknown variable: x\nmain.typ:9:0: warning: unknown font family: nope'
        : '';
    if (language === 'latex')
      writeFileSync(
        path.join(dir, 'main.log'),
        [
          '(./main.tex',
          './main.tex:4: Undefined control sequence.',
          'l.4 \\x',
          '',
          "LaTeX Warning: Reference `fig:a' on page 1 undefined on input line 9.",
          ')',
        ].join('\n'),
      );
    const diagnostics = await compiler.diagnostics(ctx, output, true);
    expect(diagnostics.errors[0]).toMatchObject({ file: ctx.options.mainFile, line: 4 });
    expect(diagnostics.warnings[0]).toMatchObject({ file: ctx.options.mainFile, line: 9 });
    for (const entry of [...diagnostics.errors, ...diagnostics.warnings]) {
      expect(Object.keys(entry).sort()).toEqual(['file', 'line', 'message']);
      expect(entry.message.length).toBeGreaterThan(3);
    }
    expect(diagnostics.log.length).toBeGreaterThan(0);
  });

  it('keeps a separate build folder per engine and checks its main file', () => {
    expect(compiler.workspaceKey(context(language).ctx.options)).toBe(language === 'typst' ? 'typst' : 'pdflatex');
    expect(compiler.sourceExtension).toBe(language === 'typst' ? '.typ' : '.tex');
  });
});

describe('LaTeX passes', () => {
  it('goes through latexmk in a new folder, and a single engine pass in a warm one', async () => {
    const cold = context('latex');
    expect((await compilers.latex.compile(cold.ctx)).passes).toBe(2);
    expect(cold.runs[0]![0]).toBe('latexmk');
    const warm = context('latex', { fresh: false, lastSucceeded: true });
    expect((await compilers.latex.compile(warm.ctx)).passes).toBe(1);
    expect(warm.runs.map((r) => r[0])).toEqual(['pdflatex']);
  });
  it('runs latexmk after the single pass only when the log asks for another pass', async () => {
    const warm = context('latex', { fresh: false, lastSucceeded: true }, (argv) => {
      if (argv[0] === 'pdflatex')
        writeFileSync(
          path.join(warm.dir, 'main.log'),
          'LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.',
        );
      return ok;
    });
    expect((await compilers.latex.compile(warm.ctx)).passes).toBe(2);
    expect(warm.runs.map((r) => r[0])).toEqual(['pdflatex', 'latexmk']);
    expect(needsRerun("Package rerunfilecheck Warning: File `main.out' has changed.")).toBe(false);
    expect(needsRerun('Please (re)run Biber on the file')).toBe(true);
  });
  it('drops a cached preamble that breaks the compile and tries again without it', async () => {
    let rejected = false;
    const { ctx, runs } = context(
      'latex',
      { preamble: { format: 'pd-preamble', reject: () => (rejected = true) } },
      (argv) => (argv.join(' ').includes('-fmt=') ? { ...ok, code: 1 } : ok),
    );
    const result = await compilers.latex.compile(ctx);
    expect(rejected).toBe(true);
    expect(result).toMatchObject({ preamble: false, run: { code: 0 } });
    expect(runs).toHaveLength(2);
  });
  it('only rebuilds the preamble cache for pdfLaTeX without draft mode', () => {
    const options = { mainFile: 'main.tex', engine: 'pdflatex', draft: false, stopOnFirstError: true };
    expect(compilers.latex.cachesPreamble(options)).toBe(true);
    expect(compilers.latex.cachesPreamble({ ...options, engine: 'xelatex' })).toBe(false);
    expect(compilers.latex.cachesPreamble({ ...options, draft: true })).toBe(false);
    expect(compilers.typst.cachesPreamble(options)).toBe(false);
    expect(compilers.latex.invalid({ ...options, engine: 'tectonic' })).toBe('Unsupported compiler');
  });
});

describe('unchanged sources', () => {
  const options = { mainFile: 'main.tex', engine: 'pdflatex', draft: false, stopOnFirstError: true };
  const hashes = new Map([
    ['main.tex', 'a1'],
    ['refs.bib', 'b2'],
  ]);
  it.each(['latex', 'typst'] as const)('give the same key for %s, whatever the file order', (language) => {
    const reordered = new Map([...hashes].reverse());
    expect(sourcesKey(language, options, hashes)).toBe(sourcesKey(language, options, reordered));
  });
  it('change the key when a file, an option or the language changes', () => {
    const key = sourcesKey('latex', options, hashes);
    expect(sourcesKey('latex', options, new Map([...hashes, ['main.tex', 'a2']]))).not.toBe(key);
    expect(sourcesKey('latex', { ...options, engine: 'xelatex' }, hashes)).not.toBe(key);
    expect(sourcesKey('typst', options, hashes)).not.toBe(key);
  });
});
