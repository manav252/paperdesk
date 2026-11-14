import crypto from 'node:crypto';
import type { Kv } from './kv';

export type ChatMessage = {
  id: string;
  author: string;
  name: string;
  text: string;
  at: number;
  edited?: number;
  deleted?: boolean;
};
export type Person = { id: string; email: string };
export type Notice = {
  id: string;
  kind: 'chat' | 'comment';
  project: string;
  projectId: string;
  from: string;
  text: string;
  at: number;
};

export const MAX_MESSAGE = 2000;
const KEEP_MESSAGES = 300,
  KEEP_NOTICES = 50;

/**
 * Chat and comment text is stored and shown as plain text (never as HTML). This removes control characters,
 * normalises line endings and caps the length.
 */
export function cleanText(input: unknown, max = MAX_MESSAGE) {
  return (
    String(typeof input === 'string' ? input : '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/g, '')
      .replace(/\r\n?/g, '\n')
      .trim()
      .slice(0, max)
  );
}

/** The name typed after “@”: the part of the email address before the at sign. */
export const handleOf = (email: string) =>
  email
    .split('@')[0]!
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '');

/** The people a text mentions with @name, each once. */
export function mentioned<T extends Person>(text: string, people: T[]): T[] {
  const handles = new Set<string>();
  for (const match of text.matchAll(/(?:^|[^\w@])@([a-z0-9._-]+)/gi))
    handles.add(match[1]!.toLowerCase().replace(/[.]+$/, ''));
  return people.filter((p) => p.email && handles.has(handleOf(p.email)));
}

let lastStamp = 0;
/** Ids sort in the order they were made, also within one millisecond. */
const newId = () => {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return `${String(lastStamp).padStart(15, '0')}-${crypto.randomBytes(5).toString('hex')}`;
};

/** Project chat and mention notifications, kept in the small keyed store. */
export class ChatStore {
  constructor(private kv: Kv) {}
  private scope = (room: string) => `chat:${room}`;

  async list(room: string, limit = 200): Promise<ChatMessage[]> {
    const rows = await this.kv.list<ChatMessage>(this.scope(room), { limit, desc: true });
    return rows.reverse().map((r) => r.value);
  }

  async add(room: string, author: { id: string; name: string }, text: string) {
    const message: ChatMessage = { id: newId(), author: author.id, name: author.name, text, at: Date.now() };
    await this.kv.set(this.scope(room), message.id, message);
    const rows = await this.kv.list<ChatMessage>(this.scope(room), { limit: KEEP_MESSAGES + 50, desc: true });
    for (const row of rows.slice(KEEP_MESSAGES)) await this.kv.delete(this.scope(room), row.key);
    return message;
  }

  /** Only the author changes a message; the project owner may also delete one. Null when that is not allowed. */
  async change(room: string, id: string, by: string, change: { text: string } | { deleted: true; any?: boolean }) {
    const row = await this.kv.get<ChatMessage>(this.scope(room), id);
    if (!row || row.value.deleted) return null;
    const own = row.value.author === by;
    if ('text' in change ? !own : !own && !change.any) return null;
    const next: ChatMessage =
      'text' in change
        ? { ...row.value, text: change.text, edited: Date.now() }
        : { ...row.value, text: '', deleted: true };
    await this.kv.set(this.scope(room), id, next);
    return next;
  }

  async clear(room: string) {
    await this.kv.delete(this.scope(room));
  }

  async notify(userId: string, notice: Omit<Notice, 'id' | 'at'>) {
    const full: Notice = { ...notice, id: newId(), at: Date.now() };
    const scope = `notify:${userId}`;
    await this.kv.set(scope, full.id, full);
    const rows = await this.kv.list<Notice>(scope, { limit: KEEP_NOTICES + 50, desc: true });
    for (const row of rows.slice(KEEP_NOTICES)) await this.kv.delete(scope, row.key);
    return full;
  }

  async notices(userId: string) {
    const [rows, read] = await Promise.all([
      this.kv.list<Notice>(`notify:${userId}`, { limit: KEEP_NOTICES, desc: true }),
      this.kv.get<{ at: number }>('notify-read', userId),
    ]);
    const seen = read?.value.at ?? 0;
    const items = rows.map((r) => ({ ...r.value, read: r.value.at <= seen }));
    return { items, unread: items.filter((n) => !n.read).length };
  }

  async markRead(userId: string) {
    await this.kv.set('notify-read', userId, { at: Date.now() });
  }
}
