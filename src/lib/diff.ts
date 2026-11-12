export type LineDiffRow = { before: string | null; after: string | null; kind: 'same' | 'removed' | 'added' };

/** LCS based line diff that yields aligned rows for side-by-side rendering. */
export function diffLines(beforeText: string, afterText: string): LineDiffRow[] {
  const before = beforeText.split('\n');
  const after = afterText.split('\n');
  if (before.length * after.length > 200_000) return coarseDiff(before, after);
  const rows = before.length + 1;
  const cols = after.length + 1;
  const table = Array.from({ length: rows }, () => new Uint32Array(cols));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const result: LineDiffRow[] = [];
  let i = 0,
    j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      result.push({ before: before[i++], after: after[j++], kind: 'same' });
    } else if (i < before.length && (j === after.length || table[i + 1][j] >= table[i][j + 1])) {
      result.push({ before: before[i++], after: null, kind: 'removed' });
    } else {
      result.push({ before: null, after: after[j++], kind: 'added' });
    }
  }
  return result;
}

function coarseDiff(before: string[], after: string[]): LineDiffRow[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length,
    endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  return [
    ...before.slice(0, start).map((line) => ({ before: line, after: line, kind: 'same' as const })),
    ...before.slice(start, endBefore).map((line) => ({ before: line, after: null, kind: 'removed' as const })),
    ...after.slice(start, endAfter).map((line) => ({ before: null, after: line, kind: 'added' as const })),
    ...before
      .slice(endBefore)
      .map((line, index) => ({ before: line, after: after[endAfter + index] ?? '', kind: 'same' as const })),
  ];
}
