export type ChatToken =
  | { type: 'text'; text: string }
  | { type: 'mention'; text: string; handle: string }
  | { type: 'file'; text: string; file: string; line: number | null };

const PATTERN = /(^|[^\w@])@([a-z0-9._-]+)|([\w./-]*\w\.[a-z]\w{0,7})(?::(\d{1,6}))?/gi;

/**
 * Splits a chat message or comment into plain text, @mentions of people on the project, and references to project
 * files (`main.tex` or `main.tex:42`). Anything that names no known person or file stays plain text.
 */
export function tokenize(text: string, files: string[], handles: string[]): ChatToken[] {
  const tokens: ChatToken[] = [];
  const push = (part: string) => {
    if (!part) return;
    const last = tokens[tokens.length - 1];
    if (last?.type === 'text') last.text += part;
    else tokens.push({ type: 'text', text: part });
  };
  const known = new Set(handles.map((h) => h.toLowerCase()));
  const resolve = (name: string) => {
    if (files.includes(name)) return name;
    const matches = files.filter((f) => f.endsWith(`/${name}`));
    return matches.length === 1 ? matches[0]! : null;
  };
  let at = 0;
  for (const match of text.matchAll(PATTERN)) {
    const index = match.index ?? 0;
    push(text.slice(at, index));
    at = index + match[0].length;
    if (match[2] !== undefined) {
      const handle = match[2].replace(/\.+$/, '');
      if (!known.has(handle.toLowerCase())) {
        push(match[0]);
        continue;
      }
      push(match[1] ?? '');
      tokens.push({ type: 'mention', text: `@${handle}`, handle: handle.toLowerCase() });
      push(match[2].slice(handle.length));
    } else {
      const file = resolve(match[3]!);
      if (file) tokens.push({ type: 'file', text: match[0], file, line: match[4] ? Number(match[4]) : null });
      else push(match[0]);
    }
  }
  push(text.slice(at));
  return tokens;
}

/** The “@name” being typed just before the caret, if any. */
export function mentionQuery(text: string, caret: number) {
  const match = /(^|[^\w@])@([a-z0-9._-]*)$/i.exec(text.slice(0, caret));
  return match ? { start: caret - match[2]!.length - 1, query: match[2]!.toLowerCase() } : null;
}
