import { describe, expect, it } from 'vitest';
import { compileFiles, contentHash } from './compileSync';

describe('compileFiles', () => {
  it('hashes like the server does', async () => {
    // Same digest as server/workspace.test.ts expects from contentHash() on the server.
    expect(await contentHash('hello')).toBe('beb815c0698511018243ee6df679c34b');
  });

  it('sends everything the first time and only changed files afterwards', async () => {
    const image = { name: 'figures/a.png', content: 'iVBORw0KGgo=', encoding: 'base64' as const };
    const first = await compileFiles(
      'p1',
      [{ name: 'main.tex', content: 'A' }, { name: 'figures/', content: '' }, image],
      null,
    );
    expect(first.files.every((f) => f.content !== undefined)).toBe(true);

    const state = { session: 's', project: 'p1', hashes: first.hashes };
    const second = await compileFiles(
      'p1',
      [{ name: 'main.tex', content: 'B' }, { name: 'figures/', content: '' }, image],
      state,
    );
    expect(second.files.find((f) => f.name === 'main.tex')?.content).toBe('B');
    expect(second.files.find((f) => f.name === 'figures/a.png')).toEqual({
      name: 'figures/a.png',
      hash: first.hashes.get('figures/a.png'),
      encoding: 'base64',
    });
    expect(second.sentBytes).toBe(1);
  });

  it('sends everything for a different project', async () => {
    const first = await compileFiles('p1', [{ name: 'main.tex', content: 'A' }], null);
    const other = await compileFiles('p2', [{ name: 'main.tex', content: 'A' }], {
      session: 's',
      project: 'p1',
      hashes: first.hashes,
    });
    expect(other.files[0].content).toBe('A');
  });
});
