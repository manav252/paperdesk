// Browser-side helpers for the assistant: what context to send, how to read the streamed answer,
// and how a suggested fix maps onto a file.
import type { LogEntry } from './latexLog';

/** Matches the server's limits in server/assistant.ts. */
export const SEND_LIMITS = { messages: 20, messageChars: 8_000, fileChars: 60_000, selectionChars: 8_000, logChars: 8_000, entries: 30 };

export type ChatMessage = { role: 'user' | 'assistant'; content: string };
export type LineFix = { file: string; start: number; end: number; replacement: string; original: string[] };
export type Segment = { type: 'text'; text: string } | { type: 'code'; lang: string; code: string; open: boolean; lines?: { start: number; end: number } };
export type Inline = { type: 'text' | 'code' | 'bold'; text: string };

const lines = (text: string) => text.split(/\r?\n/);

/**
 * The file as numbered lines ("12| text"). Large files are cut to a window around `focus`
 * so the request stays under the server's size limit.
 */
export function numberedFile(text: string, focus = 1, maxChars = SEND_LIMITS.fileChars - 200) {
  const all = lines(text);
  const width = String(all.length).length;
  const fmt = (l: string, i: number) => `${String(i + 1).padStart(width)}| ${l}`;
  const whole = all.map(fmt).join('\n');
  if (whole.length <= maxChars) return { content: whole, start: 1, end: all.length, partial: false };
  let start = Math.max(1, Math.min(focus, all.length)), end = start, size = fmt(all[start - 1], start - 1).length;
  // Grow the window around the focus line, alternating sides, until the budget runs out.
  for (let grew = true; grew;) {
    grew = false;
    for (const side of ['after', 'before'] as const) {
      const i = side === 'after' ? end : start - 2;
      if (i < 0 || i >= all.length) continue;
      const add = fmt(all[i], i).length + 1;
      if (size + add > maxChars) continue;
      size += add; grew = true;
      if (side === 'after') end++; else start--;
    }
  }
  return { content: all.slice(start - 1, end).map((l, i) => fmt(l, start - 1 + i)).join('\n'), start, end, partial: true };
}

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);
const tail = (s: string, max: number) => (s.length > max ? s.slice(-max) : s);

export function logContext(result: { success: boolean | null; errors: LogEntry[]; warnings: LogEntry[]; log: string } | null) {
  if (!result) return undefined;
  const trim = (e: LogEntry) => ({ file: e.file, line: e.line, message: clip(e.message, 500) });
  return { success: result.success, errors: result.errors.slice(0, SEND_LIMITS.entries).map(trim), warnings: result.warnings.slice(0, SEND_LIMITS.entries).map(trim), tail: tail(result.log, 3_000) };
}

export const clipSelection = (s: string) => clip(s, SEND_LIMITS.selectionChars);
/** Keeps the newest turns that fit the server's limit, starting with a question. */
export function recentMessages(messages: ChatMessage[]) {
  const recent = messages.slice(-SEND_LIMITS.messages).map(m => ({ ...m, content: clip(m.content, SEND_LIMITS.messageChars) }));
  while (recent.length && recent[0].role !== 'user') recent.shift();
  return recent;
}

const FENCE = /^```([^\n`]*)\n?/m;
const REPLACE = /^latex\s+replace-lines\s+(\d+)\s*-\s*(\d+)\s*$/i;

/** Splits an answer (possibly still streaming) into text and fenced code blocks. */
export function parseAnswer(text: string): Segment[] {
  const out: Segment[] = [];
  let rest = text;
  while (rest) {
    const m = FENCE.exec(rest);
    if (!m) { out.push({ type: 'text', text: rest }); break; }
    if (m.index) out.push({ type: 'text', text: rest.slice(0, m.index) });
    const body = rest.slice(m.index + m[0].length);
    const close = /^```[ \t]*$/m.exec(body);
    const info = m[1].trim();
    const range = REPLACE.exec(info);
    const code = (close ? body.slice(0, close.index) : body).replace(/\n$/, '');
    out.push({ type: 'code', lang: range ? 'latex' : info.split(/\s+/)[0] || 'text', code, open: !close, ...(range ? { lines: { start: Number(range[1]), end: Number(range[2]) } } : {}) });
    rest = close ? body.slice(close.index + close[0].length).replace(/^\n/, '') : '';
  }
  return out.filter(s => s.type === 'code' || s.text.trim());
}

/** The suggested line replacement in a finished answer, checked against the file the assistant was shown. */
export function findFix(answer: string, file: string, shown: string): LineFix | null {
  const block = parseAnswer(answer).find((s): s is Extract<Segment, { type: 'code' }> => s.type === 'code' && !!s.lines && !s.open);
  if (!block?.lines) return null;
  const all = lines(shown);
  const { start, end } = block.lines;
  if (start < 1 || end < start || end > all.length) return null;
  return { file, start, end, replacement: block.code, original: all.slice(start - 1, end) };
}

/** True when the lines the fix replaces still read the same as when the assistant saw them. */
export const fixStillApplies = (content: string, fix: LineFix) => lines(content).slice(fix.start - 1, fix.end).join('\n') === fix.original.join('\n');

export function applyFix(content: string, fix: LineFix) {
  const all = lines(content);
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  return [...all.slice(0, fix.start - 1), ...lines(fix.replacement), ...all.slice(fix.end)].join(eol);
}

/** Inline markdown the assistant uses in prose: `code` and **bold**. */
export function inlineTokens(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
  let last = 0;
  for (let m; (m = re.exec(text));) {
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
    out.push(m[1] !== undefined ? { type: 'code', text: m[1] } : { type: 'bold', text: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

export type StreamEvent = { type: 'text'; text: string } | { type: 'done'; stopReason: string | null } | { type: 'error'; error: string };

/** Reads the assistant's NDJSON stream, calling `onEvent` for each line. */
export async function readEvents(body: ReadableStream<Uint8Array>, onEvent: (e: StreamEvent) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const flush = (line: string) => { if (line.trim()) onEvent(JSON.parse(line)); };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    parts.forEach(flush);
  }
  flush(buffer + decoder.decode());
}
