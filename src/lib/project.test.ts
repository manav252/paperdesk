import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTree, decodeBase64Utf8, isBinary, relative, tabFiles, type ProjectFile } from './project';

const f = (name: string): ProjectFile => ({ name, content: '' });

describe('buildTree', () => {
  it('nests files under folders and sorts folders first', () => {
    const tree = buildTree([f('main.tex'), f('figures/b.png'), f('figures/a.png'), f('appendix/'), f('refs.bib')]);
    expect(tree.map(n => n.name)).toEqual(['appendix', 'figures', 'main.tex', 'refs.bib']);
    const figures = tree.find(n => n.name === 'figures')!;
    expect(figures.folder).toBe(true);
    expect(figures.path).toBe('figures/');
    expect(figures.children.map(n => n.path)).toEqual(['figures/a.png', 'figures/b.png']);
  });

  it('keeps explicit empty folders and links them to their file entry', () => {
    const empty = f('notes/');
    const [node] = buildTree([empty]);
    expect(node).toMatchObject({ name: 'notes', folder: true, children: [] });
    expect(node.file).toBe(empty);
  });

  it('creates implicit parent folders for deep paths', () => {
    const [top] = buildTree([f('a/b/c.tex')]);
    expect(top.path).toBe('a/');
    expect(top.children[0].path).toBe('a/b/');
    expect(top.children[0].children[0].path).toBe('a/b/c.tex');
  });
});

describe('tabFiles', () => {
  const files = ['a.tex', 'b.tex', 'c.tex', 'd.tex', 'e.tex', 'f.tex', 'dir/'].map(f);

  it('skips folders and caps at five tabs', () => {
    expect(tabFiles(files, 'a.tex').map(x => x.name)).toEqual(['a.tex', 'b.tex', 'c.tex', 'd.tex', 'e.tex']);
  });

  it('always includes the active file', () => {
    expect(tabFiles(files, 'f.tex').map(x => x.name)).toEqual(['a.tex', 'b.tex', 'c.tex', 'd.tex', 'f.tex']);
  });
});

describe('isBinary', () => {
  it('detects images and PDFs case-insensitively', () => {
    expect(isBinary('fig.PNG')).toBe(true);
    expect(isBinary('out.pdf')).toBe(true);
    expect(isBinary('main.tex')).toBe(false);
  });
});

describe('relative', () => {
  afterEach(() => vi.useRealTimers());

  it('formats recent times', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
    const now = Date.now();
    expect(relative(now)).toBe('Just now');
    expect(relative(now - 5 * 60_000)).toBe('5 min ago');
    expect(relative(now - 3 * 3_600_000)).toBe('3 hr ago');
    expect(relative(now - 2 * 86_400_000)).toBe('2 days ago');
  });
});

describe('decodeBase64Utf8', () => {
  it('decodes UTF-8 text', () => {
    expect(decodeBase64Utf8(Buffer.from('Ünïcode ✓').toString('base64'))).toBe('Ünïcode ✓');
  });

  it('returns an empty string for invalid input', () => {
    expect(decodeBase64Utf8('%%%')).toBe('');
  });
});
