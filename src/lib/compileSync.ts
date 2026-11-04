// Sends only the files that changed since the last compile. The server keeps a warm build folder per project and
// knows each file by hash (server/workspace.ts); unchanged files go as a hash, so recompiling after typing a word
// uploads one small .tex file instead of every figure.
import type { ProjectFile } from './project';

export type SyncState = { session: string; project: string; hashes: Map<string, string> };
export type CompileFile = { name: string; hash?: string; encoding?: 'base64'; content?: string };

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
const cache = new WeakMap<ProjectFile, string>();

/** SHA-256 of "<encoding>:<content>", first 32 hex digits; matches contentHash() on the server. */
export async function contentHash(content: string, encoding?: 'base64') {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${encoding ?? 'utf8'}:${content}`))).slice(0, 32);
}

/** File objects are replaced on every edit, so a hash computed once per object stays valid. */
export async function fileHash(f: ProjectFile) {
  let h = cache.get(f);
  if (!h) { h = await contentHash(f.content, f.encoding); cache.set(f, h); }
  return h;
}

/** The files to send: everything when `state` doesn't match this project and server session, otherwise changes only. */
export async function compileFiles(project: string, files: ProjectFile[], state: SyncState | null) {
  const known = state && state.project === project ? state.hashes : null;
  const hashes = new Map<string, string>();
  const out: CompileFile[] = [];
  for (const f of files) {
    if (f.name.endsWith('/')) { out.push({ name: f.name, content: '' }); continue; }
    const hash = await fileHash(f);
    hashes.set(f.name, hash);
    const encoding = f.encoding === 'base64' ? 'base64' as const : undefined;
    out.push(known?.get(f.name) === hash ? { name: f.name, hash, encoding } : { name: f.name, hash, encoding, content: f.content });
  }
  const sentBytes = out.reduce((n, f) => n + (f.content?.length ?? 0), 0);
  return { files: out, hashes, sentBytes };
}

export function base64ToBytes(b64: string) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
