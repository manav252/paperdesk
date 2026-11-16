import type { LogEntry } from './latexLog';

export type ProjectLanguage = 'latex' | 'typst';

/** The language a project is written in: the stored value, or else what its main file's extension says. */
export const projectLanguage = (value: unknown, mainFile = ''): ProjectLanguage =>
  value === 'typst' || value === 'latex' ? value : /\.typ$/i.test(mainFile) ? 'typst' : 'latex';
export const defaultMainFile = (language: ProjectLanguage) => (language === 'typst' ? 'main.typ' : 'main.tex');

const LOCATED = /^(.+?):(\d+):(\d+): (error|warning): (.*)$/;
const BARE = /^(error|warning): (.*)$/;

/**
 * Parses the Typst compiler's output (run with `--diagnostic-format short`): one `file:line:column: error: message`
 * per problem, sometimes followed by `hint:` lines. Problems without a place in a file keep `line: null`.
 */
export function parseTypstLog(output: string, mainFile = 'main.typ') {
  const errors: LogEntry[] = [],
    warnings: LogEntry[] = [];
  let last: LogEntry | null = null;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const located = LOCATED.exec(line);
    if (located) {
      const file = located[1]!.replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '');
      // Problems inside a downloaded or built-in package have no file in the project to jump to.
      const inProject = !file.startsWith('@') && !file.includes('..');
      last = {
        file: inProject ? file : mainFile,
        line: inProject ? Number(located[2]) : null,
        message: inProject ? located[5]! : `${located[5]} (in ${file})`,
      };
      (located[4] === 'error' ? errors : warnings).push(last);
      continue;
    }
    const bare = BARE.exec(line);
    if (bare) {
      last = { file: mainFile, line: null, message: bare[2]! };
      (bare[1] === 'error' ? errors : warnings).push(last);
      continue;
    }
    const hint = /^\s*(?:=\s*)?hint: (.*)$/.exec(line);
    if (hint && last) last.message += ` (hint: ${hint[1]})`;
  }
  return { errors, warnings };
}
