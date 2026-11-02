import { describe, expect, it } from 'vitest';
import { diffLines } from './diff';
import { recordEdit, rejectEdit } from './changes';

describe('diffLines', () => {
  it('aligns changed lines and highlights additions/removals', () => {
    expect(diffLines('one\nold\nthree', 'one\nnew\nthree')).toEqual([
      { before: 'one', after: 'one', kind: 'same' },
      { before: 'old', after: null, kind: 'removed' },
      { before: null, after: 'new', kind: 'added' },
      { before: 'three', after: 'three', kind: 'same' },
    ]);
  });
});

describe('tracked edits', () => {
  it('coalesces typed text and rejects that change without losing surrounding content', () => {
    let changes = recordEdit('left right', 'left X right', 'main.tex', [] , 1);
    changes = recordEdit('left X right', 'left XY right', 'main.tex', changes, 2);
    expect(changes).toHaveLength(1);
    expect(rejectEdit('left XY right', changes[0])).toBe('left right');
  });
  it('leaves unrelated changes untouched and detects stale edits', () => {
    const [change] = recordEdit('alpha', 'beta', 'main.tex', [], 1);
    expect(rejectEdit('changed elsewhere', change)).toBeNull();
  });
});
