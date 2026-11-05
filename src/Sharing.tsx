import { useEffect, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { Copy, Trash2 } from 'lucide-react';
import { setupMonaco } from './monacoSetup';
import { currentAccessToken } from './lib/auth';

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const JOIN_KEY = 'paperdesk-pending-join';

// An invite link (?join=token) survives the sign-in redirect in browser storage.
try {
  const url = new URL(location.href), token = url.searchParams.get('join');
  if (token) { localStorage.setItem(JOIN_KEY, token); url.searchParams.delete('join'); history.replaceState(history.state, '', url.pathname + url.search + url.hash); }
} catch { /* no storage: the link can be opened again after signing in */ }
export const pendingJoin = () => { try { return localStorage.getItem(JOIN_KEY); } catch { return null; } };
export const clearPendingJoin = () => { try { localStorage.removeItem(JOIN_KEY); } catch { /* nothing kept */ } };

type Access = { members: { userId: string; email: string | null; role: string }[]; invites: { token: string; email: string | null; role: string }[] };
const joinUrl = (token: string) => `${location.origin}${location.pathname}?join=${token}`;

/** Owner’s panel: invite people by email, share links with a set role, change or remove access. */
export function ShareAccess({ projectId, apiFetch, copy }: { projectId: string; apiFetch: Fetcher; copy: (text: string, message: string) => void }) {
  const [access, setAccess] = useState<Access | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('editor');
  const [error, setError] = useState('');
  const base = `/api/projects/${projectId}`;
  const call = async (path: string, init?: RequestInit) => {
    setError('');
    const response = await apiFetch(base + path, init);
    if (!response.ok) { setError((await response.json().catch(() => ({}))).error ?? 'That didn’t work. Please try again.'); return null; }
    return response;
  };
  const refresh = async () => { const r = await call('/members'); if (r) setAccess(await r.json()); };
  useEffect(() => { if (currentAccessToken()) void refresh(); }, [projectId]);
  const invite = async (body: object) => { const r = await call('/invites', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }); if (r) await refresh(); return !!r; };
  if (!currentAccessToken()) return <p className="dialog-message">Sign in to invite people to edit or view this project.</p>;
  const links = access?.invites.filter(i => !i.email) ?? [], pending = access?.invites.filter(i => i.email) ?? [];
  return <section className="share-access" aria-label="People with access">
    <h4>Invite people</h4>
    <form className="share-row" onSubmit={e => { e.preventDefault(); void invite({ email, role }).then(ok => { if (ok) setEmail(''); }); }}>
      <input className="text-input" type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="name@university.edu" aria-label="Email to invite" />
      <select className="select" value={role} onChange={e => setRole(e.target.value)} aria-label="Invite role"><option value="editor">Can edit</option><option value="viewer">Can view</option></select>
      <button className="btn btn-primary btn-sm" type="submit">Create invite</button>
    </form>
    {error && <div className="inline-alert error" role="alert"><span>{error}</span></div>}
    {pending.map(i => <div className="share-person" key={i.token}><div><strong>{i.email}</strong><span>Invited, {i.role === 'editor' ? 'can edit' : 'can view'}. Send them this link.</span></div>
      <button className="btn btn-secondary btn-sm" onClick={() => copy(joinUrl(i.token), 'Invite link copied')}><Copy size={13} /> Copy link</button>
      <button className="icon-btn sm" aria-label={`Cancel invite for ${i.email}`} onClick={() => void call(`/invites/${i.token}`, { method: 'DELETE' }).then(refresh)}><Trash2 size={14} /></button></div>)}
    {access?.members.map(m => <div className="share-person" key={m.userId}><div><strong>{m.email ?? 'Member'}</strong></div>
      <select className="select" aria-label={`Role of ${m.email ?? 'member'}`} value={m.role} onChange={e => void call(`/members/${m.userId}`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ role: e.target.value }) }).then(refresh)}><option value="editor">Can edit</option><option value="viewer">Can view</option></select>
      <button className="icon-btn sm" aria-label={`Remove ${m.email ?? 'member'}`} onClick={() => void call(`/members/${m.userId}`, { method: 'DELETE' }).then(refresh)}><Trash2 size={14} /></button></div>)}
    <h4>Share with a link</h4>
    <p className="muted">Anyone who signs in with a link joins with that role, until you turn the link off.</p>
    {(['editor', 'viewer'] as const).map(r => { const link = links.find(l => l.role === r); return <div className="share-person" key={r}><div><strong>{r === 'editor' ? 'Edit link' : 'View link'}</strong></div>
      {link ? <><button className="btn btn-secondary btn-sm" onClick={() => copy(joinUrl(link.token), 'Link copied')}><Copy size={13} /> Copy link</button><button className="btn btn-secondary btn-sm" onClick={() => void call(`/invites/${link.token}`, { method: 'DELETE' }).then(refresh)}>Turn off</button></>
        : <button className="btn btn-secondary btn-sm" onClick={() => void invite({ role: r })}>Create link</button>}</div>; })}
  </section>;
}

type Version = { id: string; file: string; author: string | null; name: string | null; created: number };
const CURRENT = 'current';
const label = (v: Version) => `${new Date(v.created).toLocaleString()}${v.author ? ` · ${v.author}` : ''}${v.name ? ` · ${v.name}` : ''}`;

/** Per-file history: a line-by-line diff of any two versions, naming a version, and restoring one file. */
export function HistoryPanel({ projectId, files, initialFile, canEdit, dark, apiFetch, onRestored }: { projectId: string; files: { name: string; content: string; encoding?: string }[]; initialFile: string; canEdit: boolean; dark: boolean; apiFetch: Fetcher; onRestored: (file: string, content: string, modified: number) => void }) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [error, setError] = useState('');
  const [file, setFile] = useState(initialFile);
  const [left, setLeft] = useState('');
  const [right, setRight] = useState(CURRENT);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [name, setName] = useState('');
  const base = `/api/projects/${projectId}/history`;
  const load = async () => {
    const r = await apiFetch(base);
    if (r.ok) setVersions((await r.json()).versions); else setError('The history could not be loaded.');
  };
  useEffect(() => { void load(); }, [projectId]);
  const forFile = (versions ?? []).filter(v => v.file === file);
  const fileNames = [...new Set([...files.filter(f => f.encoding !== 'base64' && !f.name.endsWith('/')).map(f => f.name), ...(versions ?? []).map(v => v.file)])];
  // Default comparison: the newest saved version against the text in the editor.
  useEffect(() => { setLeft(forFile[0]?.id ?? ''); setRight(CURRENT); setName(''); }, [file, versions === null]);
  useEffect(() => {
    for (const id of [left, right]) if (id && id !== CURRENT && texts[id] === undefined) {
      void apiFetch(`${base}/${id}`).then(r => r.ok ? r.json() : Promise.reject(new Error())).then(v => setTexts(t => ({ ...t, [id]: v.content })), () => setError('That version could not be loaded.'));
    }
  }, [left, right]);
  const text = (id: string) => id === CURRENT ? files.find(f => f.name === file)?.content ?? '' : texts[id] ?? '';
  const save = async () => {
    const r = await apiFetch(`${base}/${left}`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ name }) });
    if (r.ok) { setName(''); await load(); } else setError('The name could not be saved.');
  };
  const restore = async () => {
    const r = await apiFetch(`${base}/${left}/restore`, { method: 'POST' });
    if (!r.ok) { setError((await r.json().catch(() => ({}))).error ?? 'The file could not be restored.'); return; }
    const data = await r.json();
    onRestored(data.file, data.content, data.modified);
    await load();
  };
  const options = (withCurrent: boolean) => <>{withCurrent && <option value={CURRENT}>Current text</option>}{forFile.map(v => <option key={v.id} value={v.id}>{label(v)}</option>)}</>;
  if (versions === null && !error) return <p className="muted" role="status">Loading history…</p>;
  return <div className="history-panel">
    {error && <div className="inline-alert error" role="alert"><span>{error}</span></div>}
    <div className="history-controls">
      <label>File<select className="select" value={file} onChange={e => setFile(e.target.value)} aria-label="History file">{fileNames.map(f => <option key={f}>{f}</option>)}</select></label>
      <label>Compare<select className="select" value={left} onChange={e => setLeft(e.target.value)} aria-label="Older version">{options(false)}</select></label>
      <label>with<select className="select" value={right} onChange={e => setRight(e.target.value)} aria-label="Newer version">{options(true)}</select></label>
    </div>
    {forFile.length === 0 ? <p className="muted">No saved versions of {file} yet. Versions are saved as you edit.</p> : <>
      <div className="history-diff" data-testid="history-diff"><DiffEditor height="100%" language={file.endsWith('.bib') ? 'bibtex' : 'latex'} theme={dark ? 'paperdesk-dark' : 'paperdesk-light'} beforeMount={setupMonaco} original={text(left)} modified={text(right)} options={{ readOnly: true, originalEditable: false, minimap: { enabled: false }, automaticLayout: true, scrollBeyondLastLine: false, fontSize: 13 }} /></div>
      {canEdit && <div className="history-actions">
        <input className="text-input" value={name} onChange={e => setName(e.target.value)} placeholder="Name this version (optional)" aria-label="Version name" />
        <button className="btn btn-secondary btn-sm" disabled={!name.trim() || !left} onClick={() => void save()}>Save name</button>
        <button className="btn btn-primary btn-sm" disabled={!left} onClick={() => void restore()}>Restore this file to the older version</button>
      </div>}
    </>}
  </div>;
}
