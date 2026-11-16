import { describe, expect, it } from 'vitest';
import {
  collectCitations,
  collectLabels,
  collectTypstReferences,
  completionContext,
  projectPaths,
  relativePath,
  typstCompletionContext,
  typstPaths,
} from './completion';

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

describe('Typst completion', () => {
  it('knows what is being typed', () => {
    expect(typstCompletionContext('Some text #fig')).toEqual({ kind: 'function', partial: 'fig' });
    expect(typstCompletionContext('#')).toEqual({ kind: 'function', partial: '' });
    expect(typstCompletionContext('see @sec:me')).toEqual({ kind: 'ref', partial: 'sec:me' });
    expect(typstCompletionContext('mail me@example')).toBeNull();
    expect(typstCompletionContext('#image("figures/')).toEqual({ kind: 'path', partial: 'figures/', files: 'image' });
    expect(typstCompletionContext('#include "ch')).toEqual({ kind: 'path', partial: 'ch', files: 'typ' });
    expect(typstCompletionContext('#bibliography("')).toEqual({ kind: 'path', partial: '', files: 'bib' });
    expect(typstCompletionContext('plain text')).toBeNull();
  });
  it('offers labels and bibliography keys, and paths relative to the file being edited', () => {
    const files = [
      { name: 'main.typ', content: '= Intro <intro>\n// <commented>' },
      { name: 'sections/a.typ', content: '#figure(image("../figures/p.png")) <fig:p>' },
      { name: 'figures/p.png', content: '', encoding: 'base64' as const },
      { name: 'refs.bib', content: '@article{knuth84,\n  title = {Literate},\n}' },
      { name: 'refs.yml', content: 'turing50:\n  type: article\n' },
    ];
    expect(collectTypstReferences(files).map((r) => r.key)).toEqual(['intro', 'fig:p', 'knuth84', 'turing50']);
    expect(relativePath('sections/a.typ', 'figures/p.png')).toBe('../figures/p.png');
    expect(relativePath('main.typ', 'figures/p.png')).toBe('figures/p.png');
    expect(relativePath('a/b/c.typ', 'a/d.typ')).toBe('../d.typ');
    expect(typstPaths(files, 'image', 'sections/a.typ')).toEqual(['../figures/p.png']);
    expect(typstPaths(files, 'typ', 'main.typ')).toEqual(['sections/a.typ']);
    expect(typstPaths(files, 'bib', 'main.typ')).toEqual(['refs.bib', 'refs.yml']);
  });
});
