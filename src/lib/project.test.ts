import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  arrayBufferToBase64,
  buildTree,
  decodeBase64Utf8,
  defaultFile,
  isBinary,
  isEditable,
  mergeProjects,
  normalizeFile,
  relative,
  tabFiles,
  type ProjectFile,
} from './project';

const f = (name: string): ProjectFile => ({ name, content: '' });

describe('buildTree', () => {
  it('nests files under folders and sorts folders first', () => {
    const tree = buildTree([f('main.tex'), f('figures/b.png'), f('figures/a.png'), f('appendix/'), f('refs.bib')]);
    expect(tree.map((n) => n.name)).toEqual(['appendix', 'figures', 'main.tex', 'refs.bib']);
    const figures = tree.find((n) => n.name === 'figures')!;
    expect(figures.folder).toBe(true);
    expect(figures.path).toBe('figures/');
    expect(figures.children.map((n) => n.path)).toEqual(['figures/a.png', 'figures/b.png']);
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
    expect(tabFiles(files, 'a.tex').map((x) => x.name)).toEqual(['a.tex', 'b.tex', 'c.tex', 'd.tex', 'e.tex']);
  });

  it('always includes the active file', () => {
    expect(tabFiles(files, 'f.tex').map((x) => x.name)).toEqual(['a.tex', 'b.tex', 'c.tex', 'd.tex', 'f.tex']);
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

describe('normalizeFile', () => {
  it('decodes legacy base64 text from the server and drops the encoding', () => {
    const file = normalizeFile(
      { name: 'main.tex', content: Buffer.from('\\section{Hi}').toString('base64'), encoding: 'base64' },
      'server',
    );
    expect(file).toEqual({ name: 'main.tex', content: '\\section{Hi}' });
  });

  it('repairs stored text that an older client tagged as base64 after decoding it', () => {
    expect(normalizeFile({ name: 'main.tex', content: '\\section{Hi}', encoding: 'base64' }, 'storage')).toEqual({
      name: 'main.tex',
      content: '\\section{Hi}',
    });
  });

  it('keeps binary files as base64', () => {
    const png = { name: 'fig/a.png', content: 'iVBORw0KGgo=', encoding: 'base64' as const };
    expect(normalizeFile(png, 'server')).toEqual(png);
  });

  it('clears binary content that was never base64 (corrupted text read)', () => {
    expect(normalizeFile({ name: 'a.png', content: '�PNG' }, 'storage').content).toBe('');
  });
});

describe('mergeProjects', () => {
  const p = (id: string, modified: number) => ({ id, name: id, modified, files: [] });

  it('keeps the newer copy and uploads local projects the server lacks or has older', () => {
    const { merged, upload } = mergeProjects(
      [p('a', 5), p('b', 1), p('local', 3)],
      [p('a', 2), p('b', 9), p('remote', 4)],
    );
    expect(merged.map((x) => `${x.id}@${x.modified}`)).toEqual(['a@5', 'b@9', 'local@3', 'remote@4']);
    expect(upload.map((x) => x.id)).toEqual(['a', 'local']);
  });
});

describe('arrayBufferToBase64', () => {
  it('matches Node base64 for binary data', () => {
    const bytes = Uint8Array.from({ length: 70000 }, (_, i) => (i * 31) % 256);
    expect(arrayBufferToBase64(bytes.buffer)).toBe(Buffer.from(bytes).toString('base64'));
  });
});

describe('non-UTF-8 text files', () => {
  const latin1 = Buffer.from([0x25, 0x20, 0x93, 0x71, 0x94, 0x0a]).toString('base64'); // % “q” in Windows-1252

  it('keeps text that is not valid UTF-8 as base64 so it round-trips', () => {
    const f = normalizeFile({ name: 'style.bst', content: latin1, encoding: 'base64' }, 'server');
    expect(f).toEqual({ name: 'style.bst', content: latin1, encoding: 'base64' });
    expect(isEditable(f)).toBe(false);
  });

  it('keeps genuine base64 from browser storage', () => {
    expect(normalizeFile({ name: 'style.bst', content: latin1, encoding: 'base64' }, 'storage').encoding).toBe(
      'base64',
    );
  });
});

describe('defaultFile', () => {
  it('prefers main.tex over files that sort earlier', () => {
    expect(
      defaultFile([
        f('figures/'),
        { name: 'figures/a.png', content: 'x', encoding: 'base64' },
        f('intro.tex'),
        f('main.tex'),
      ]),
    ).toBe('main.tex');
  });

  it('falls back to the first .tex, then the first editable file', () => {
    expect(defaultFile([f('a.bib'), f('paper.tex')])).toBe('paper.tex');
    expect(defaultFile([{ name: 'a.png', content: 'x', encoding: 'base64' }, f('notes.txt')])).toBe('notes.txt');
  });
});
