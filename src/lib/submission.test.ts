import { describe, expect, it } from 'vitest';
import {
  applyFix,
  asciiName,
  checkSubmission,
  exportFiles,
  flatten,
  IMAGE_LIMIT_BYTES,
  parseFls,
  removeBibEntry,
  type CompileFacts,
  type Issue,
  type SubmissionFile,
} from './submission';

const ok: CompileFacts = { success: true, errors: [], warnings: [] };
const png: SubmissionFile = { name: 'figures/plot.png', content: 'aGVsbG8=', encoding: 'base64' };
const clean: SubmissionFile[] = [
  {
    name: 'main.tex',
    content:
      '\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\n\\section{Intro}\\label{sec:intro}\nSee \\ref{sec:intro} and \\cite{knuth1984}.\n\\input{sections/method}\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n',
  },
  { name: 'sections/', content: '' },
  {
    name: 'sections/method.tex',
    content:
      '\\begin{figure}\\includegraphics{figures/plot}\\caption{Plot}\\label{fig:plot}\\end{figure}\nFigure~\\ref{fig:plot}.\n',
  },
  { name: 'figures/', content: '' },
  png,
  { name: 'refs.bib', content: '@book{knuth1984,\n  title = {The {TeX}book},\n  year = {1984}\n}\n' },
];
const kinds = (issues: Issue[]) => issues.map((i) => i.kind);
const check = (
  files: SubmissionFile[],
  compile: CompileFacts | null = ok,
  fonts: { name: string; embedded: boolean }[] | null = [],
) => checkSubmission(files, 'main.tex', compile, fonts);
const withMain = (extra: string, more: SubmissionFile[] = []) => [
  ...clean.map((f) =>
    f.name === 'main.tex' ? { ...f, content: f.content.replace('\\end{document}', `${extra}\n\\end{document}`) } : f,
  ),
  ...more,
];

describe('checkSubmission', () => {
  it('finds nothing wrong with a clean project', () => {
    expect(check(clean)).toEqual([]);
  });

  it('reports errors and warnings from the compile log, with their location', () => {
    const issues = check(clean, {
      success: false,
      errors: [{ file: 'main.tex', line: 5, message: 'Undefined control sequence.' }],
      warnings: [{ file: 'sections/method.tex', line: 2, message: 'Overfull \\hbox (12.0pt too wide)' }],
    });
    expect(issues).toEqual([
      { kind: 'log-error', severity: 'error', message: 'Undefined control sequence.', file: 'main.tex', line: 5 },
      {
        kind: 'log-warning',
        severity: 'warning',
        message: 'Overfull \\hbox (12.0pt too wide)',
        file: 'sections/method.tex',
        line: 2,
      },
    ]);
  });

  it('reports undefined references and citations where they are used, once each', () => {
    const issues = check(withMain('\\ref{sec:gone} \\citep[p.~3]{nobody2020, knuth1984}'), {
      success: true,
      errors: [],
      warnings: [
        { file: 'main.tex', line: 9, message: "Reference `sec:gone' on page 1 undefined" },
        { file: 'main.tex', line: 9, message: "Citation `nobody2020' on page 1 undefined" },
        { file: null, line: null, message: 'There were undefined references.' },
      ],
    });
    expect(issues).toEqual([
      {
        kind: 'undefined-reference',
        severity: 'error',
        message: 'Reference “sec:gone” has no \\label.',
        file: 'main.tex',
        line: 9,
      },
      {
        kind: 'undefined-citation',
        severity: 'error',
        message: 'Citation “nobody2020” isn’t in the bibliography.',
        file: 'main.tex',
        line: 9,
      },
    ]);
  });

  it('keeps an undefined reference only the log knows about (built by a macro)', () => {
    const issues = check(clean, {
      success: true,
      errors: [],
      warnings: [{ file: 'main.tex', line: 4, message: "Reference `eq:auto' on page 2 undefined" }],
    });
    expect(issues).toEqual([
      {
        kind: 'undefined-reference',
        severity: 'error',
        message: "Reference `eq:auto' on page 2 undefined",
        file: 'main.tex',
        line: 4,
      },
    ]);
  });

  it('reports labels and citation keys defined more than once', () => {
    const files = withMain('\\label{sec:intro}').map((f) =>
      f.name === 'refs.bib' ? { ...f, content: `${f.content}\n@article{knuth1984,\n  title = {Again}\n}\n` } : f,
    );
    expect(check(files)).toEqual([
      {
        kind: 'multiply-defined',
        severity: 'error',
        message: 'Label “sec:intro” is defined 2 times (first in main.tex, line 4).',
        file: 'main.tex',
        line: 9,
      },
      {
        kind: 'multiply-defined',
        severity: 'error',
        message: 'Citation key “knuth1984” is defined more than once (first on line 1).',
        file: 'refs.bib',
        line: 6,
      },
    ]);
  });

  it('reports missing figures, inputs and bibliographies, but not commented-out ones', () => {
    const issues = check(
      withMain(
        '\\includegraphics[width=2cm]{figures/gone}\n\\input{sections/missing}\n% \\input{sections/ignored}\n\\addbibresource{other.bib}',
      ),
    );
    expect(issues.map((i) => [i.kind, i.message, i.line])).toEqual([
      ['missing-file', 'Figure “figures/gone” isn’t in the project.', 9],
      ['missing-file', 'File “sections/missing” isn’t in the project.', 10],
      ['missing-file', 'Bibliography “other.bib” isn’t in the project.', 12],
    ]);
  });

  it('finds figures through \\graphicspath and with any supported extension', () => {
    const files = withMain('\\graphicspath{{figures/}{img/}}\n\\includegraphics{plot}\n\\includegraphics{photo}', [
      { name: 'img/photo.jpg', content: 'aGk=', encoding: 'base64' },
    ]);
    expect(check(files)).toEqual([]);
  });

  it('reports files the document never uses, with a fix that deletes them', () => {
    const files = [
      ...clean,
      { name: 'old-draft.tex', content: '\\ref{nowhere}' },
      { name: 'figures/unused.png', content: 'aGk=', encoding: 'base64' },
      { name: 'README.md', content: 'notes' },
    ];
    const issues = check(files);
    expect(issues.map((i) => [i.kind, i.severity, i.file])).toEqual([
      ['unused-file', 'info', 'old-draft.tex'],
      ['unused-file', 'info', 'figures/unused.png'],
    ]);
    expect(applyFix(files, issues[0]!.fix!).map((f) => f.name)).not.toContain('old-draft.tex');
  });

  it('reports bibliography entries that are never cited, unless \\nocite{*} is used', () => {
    const more = '@article{lamport1986,\n  title = {LaTeX}\n}\n';
    const files = clean.map((f) => (f.name === 'refs.bib' ? { ...f, content: f.content + more } : f));
    const issues = check(files);
    expect(issues).toEqual([
      {
        kind: 'unused-bib-entry',
        severity: 'info',
        message: 'Bibliography entry “lamport1986” is never cited.',
        file: 'refs.bib',
        line: 5,
        fix: { type: 'remove-bib-entry', file: 'refs.bib', key: 'lamport1986', label: 'Remove entry' },
      },
    ]);
    expect(applyFix(files, issues[0]!.fix!).find((f) => f.name === 'refs.bib')!.content).toBe(
      clean.find((f) => f.name === 'refs.bib')!.content,
    );
    expect(
      check(
        files.map((f) =>
          f.name === 'main.tex'
            ? { ...f, content: f.content.replace('\\bibliography{', '\\nocite{*}\\bibliography{') }
            : f,
        ),
      ),
    ).toEqual([]);
  });

  it('reports images over the size limit', () => {
    const big = { ...png, content: 'A'.repeat(Math.ceil(((IMAGE_LIMIT_BYTES + 3000) * 4) / 3)) };
    const issues = check(clean.map((f) => (f === png ? big : f)));
    expect(issues.map((i) => [i.kind, i.file])).toEqual([['large-image', 'figures/plot.png']]);
    expect(issues[0]!.message).toContain('5.0 MB');
  });

  it('reports fonts that are not embedded, and says when fonts could not be read', () => {
    expect(
      check(clean, ok, [
        { name: 'CMR10', embedded: true },
        { name: 'Helvetica', embedded: false },
      ]).map((i) => [i.kind, i.message.split('.')[0]]),
    ).toEqual([['font-not-embedded', 'Font “Helvetica” isn’t embedded in the PDF']]);
    expect(kinds(check(clean, ok, null))).toEqual(['fonts-unchecked']);
  });

  it('says when the project has not been compiled', () => {
    expect(kinds(check(clean, null, null))).toEqual(['not-compiled']);
    expect(kinds(check(clean, { success: null, errors: [], warnings: [] }, null))).toEqual(['not-compiled']);
  });

  it('reports absolute paths instead of calling the file missing', () => {
    const issues = check(
      withMain('\\includegraphics{/Users/me/plot.png}\n\\input{C:/thesis/intro}\n\\includegraphics{~/plot.png}'),
    );
    expect(issues.map((i) => [i.kind, i.line])).toEqual([
      ['absolute-path', 9],
      ['absolute-path', 10],
      ['absolute-path', 11],
    ]);
  });

  it('reports non-ASCII file names and renames them everywhere, references included', () => {
    const files = withMain(
      '\\includegraphics{figures/résumé plot}\n\\input{sections/übersicht}\n\\includegraphics{图/图表.png}',
      [
        { name: 'figures/résumé plot.png', content: 'aGk=', encoding: 'base64' },
        { name: 'sections/übersicht.tex', content: 'Text' },
        { name: '图/', content: '' },
        { name: '图/图表.png', content: 'aGk=', encoding: 'base64' },
      ],
    );
    const issues = check(files);
    expect(issues.map((i) => [i.kind, i.file])).toEqual([
      ['non-ascii-name', 'figures/résumé plot.png'],
      ['non-ascii-name', 'sections/übersicht.tex'],
      ['non-ascii-name', '图/图表.png'],
    ]);
    const fixed = applyFix(files, issues[0]!.fix!);
    expect(fixed.map((f) => f.name).filter((n) => !clean.some((c) => c.name === n))).toEqual([
      'figures/resume plot.png',
      'sections/ubersicht.tex',
      'file/',
      'file/file.png',
    ]);
    expect(fixed.find((f) => f.name === 'main.tex')!.content).toContain(
      '\\includegraphics{figures/resume plot}\n\\input{sections/ubersicht}\n\\includegraphics{file/file.png}',
    );
    expect(check(fixed)).toEqual([]);
  });

  it('reports stray build files and deletes them all with one fix', () => {
    const files = [
      ...clean,
      { name: 'main.aux', content: '' },
      { name: 'main.log', content: '' },
      { name: 'sections/method.aux', content: '' },
      { name: 'main.synctex.gz', content: 'AA==', encoding: 'base64' },
      { name: 'main.pdf', content: 'AA==', encoding: 'base64' },
      { name: 'main.bbl', content: '\\begin{thebibliography}{1}\\end{thebibliography}' },
    ];
    const issues = check(files);
    expect(issues.map((i) => [i.kind, i.file])).toEqual([
      ['build-file', 'main.aux'],
      ['build-file', 'main.log'],
      ['build-file', 'sections/method.aux'],
      ['build-file', 'main.synctex.gz'],
      ['build-file', 'main.pdf'],
    ]);
    expect(issues[0]!.fix).toEqual({
      type: 'delete-files',
      files: ['main.aux', 'main.log', 'sections/method.aux', 'main.synctex.gz', 'main.pdf'],
      label: 'Delete all 5 build files',
    });
    expect(check(applyFix(files, issues[0]!.fix!))).toEqual([]);
  });
});

describe('helpers', () => {
  it('removes one bibliography entry and leaves the others intact', () => {
    const bib = '@book{a,\n  title = {A {B} C}\n}\n\n@article{b,\n  title = {B}\n}\n\n@misc{c,\n  note = {C}\n}\n';
    expect(removeBibEntry(bib, 'b')).toBe('@book{a,\n  title = {A {B} C}\n}\n\n@misc{c,\n  note = {C}\n}\n');
    expect(removeBibEntry(bib, 'a')).toBe('@article{b,\n  title = {B}\n}\n\n@misc{c,\n  note = {C}\n}\n');
    expect(removeBibEntry(bib, 'missing')).toBe(bib);
    expect(removeBibEntry(bib, 'c')).toBe('@book{a,\n  title = {A {B} C}\n}\n\n@article{b,\n  title = {B}\n}\n');
    expect(removeBibEntry('@misc{only,\n  note = {x}\n}\n', 'only')).toBe('');
  });

  it('makes ASCII names without clashing with existing ones', () => {
    expect(asciiName('Übung größe.png')).toBe('Ubung grosse.png');
    expect(asciiName('naïve.tex', new Set(['naive.tex']))).toBe('naive-2.tex');
    expect(asciiName('图表.png')).toBe('file.png');
  });

  it('flattens \\input and \\include into one file, leaving comments and missing files alone', () => {
    const files: SubmissionFile[] = [
      {
        name: 'main.tex',
        content:
          '\\begin{document}\n\\input{a}\n% \\input{b}\nText \\input{sub/b.tex} end % \\input{a}\n\\include{c}\n\\input{missing}\n\\end{document}\n',
      },
      { name: 'a.tex', content: 'A1\n\\input{sub/b}\nA2\n' },
      { name: 'sub/b.tex', content: 'B\n\\endinput\nnever' },
      { name: 'c.tex', content: 'C \\input{c}\n' },
    ];
    expect(flatten(files, 'main.tex')).toBe(
      '\\begin{document}\nA1\nB\nA2\n% \\input{b}\nText B end % \\input{a}\n\\clearpage\nC \\input{c}\n\\clearpage\n\\input{missing}\n\\end{document}\n',
    );
  });

  it('reads project files from a recorder file and picks the files for each kind of export', () => {
    const fls =
      'PWD /work\nINPUT /usr/share/texlive/article.cls\nINPUT main.tex\nINPUT ./sections/method.tex\nINPUT /work/figures/plot.png\nINPUT main.aux\nOUTPUT main.pdf\nINPUT main.tex\n';
    const read = parseFls(fls);
    expect(read).toEqual(['main.tex', 'sections/method.tex', 'figures/plot.png', 'main.aux']);
    const files = [
      ...clean,
      { name: 'main.aux', content: '' },
      { name: 'unused.tex', content: '' },
      { name: 'main.bbl', content: 'old' },
    ];
    expect(exportFiles(files, 'main.tex', read, 'arxiv')).toEqual([
      'main.tex',
      'sections/method.tex',
      'figures/plot.png',
    ]);
    expect(exportFiles(files, 'main.tex', read, 'journal')).toEqual([
      'main.tex',
      'sections/method.tex',
      'figures/plot.png',
      'refs.bib',
    ]);
  });
});
