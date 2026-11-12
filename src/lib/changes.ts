export type TrackedChange = {
  id: string;
  file: string;
  start: number;
  line: number;
  beforeText: string;
  afterText: string;
  leftContext: string;
  rightContext: string;
  created: number;
};

/** Turn an editor update into a small patch and coalesce continued typing at the same location. */
export function recordEdit(previous: string, next: string, file: string, changes: TrackedChange[], now = Date.now()) {
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  let suffix = 0;
  while (
    suffix < previous.length - start &&
    suffix < next.length - start &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  )
    suffix++;
  const oldEnd = previous.length - suffix;
  const beforeText = previous.slice(start, oldEnd);
  const afterText = next.slice(start, next.length - suffix);
  const existing = [...changes]
    .reverse()
    .find(
      (change) =>
        change.file === file &&
        start >= change.start &&
        start <= change.start + change.afterText.length &&
        previous.slice(change.start, change.start + change.afterText.length) === change.afterText,
    );
  if (existing) {
    const from = start - existing.start;
    const to = Math.max(from, Math.min(existing.afterText.length, oldEnd - existing.start));
    const replacement = existing.afterText.slice(0, from) + afterText + existing.afterText.slice(to);
    const updated = changes.filter((change) => change.id !== existing.id);
    if (replacement === existing.beforeText) return updated;
    return [...updated, { ...existing, afterText: replacement }];
  }
  if (beforeText === afterText) return changes;
  return [
    ...changes,
    {
      id: crypto.randomUUID(),
      file,
      start,
      line: previous.slice(0, start).split('\n').length,
      beforeText,
      afterText,
      leftContext: previous.slice(Math.max(0, start - 40), start),
      rightContext: previous.slice(oldEnd, oldEnd + 40),
      created: now,
    },
  ];
}

/** Revert one tracked patch if its exact surrounding context is still present. */
export function rejectEdit(content: string, change: TrackedChange): string | null {
  const target = change.leftContext + change.afterText + change.rightContext;
  const at = content.indexOf(target);
  if (at < 0 || content.indexOf(target, at + Math.max(1, target.length)) >= 0) return null;
  const from = at + change.leftContext.length;
  return content.slice(0, from) + change.beforeText + content.slice(from + change.afterText.length);
}
