import crypto from 'node:crypto';
import * as Y from 'yjs';
import { replacedSpan } from '../src/lib/textDiff';

export type CollabFile = { name: string; content?: string; encoding?: string };
const isText = (f: CollabFile) => f.encoding !== 'base64' && !f.name.endsWith('/') && typeof f.content === 'string';
const textKey = (name: string) => `f:${name}`;

/** One open shared project: a Yjs document with a text per file, and the list of file names it manages. */
export class CollabRoom {
  readonly doc = new Y.Doc();
  /** Changes when the server rebuilds the document (restart): clients then start again from the server's copy. */
  readonly epoch = crypto.randomUUID();
  readonly names = this.doc.getMap<boolean>('names');
  members = 0;
  /** Everyone who edited since the last save, for the history entry. */
  readonly authors = new Set<string>();
  dirty = false;
  timer: NodeJS.Timeout | null = null;
  firstDirty = 0;

  constructor(
    readonly key: string,
    readonly owner: string,
    readonly projectId: string,
    files: CollabFile[],
  ) {
    this.doc.transact(() => {
      for (const file of files) if (isText(file)) this.setText(file.name, file.content!);
    }, 'storage');
  }

  text(name: string) {
    return this.doc.getText(textKey(name));
  }
  texts() {
    return new Map([...this.names.keys()].map((name) => [name, this.text(name).toString()]));
  }

  private setText(name: string, content: string) {
    const text = this.text(name);
    const span = replacedSpan(text.toString(), content);
    if (span.remove) text.delete(span.index, span.remove);
    if (span.insert) text.insert(span.index, span.insert);
    if (!this.names.has(name)) this.names.set(name, true);
  }

  /** A save that came through the HTTP API (new, changed or deleted files) is mirrored into the live document. */
  applyExternal(changed: CollabFile[], deleted: string[]) {
    this.doc.transact(() => {
      for (const name of deleted) this.names.delete(name);
      for (const file of changed) {
        if (isText(file)) this.setText(file.name, file.content!);
        else this.names.delete(file.name);
      }
    }, 'storage');
  }
}

type Storage = {
  load(owner: string, projectId: string): Promise<CollabFile[]>;
  /** Writes the changed text files and returns nothing; called a few seconds after edits stop. */
  save(owner: string, projectId: string, texts: Map<string, string>, author: string | null): Promise<void>;
};

const IDLE_MS = 2_500,
  MAX_WAIT_MS = 12_000;

/** Live documents by room key. A room is loaded from storage on first join and saved shortly after edits stop. */
export class CollabRooms {
  private rooms = new Map<string, CollabRoom>();
  private opening = new Map<string, Promise<CollabRoom>>();
  constructor(private storage: Storage) {}

  get(key: string) {
    return this.rooms.get(key);
  }

  async open(key: string, owner: string, projectId: string) {
    const live = this.rooms.get(key);
    if (live) return live;
    let pending = this.opening.get(key);
    if (!pending) {
      pending = this.storage
        .load(owner, projectId)
        .then((files) => {
          const room = new CollabRoom(key, owner, projectId, files);
          room.doc.on('update', (_update: Uint8Array, origin: unknown) => {
            if (origin !== 'storage') this.touch(room);
          });
          this.rooms.set(key, room);
          return room;
        })
        .finally(() => this.opening.delete(key));
      this.opening.set(key, pending);
    }
    return pending;
  }

  private touch(room: CollabRoom) {
    const now = Date.now();
    if (!room.dirty) {
      room.dirty = true;
      room.firstDirty = now;
    }
    if (room.timer) clearTimeout(room.timer);
    room.timer = setTimeout(
      () => void this.flush(room),
      Math.max(0, Math.min(IDLE_MS, room.firstDirty + MAX_WAIT_MS - now)),
    );
  }

  async flush(room: CollabRoom) {
    if (room.timer) {
      clearTimeout(room.timer);
      room.timer = null;
    }
    if (!room.dirty) return;
    room.dirty = false;
    const authors = [...room.authors];
    room.authors.clear();
    try {
      await this.storage.save(room.owner, room.projectId, room.texts(), authors.sort().join(', ') || null);
    } catch (error) {
      room.dirty = true;
      for (const author of authors) room.authors.add(author);
      console.error('Saving a live document failed:', error);
      this.touch(room);
    }
  }

  /** The last person left: save, then drop the room so the next join reloads from storage. */
  async leave(room: CollabRoom) {
    room.members = Math.max(0, room.members - 1);
    if (room.members > 0) return;
    await this.flush(room);
    if (room.members === 0 && !room.dirty && this.rooms.get(room.key) === room) {
      this.rooms.delete(room.key);
      room.doc.destroy();
    }
  }

  async flushAll() {
    await Promise.all([...this.rooms.values()].map((room) => this.flush(room)));
  }
}
