import { describe, expect, it } from 'vitest';
import { blobSha, defaultGitignore, ignoreMatcher, planPull, planPush, seal, toStored, unseal } from './github';

describe('stored GitHub tokens', () => {
  it('are encrypted, and only open with the same key', () => {
    const sealed = seal('gho_secret', 'key-one');
    expect(sealed).not.toContain('gho_secret');
    expect(seal('gho_secret', 'key-one')).not.toBe(sealed);
    expect(unseal(sealed, 'key-one')).toBe('gho_secret');
    expect(unseal(sealed, 'key-two')).toBeNull();
    expect(unseal(`${sealed.slice(0, -2)}AA`, 'key-one')).toBeNull();
    expect(unseal('nonsense', 'key-one')).toBeNull();
  });
});

describe('what is left out of a sync', () => {
  it('skips build files, compiled PDFs and the project’s own ignore rules', () => {
    const paths = ['main.tex', 'chapters/one.tex', 'figures/plot.pdf', 'main.pdf'];
    const ignored = ignoreMatcher(paths, '# notes\nscratch/\n*.bak\n/todo.txt\n!keep.bak\n');
    for (const path of [
      'main.aux',
      'main.log',
      'chapters/one.aux',
      'main.synctex.gz',
      'main.fdb_latexmk',
      'main.pdf',
      'chapters/one.pdf',
      'scratch/a.tex',
      'deep/scratch/b.tex',
      'old.bak',
      'todo.txt',
      '.DS_Store',
    ])
      expect(ignored(path), path).toBe(true);
    for (const path of ['main.tex', 'figures/plot.pdf', 'refs.bib', 'notes/todo.txt', 'catalog.tex', '.gitignore'])
      expect(ignored(path), path).toBe(false);
  });
  it('writes a default .gitignore naming the compiled document', () => {
    expect(defaultGitignore('paper.tex')).toContain('*.aux');
    expect(defaultGitignore('paper.tex')).toContain('/paper.pdf');
    expect(defaultGitignore()).not.toContain('.pdf');
  });
});

describe('comparing a project with its repository', () => {
  it('gives files the same ids git does', () => {
    expect(blobSha(Buffer.from(''))).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    expect(blobSha(Buffer.from('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });
  it('pulls only what GitHub changed and reports files changed on both sides', () => {
    const base = { same: '1', theirs: '1', mine: '1', both: '1', gone: '1', agreed: '1', mineGone: '1' };
    const local = { same: '1', theirs: '1', mine: '2', both: '2', gone: '1', agreed: '3', localNew: '9' };
    const remote = { same: '1', theirs: '2', mine: '1', both: '3', agreed: '3', remoteNew: '8', mineGone: '2' };
    expect(planPull(base, local, remote)).toEqual({
      take: ['remoteNew', 'theirs'],
      remove: ['gone'],
      conflicts: ['both', 'mineGone'],
    });
    // Never synced before: the same path with different contents on both sides is a conflict, not an overwrite.
    expect(planPull({}, { a: '1', b: '1' }, { a: '2', b: '1', c: '1' })).toEqual({
      take: ['c'],
      remove: [],
      conflicts: ['a'],
    });
  });
  it('lists what a push would add, change and delete', () => {
    expect(planPush({ a: '1', b: '2', c: '3' }, { a: '1', b: '1', d: '4' })).toEqual([
      { path: 'b', status: 'modified' },
      { path: 'c', status: 'added' },
      { path: 'd', status: 'deleted' },
    ]);
    expect(planPush({ a: '1' }, { a: '1' })).toEqual([]);
  });
  it('stores pulled files as text unless they are binary', () => {
    expect(toStored('a.tex', Buffer.from('héllo'))).toEqual({ name: 'a.tex', content: 'héllo' });
    expect(toStored('a.png', Buffer.from([0x89, 0x50, 0x00, 0xff]))).toMatchObject({ encoding: 'base64' });
  });
});
