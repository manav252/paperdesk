import { describe, expect, it } from 'vitest';
import { parseBibtexLog, parseLatexLog, unwrapTexLog } from './latexLog';

const undefinedCs = String.raw`This is pdfTeX, Version 3.141592653-2.6-1.40.26 (TeX Live 2024) (preloaded format=pdflatex)
(./main.tex
LaTeX2e <2023-11-01>
(/usr/local/texlive/2024/texmf-dist/tex/latex/base/article.cls
Document Class: article 2023/05/17 v1.4n Standard LaTeX document class
(/usr/local/texlive/2024/texmf-dist/tex/latex/base/size10.clo))
No file main.aux.
(./sections/results.tex
./sections/results.tex:5: Undefined control sequence.
l.5 \thisCommandDoesNotExist
                            {oops}
?
./sections/results.tex:5: Emergency stop.
l.5 \thisCommandDoesNotExist
                            {oops}
No pages of output.
`;

describe('parseLatexLog', () => {
  it('reports file:line errors from -file-line-error output with the offending code', () => {
    const { errors } = parseLatexLog(undefinedCs);
    expect(errors[0]).toEqual({ file: 'sections/results.tex', line: 5, message: 'Undefined control sequence. — \\thisCommandDoesNotExist{oops}' });
  });

  it('keeps the follow-on emergency stop separate from the cause', () => {
    const { errors } = parseLatexLog(undefinedCs);
    expect(errors.map(e => e.message.split(' —')[0])).toEqual(['Undefined control sequence.', 'Emergency stop.']);
  });

  it('parses "!"-style errors and finds the l.<n> line', () => {
    const log = '(./main.tex\n! Missing $ inserted.\n<inserted text> \n                $\nl.12 x^\n       2\n';
    expect(parseLatexLog(log).errors).toEqual([{ file: 'main.tex', line: 12, message: 'Missing $ inserted.' }]);
  });

  it('makes missing image errors actionable and keeps their source line', () => {
    const log = "(./main.tex\n! LaTeX Error: File `missing-image.png' not found.\nl.18 \\includegraphics{missing-image.png}\n";
    expect(parseLatexLog(log).errors[0]).toEqual({ file: 'main.tex', line: 18, message: 'Image or file “missing-image.png” was not found. Check the path on this line.' });
  });

  it('attributes warnings to the file being read', () => {
    const log = [
      '(./main.tex (./chapters/intro.tex',
      'LaTeX Warning: Citation `knuth84\' on page 1 undefined on input line 3.',
      '',
      ') (./chapters/methods.tex',
      'Package hyperref Warning: Token not allowed in a PDF string (Unicode):',
      '(hyperref)                removing `math shift\' on input line 7.',
      '',
      '))',
      'LaTeX Warning: There were undefined references.',
    ].join('\n');
    const { warnings } = parseLatexLog(log);
    expect(warnings).toEqual([
      { file: 'chapters/intro.tex', line: 3, message: 'Citation `knuth84\' on page 1 undefined' },
      { file: 'chapters/methods.tex', line: 7, message: 'hyperref: Token not allowed in a PDF string (Unicode): removing `math shift\'' },
      { file: 'main.tex', line: null, message: 'There were undefined references.' },
    ]);
  });

  it('ignores files from the TeX distribution when attributing messages', () => {
    const log = '(./main.tex (/usr/local/texlive/tex/latex/foo.sty\nLaTeX Warning: Something happened on input line 9.\n';
    expect(parseLatexLog(log).warnings[0].file).toBe('main.tex');
  });

  it('reports overfull boxes with their source lines', () => {
    const log = '(./main.tex\nOverfull \\hbox (12.3pt too wide) in paragraph at lines 20--24\n';
    expect(parseLatexLog(log).warnings[0]).toMatchObject({ file: 'main.tex', line: 20 });
  });

  it('uses the given main file when nothing better is known', () => {
    expect(parseLatexLog('! Emergency stop.\n', '', 'paper.tex').errors[0].file).toBe('paper.tex');
  });
});

describe('unwrapTexLog', () => {
  it('joins lines TeX wrapped at 79 characters', () => {
    const long = './chapters/a-very-long-file-name-that-goes-past-the-limit/' + 'x'.repeat(40);
    const wrapped = long.slice(0, 79) + '\n' + long.slice(79) + '.tex:3: Undefined control sequence.';
    expect(long.slice(0, 79)).toHaveLength(79);
    expect(unwrapTexLog(wrapped)).toEqual([long + '.tex:3: Undefined control sequence.']);
  });
});

describe('parseBibtexLog', () => {
  it('reports syntax errors with file and line, and missing entries as warnings', () => {
    const blg = [
      'Database file #1: refs.bib',
      "I was expecting a `,' or a `}'---line 7 of file refs.bib",
      ' :   title = {Oops}',
      'Warning--I didn\'t find a database entry for "missing2020"',
      '(There was 1 error message)',
    ].join('\n');
    const { errors, warnings } = parseBibtexLog(blg);
    expect(errors).toEqual([{ file: 'refs.bib', line: 7, message: "BibTeX: I was expecting a `,' or a `}'" }]);
    expect(warnings).toEqual([{ file: null, line: null, message: 'BibTeX: I didn\'t find a database entry for "missing2020"' }]);
  });

  it('is merged into parseLatexLog results', () => {
    const r = parseLatexLog('(./main.tex\n', "I couldn't open database file refs.bib\n");
    expect(r.errors).toEqual([{ file: null, line: null, message: "BibTeX: couldn't open database file refs.bib" }]);
  });
});
