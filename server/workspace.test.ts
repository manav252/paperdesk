import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentHash, syncWorkspace, Workspaces } from './workspace';

const safe = (name: string) => path.posix.normalize(name).replace(/\/$/, '');

describe('warm workspaces', () => {
  it('writes only changed files, removes deleted sources and keeps build products', async () => {
    const spaces = new Workspaces(mkdtempSync(path.join(tmpdir(), 'ws-test-')));
    const ws = await spaces.acquire('owner/p1:pdflatex');
    expect(ws.fresh).toBe(true);
    const first = await syncWorkspace(ws, [
      { name: 'main.tex', content: 'A' },
      { name: 'figures/', content: '' },
      { name: 'figures/a.png', content: Buffer.from([1, 2, 3]).toString('base64'), encoding: 'base64' },
      { name: 'old.tex', content: 'old' },
    ], safe);
    expect(first.written.sort()).toEqual(['figures/', 'figures/a.png', 'main.tex', 'old.tex']);
    expect([...readFileSync(path.join(ws.dir, 'figures/a.png'))]).toEqual([1, 2, 3]);
    writeFileSync(path.join(ws.dir, 'main.aux'), 'aux');

    const again = await spaces.acquire('owner/p1:pdflatex');
    expect(again.fresh).toBe(false);
    const second = await syncWorkspace(again, [
      { name: 'main.tex', content: 'B' },
      { name: 'figures/', content: '' },
      { name: 'figures/a.png', hash: contentHash(Buffer.from([1, 2, 3]).toString('base64'), 'base64'), encoding: 'base64' },
    ], safe);
    expect(second).toEqual({ written: ['main.tex'], removed: ['old.tex'], missing: [] });
    expect(readFileSync(path.join(ws.dir, 'main.tex'), 'utf8')).toBe('B');
    expect(existsSync(path.join(ws.dir, 'old.tex'))).toBe(false);
    expect(existsSync(path.join(ws.dir, 'main.aux'))).toBe(true);
  });

  it('reports files sent by hash that the server does not have', async () => {
    const spaces = new Workspaces(mkdtempSync(path.join(tmpdir(), 'ws-test-')));
    const ws = await spaces.acquire('owner/p2:pdflatex');
    const result = await syncWorkspace(ws, [{ name: 'main.tex', content: 'x' }, { name: 'refs.bib', hash: 'abc' }], safe);
    expect(result.missing).toEqual(['refs.bib']);
    expect(existsSync(path.join(ws.dir, 'main.tex'))).toBe(false);
  });

  it('evicts the least recently used folder beyond its limit', async () => {
    const spaces = new Workspaces(mkdtempSync(path.join(tmpdir(), 'ws-test-')), 2);
    const a = await spaces.acquire('a');
    await new Promise(r => setTimeout(r, 5));
    await spaces.acquire('b');
    await new Promise(r => setTimeout(r, 5));
    await spaces.acquire('c');
    expect(spaces.peek('a')).toBeUndefined();
    expect(existsSync(a.dir)).toBe(false);
    expect(spaces.forProject('').map(ws => ws.key)).toEqual(['c', 'b']);
  });

  it('hashes like the browser does', () => {
    // Same digest as src/lib/compileSync.test.ts expects from the browser implementation.
    expect(contentHash('hello')).toBe('beb815c0698511018243ee6df679c34b');
    expect(contentHash('hello')).not.toBe(contentHash('hello', 'base64'));
  });
});
