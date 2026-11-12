// Warm build folders. Each project keeps its folder between compiles, so latexmk reuses the .aux, .toc and
// .bbl files from the last run and only repeats the passes whose inputs changed. Only files whose content
// changed are rewritten; the browser may send a hash instead of the content for files the server already has.
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type SourceFile = { name: string; content?: string; encoding?: 'base64'; hash?: string };
export type Workspace = {
  key: string;
  dir: string;
  hashes: Map<string, string>;
  lastUsed: number;
  fresh: boolean;
  /** The last compile here; a direct single pass is only tried after one that succeeded. */
  last?: { ok: boolean; mainFile: string };
  /** The precompiled preamble, if one was built for this preamble key. */
  format?: { key: string; ok: boolean };
};
export type SyncResult = { written: string[]; removed: string[]; missing: string[] };

/** Same value the browser computes (src/lib/compileSync.ts): SHA-256 of "<encoding>:<content>", first 32 hex digits. */
export const contentHash = (content: string, encoding?: 'base64') =>
  crypto
    .createHash('sha256')
    .update(`${encoding ?? 'utf8'}:${content}`)
    .digest('hex')
    .slice(0, 32);

const bytesOf = (f: SourceFile) =>
  f.encoding === 'base64' ? Buffer.from(f.content ?? '', 'base64') : Buffer.from(f.content ?? '', 'utf8');

export class Workspaces {
  private readonly items = new Map<string, Workspace>();
  constructor(
    private readonly root = os.tmpdir(),
    private readonly limit = 8,
  ) {}

  /** The folder for a project and engine, created (or reused) and marked as most recently used. */
  async acquire(key: string): Promise<Workspace> {
    let ws = this.items.get(key);
    if (!ws) {
      const dir = path.join(
        this.root,
        `paperdesk-ws-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)}`,
      );
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(dir, { recursive: true, mode: 0o755 });
      ws = { key, dir, hashes: new Map(), lastUsed: Date.now(), fresh: true };
      this.items.set(key, ws);
      await this.evict();
    } else ws.fresh = false;
    ws.lastUsed = Date.now();
    return ws;
  }

  peek(key: string) {
    return this.items.get(key);
  }

  /** Every workspace for a project (one per engine), most recent first. */
  forProject(prefix: string) {
    return [...this.items.values()].filter((ws) => ws.key.startsWith(prefix)).sort((a, b) => b.lastUsed - a.lastUsed);
  }

  async drop(key: string) {
    const ws = this.items.get(key);
    if (!ws) return;
    this.items.delete(key);
    await fs.rm(ws.dir, { recursive: true, force: true }).catch(() => undefined);
  }

  async dropProject(prefix: string) {
    await Promise.all(this.forProject(prefix).map((ws) => this.drop(ws.key)));
  }

  private async evict() {
    const extra = [...this.items.values()]
      .sort((a, b) => a.lastUsed - b.lastUsed)
      .slice(0, Math.max(0, this.items.size - this.limit));
    await Promise.all(extra.map((ws) => this.drop(ws.key)));
  }
}

/**
 * Brings the folder in line with the project: writes new and changed files, deletes source files that were
 * removed or renamed, and leaves build products alone. Files sent without content must already be present
 * with the same hash, otherwise they are reported as missing and nothing is compiled.
 */
export async function syncWorkspace(
  ws: Workspace,
  files: SourceFile[],
  safeName: (name: string) => string,
): Promise<SyncResult> {
  const wanted = new Map<string, SourceFile>();
  for (const f of files) wanted.set(safeName(String(f.name)) + (String(f.name).endsWith('/') ? '/' : ''), f);
  const missing = [...wanted]
    .filter(([name, f]) => !name.endsWith('/') && f.content === undefined && ws.hashes.get(name) !== f.hash)
    .map(([name]) => name);
  if (missing.length) return { written: [], removed: [], missing };

  const removed: string[] = [];
  for (const name of [...ws.hashes.keys()]) {
    if (wanted.has(name)) continue;
    ws.hashes.delete(name);
    removed.push(name);
    await fs.rm(path.join(ws.dir, name), { recursive: true, force: true });
  }
  const written: string[] = [];
  for (const [name, f] of wanted) {
    const target = path.join(ws.dir, name);
    if (name.endsWith('/')) {
      if (!ws.hashes.has(name)) {
        await fs.mkdir(target, { recursive: true });
        ws.hashes.set(name, 'dir');
        written.push(name);
      }
      continue;
    }
    if (f.content === undefined) continue;
    const hash = contentHash(f.content, f.encoding);
    if (ws.hashes.get(name) === hash) continue;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytesOf(f));
    ws.hashes.set(name, hash);
    written.push(name);
  }
  return { written, removed, missing: [] };
}
