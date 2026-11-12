import { describe, expect, it } from 'vitest';
import { collectCitations, collectLabels, completionContext, projectPaths } from './completion';

const files = [
  {
    name: 'main.tex',
    content:
      '\\section{A}\\label{sec:intro}\n% \\label{commented}\n\\begin{equation}\\label{eq:euler}x\\end{equation}\n\\bibitem{knuth} Knuth, The TeXbook',
  },
  { name: 'chapters/two.tex', content: '\\label{fig:plot}' },
  {
    name: 'refs.bib',
    content:
      '@article{shannon1948,\n  title = {A Mathematical Theory of Communication},\n}\n@book{lamport94, title="LaTeX"}\n@string{x = "y"}',
  },
  { name: 'figures/', content: '' },
  { name: 'figures/plot.png', content: 'AA==', encoding: 'base64' as const },
  { name: 'notes.txt', content: '' },
];

describe('completionContext', () => {
  it('recognises what is being typed', () => {
    expect(completionContext('see \\ref{sec:')).toEqual({ kind: 'ref', partial: 'sec:' });
    expect(completionContext('\\eqref{')).toEqual({ kind: 'ref', partial: '' });
    expect(completionContext('\\citep[p.~3]{knuth, sha')).toEqual({ kind: 'cite', partial: 'sha' });
    expect(completionContext('\\includegraphics[width=\\linewidth]{fig')).toEqual({ kind: 'graphics', partial: 'fig' });
    expect(completionContext('\\input{chap')).toEqual({ kind: 'input', partial: 'chap' });
    expect(completionContext('\\bibliography{re')).toEqual({ kind: 'bib', partial: 're' });
    expect(completionContext('\\begin{ali')).toEqual({ kind: 'env', partial: 'ali' });
    expect(completionContext('text \\textb')).toEqual({ kind: 'command', partial: 'textb' });
    expect(completionContext('plain text')).toBeNull();
    expect(completionContext('\\ref{done} more')).toBeNull();
  });
});

describe('project names', () => {
  it('collects labels outside comments, with their location', () => {
    expect(collectLabels(files)).toEqual([
      { label: 'sec:intro', file: 'main.tex', line: 1 },
      { label: 'eq:euler', file: 'main.tex', line: 3 },
      { label: 'fig:plot', file: 'chapters/two.tex', line: 1 },
    ]);
  });

  it('collects citation keys from .bib files and \\bibitem', () => {
    expect(collectCitations(files)).toEqual([
      { key: 'shannon1948', detail: 'A Mathematical Theory of Communication' },
      { key: 'lamport94', detail: 'LaTeX' },
      { key: 'knuth', detail: 'Knuth, The TeXbook' },
    ]);
  });

  it('lists paths for images, inputs and bibliographies', () => {
    expect(projectPaths(files, 'graphics')).toEqual(['figures/plot.png']);
    expect(projectPaths(files, 'input')).toEqual(['main', 'chapters/two']);
    expect(projectPaths(files, 'bib')).toEqual(['refs']);
  });
});
