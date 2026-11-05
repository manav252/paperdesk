import { describe, expect, it } from 'vitest';
import { proseWords } from './spellText';

const words = (source: string) => proseWords(source).map(w => w.word);

describe('prose words in LaTeX', () => {
  it('keeps prose and section titles, with offsets', () => {
    const source = '\\section{Introdcution}\nThe quick brwon fox.';
    expect(words(source)).toEqual(['Introdcution', 'The', 'quick', 'brwon', 'fox']);
    const brwon = proseWords(source).find(w => w.word === 'brwon')!;
    expect(source.slice(brwon.offset, brwon.offset + 5)).toBe('brwon');
  });

  it('skips commands, comments and math', () => {
    expect(words('\\textbf{bold} text % a commnet\n$x + yzzz$ and \\(abcq\\) or \\[qqqq\\] $$wwww$$ done'))
      .toEqual(['bold', 'text', 'and', 'or', 'done']);
  });

  it('skips keys, file names and code', () => {
    expect(words('See \\cite{knuth84} and \\ref{fig:plt}, \\usepackage[utf8]{inputenc} \\includegraphics[width=2cm]{figs/plot} \\url{http://x.io} \\verb|xyzq| end'))
      .toEqual(['See', 'and', 'end']);
  });

  it('skips math and code environments but keeps figures', () => {
    expect(words('\\begin{equation} E = mcc \\end{equation}\n\\begin{figure}[ht]\n\\caption{A captoin}\n\\end{figure}\n\\begin{verbatim}codez\\end{verbatim}'))
      .toEqual(['captoin']);
  });

  it('checks table cells but skips column specs and identifiers with digits', () => {
    expect(words('\\begin{tabular}{lrc} Trial & Value \\end{tabular} fig1 plain')).toEqual(['Trial', 'Value', 'plain']);
    expect(words("don't stop")).toEqual(["don't", 'stop']);
  });
});
