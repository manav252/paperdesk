import { describe, expect, it } from 'vitest';
import { applyFilePatch } from './filePatch';

const hash = (content: string, encoding?: string) => `${encoding ?? 'utf8'}:${content}`;
const stored = [{ name: 'main.tex', content: 'A' }, { name: 'intro.tex', content: 'B' }];

describe('saving only changed files', () => {
  it('applies edits made from the stored version and keeps untouched files', () => {
    const result = applyFilePatch(stored, { files: [{ name: 'main.tex', content: 'A2', base: hash('A') }, { name: 'new.tex', content: 'N', base: null }], deleted: ['intro.tex'] }, hash);
    expect(result).toEqual({ conflicts: [], files: [{ name: 'main.tex', content: 'A2' }, { name: 'new.tex', content: 'N' }] });
  });

  it('refuses an edit based on an older version of that file, but not edits to other files', () => {
    const someoneElse = [{ name: 'main.tex', content: 'A' }, { name: 'intro.tex', content: 'B by someone else' }];
    expect(applyFilePatch(someoneElse, { files: [{ name: 'main.tex', content: 'A2', base: hash('A') }] }, hash).conflicts).toEqual([]);
    expect(applyFilePatch(someoneElse, { files: [{ name: 'intro.tex', content: 'B2', base: hash('B') }] }, hash)).toEqual({ conflicts: ['intro.tex'], files: someoneElse });
    expect(applyFilePatch(stored, { files: [{ name: 'main.tex', content: 'X', base: null }] }, hash).conflicts).toEqual(['main.tex']);
  });

  it('treats a retried save of the same content as done', () => {
    expect(applyFilePatch([{ name: 'main.tex', content: 'A2' }], { files: [{ name: 'main.tex', content: 'A2', base: hash('A') }] }, hash).conflicts).toEqual([]);
  });
});
