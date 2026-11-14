import { useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Github, RefreshCw } from 'lucide-react';
import { diffLines } from './lib/diff';

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
type Status = { configured: boolean; connected: boolean; login?: string };
type Link = { repo: string; branch: string; url: string; synced?: number };
type PushChange = { path: string; status: 'added' | 'modified' | 'deleted'; before?: string; after?: string };
type Conflict = { path: string; mine?: string; theirs?: string; mineGone: boolean; theirsGone: boolean };
type Changes = {
  behind: boolean;
  push: PushChange[];
  pull: { take: string[]; remove: string[]; conflicts: Conflict[] };
};
const json = { 'Content-Type': 'application/json' };
const off: Status = { configured: false, connected: false };

/** Set when GitHub sent the browser back here after connecting: 'connected' or 'failed'. Read once, then cleared. */
export const githubReturn = { value: '' };
try {
  const params = new URLSearchParams(location.search);
  const result = params.get('github');
  if (result) {
    githubReturn.value = result;
    params.delete('github');
    const query = params.toString();
    history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  }
} catch {
  /* no address to read */
}

const slug = (name: string) =>
  name
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'paper';

/** Revokes PaperDesk's access to the person's GitHub account. Shown in the sync dialog and in Settings. */
export function GitHubAccount({
  apiFetch,
  notify,
  onChange,
}: {
  apiFetch: Fetcher;
  notify: (text: string) => void;
  onChange?: () => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () =>
    apiFetch('/api/github')
      .then(async (r) => setStatus(r.ok ? ((await r.json()) as Status) : off))
      .catch(() => setStatus(off));
  useEffect(() => void load(), []);
  if (!status) return <span className="muted">Checking…</span>;
  if (!status.configured) return <span className="muted">GitHub sync not configured</span>;
  if (!status.connected) return <span className="muted">Not connected</span>;
  return (
    <button
      className="btn btn-secondary btn-sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const r = await apiFetch('/api/github', { method: 'DELETE' }).catch(() => null);
        setBusy(false);
        if (!r?.ok) return notify('GitHub could not be disconnected. Try again.');
        notify('GitHub disconnected. PaperDesk’s access was revoked.');
        await load();
        onChange?.();
      }}
    >
      Disconnect {status.login ? `@${status.login}` : 'GitHub'}
    </button>
  );
}

function FileDiff({ change }: { change: PushChange }) {
  if (change.status === 'deleted') return <p className="muted">This file will be deleted on GitHub.</p>;
  if (change.after === undefined) return <p className="muted">No preview (a binary or very large file).</p>;
  const rows = diffLines(change.before ?? '', change.after).filter((row) => row.kind !== 'same');
  return (
    <pre className="sync-diff" aria-label={`Changes in ${change.path}`}>
      {rows.slice(0, 200).map((row, i) => (
        <span key={i} className={row.kind === 'added' ? 'diff-added' : 'diff-removed'}>
          {row.kind === 'added' ? '+ ' : '- '}
          {row.kind === 'added' ? row.after : row.before}
          {'\n'}
        </span>
      ))}
      {rows.length > 200 && <span className="muted">…and {rows.length - 200} more changed lines</span>}
    </pre>
  );
}

export function GitHubSync({
  projectId,
  projectName,
  apiFetch,
  signedIn,
  canEdit,
  notify,
  settle,
  onPulled,
}: {
  projectId: string;
  projectName: string;
  apiFetch: Fetcher;
  signedIn: boolean;
  canEdit: boolean;
  notify: (text: string) => void;
  /** Resolves once the latest edits have been saved to the server. */
  settle: () => Promise<unknown>;
  onPulled: () => Promise<unknown>;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [link, setLink] = useState<Link | null | undefined>(undefined);
  const [repos, setRepos] = useState<{ name: string; private: boolean }[]>([]);
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [name, setName] = useState(slug(projectName));
  const [isPrivate, setIsPrivate] = useState(true);
  const [chosen, setChosen] = useState('');
  const [changes, setChanges] = useState<Changes | null>(null);
  const [message, setMessage] = useState('');
  const [open, setOpen] = useState('');
  const [choices, setChoices] = useState<Record<string, 'mine' | 'theirs'>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const base = `/api/projects/${projectId}/github`;

  const call = async (label: string, path: string, init?: RequestInit) => {
    setBusy(label);
    setError('');
    try {
      const r = await apiFetch(path, init);
      const body = r.status === 204 ? {} : ((await r.json().catch(() => ({}))) as Record<string, any>);
      if (!r.ok) setError(String(body.error ?? 'GitHub sync failed. Try again.'));
      return r.ok ? body : null;
    } catch {
      setError('The PaperDesk server isn’t reachable. Try again in a moment.');
      return null;
    } finally {
      setBusy('');
    }
  };
  const loadChanges = async () => {
    setChanges(null);
    await settle();
    const body = await call('changes', `${base}/changes`);
    if (body) setChanges(body as Changes);
  };
  const loadStatus = async () => {
    const body = (await call('status', '/api/github')) as Status | null;
    setStatus(body ?? { configured: false, connected: false });
    if (!body?.configured) return;
    const linked = await call('status', base);
    setLink((linked?.link as Link | null) ?? null);
    if (!body.connected) return;
    if (linked?.link) void loadChanges();
    else {
      const list = await call('status', '/api/github/repos');
      if (Array.isArray(list)) setRepos(list);
    }
  };
  useEffect(() => void loadStatus(), [projectId]);

  if (!status) return <p className="muted sync-body">Checking GitHub…</p>;
  if (!status.configured)
    return (
      <div className="sync-body">
        <p>
          <strong>GitHub sync not configured</strong>
        </p>
        <p className="muted">
          This PaperDesk server has no GitHub app set up, so projects cannot be pushed to or pulled from GitHub.
        </p>
      </div>
    );
  if (!signedIn) return <p className="sync-body">Sign in to PaperDesk to connect your GitHub account.</p>;
  if (!status.connected)
    return (
      <div className="sync-body">
        <p>
          Connect your GitHub account to push this project to a repository and pull changes back. Commits are made as
          you.
        </p>
        {error && (
          <p className="chat-error" role="alert">
            {error}
          </p>
        )}
        <button
          className="btn btn-primary"
          disabled={!!busy}
          onClick={async () => {
            const body = await call('connect', '/api/github/connect', {
              method: 'POST',
              headers: json,
              body: JSON.stringify({ back: location.hash }),
            });
            if (body?.url) location.href = String(body.url);
          }}
        >
          <Github size={15} /> Connect GitHub
        </button>
      </div>
    );

  const account = (
    <div className="field-row sync-account">
      <div>
        <strong>GitHub account</strong>
        <span>Connected as @{status.login}. Disconnecting revokes PaperDesk’s access.</span>
      </div>
      <GitHubAccount apiFetch={apiFetch} notify={notify} onChange={() => void loadStatus()} />
    </div>
  );

  if (!link)
    return (
      <div className="sync-body">
        <h4>Link to GitHub repo</h4>
        {!canEdit ? (
          <p className="muted">Only people who can edit this project can link it to a repository.</p>
        ) : (
          <>
            <div className="segmented" role="radiogroup" aria-label="Repository">
              <button
                role="radio"
                aria-checked={mode === 'new'}
                className={mode === 'new' ? 'on' : ''}
                onClick={() => setMode('new')}
              >
                Create a new repo
              </button>
              <button
                role="radio"
                aria-checked={mode === 'existing'}
                className={mode === 'existing' ? 'on' : ''}
                onClick={() => setMode('existing')}
              >
                Use an existing repo
              </button>
            </div>
            {mode === 'new' ? (
              <div className="sync-form">
                <label>
                  Repository name
                  <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
                </label>
                <label className="check">
                  <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} /> Private
                </label>
              </div>
            ) : (
              <div className="sync-form">
                <label>
                  Repository
                  <select value={chosen} onChange={(e) => setChosen(e.target.value)}>
                    <option value="">Choose a repository…</option>
                    {repos.map((r) => (
                      <option key={r.name} value={r.name}>
                        {r.name}
                        {r.private ? ' (private)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            {error && (
              <p className="chat-error" role="alert">
                {error}
              </p>
            )}
            <button
              className="btn btn-primary"
              disabled={!!busy || (mode === 'new' ? !name.trim() : !chosen)}
              onClick={async () => {
                const body = await call('link', `${base}/link`, {
                  method: 'POST',
                  headers: json,
                  body: JSON.stringify(
                    mode === 'new' ? { create: { name: name.trim(), private: isPrivate } } : { repo: chosen },
                  ),
                });
                if (!body?.link) return;
                setLink(body.link as Link);
                void loadChanges();
              }}
            >
              {busy === 'link' ? 'Linking…' : 'Link repository'}
            </button>
          </>
        )}
        {account}
      </div>
    );

  const conflicts = changes?.pull.conflicts ?? [];
  const incoming = changes ? changes.pull.take.length + changes.pull.remove.length + conflicts.length : 0;
  const unresolved = conflicts.filter((c) => !choices[c.path]).length;
  const pull = async () => {
    const body = await call('pull', `${base}/pull`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ resolutions: choices }),
    });
    if (!body) return;
    await onPulled();
    setChoices({});
    setLink({ ...link, synced: Number(body.synced) });
    notify(body.files ? `Pulled ${body.files} file${body.files === 1 ? '' : 's'} from GitHub.` : 'Already up to date.');
    void loadChanges();
  };
  const push = async () => {
    await settle();
    const body = await call('push', `${base}/push`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ message }),
    });
    if (!body) return void loadChanges();
    setMessage('');
    setLink({ ...link, synced: Number(body.synced) });
    notify(`Pushed ${body.files} file${body.files === 1 ? '' : 's'} to GitHub.`);
    void loadChanges();
  };

  return (
    <div className="sync-body">
      <div className="field-row">
        <div>
          <strong>
            <a href={link.url} target="_blank" rel="noreferrer">
              {link.repo}
            </a>
          </strong>
          <span data-testid="last-sync">
            Branch {link.branch}.{' '}
            {link.synced ? `Last synced ${new Date(link.synced).toLocaleString()}.` : 'Not synced yet.'}
          </span>
        </div>
        <span className="sync-tools">
          <button className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => void loadChanges()}>
            <RefreshCw size={13} /> Refresh
          </button>
          {canEdit && (
            <button
              className="btn btn-secondary btn-sm"
              disabled={!!busy}
              onClick={async () => {
                if (await call('unlink', `${base}/link`, { method: 'DELETE' })) {
                  setLink(null);
                  setChanges(null);
                  void loadStatus();
                }
              }}
            >
              Unlink
            </button>
          )}
        </span>
      </div>
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
      {!changes ? (
        <p className="muted">{busy ? 'Comparing with GitHub…' : 'Press Refresh to compare with GitHub.'}</p>
      ) : (
        <>
          <section aria-label="Pull from GitHub">
            <h4>Pull from GitHub</h4>
            {incoming === 0 ? (
              <p className="muted">Nothing new on GitHub.</p>
            ) : (
              <>
                <ul className="sync-files">
                  {changes.pull.take.map((path) => (
                    <li key={path}>
                      <span className="sync-status modified">changed on GitHub</span> {path}
                    </li>
                  ))}
                  {changes.pull.remove.map((path) => (
                    <li key={path}>
                      <span className="sync-status deleted">deleted on GitHub</span> {path}
                    </li>
                  ))}
                </ul>
                {conflicts.length > 0 && (
                  <div className="sync-conflicts" role="group" aria-label="Conflicts">
                    <p>
                      <strong>
                        {conflicts.length} file{conflicts.length === 1 ? '' : 's'} changed both here and on GitHub.
                      </strong>{' '}
                      Choose which version to keep for each. Nothing is overwritten until you choose.
                    </p>
                    {conflicts.map((c) => (
                      <div className="sync-conflict" key={c.path} data-testid="conflict">
                        <strong>{c.path}</strong>
                        <div className="sync-sides">
                          {(['mine', 'theirs'] as const).map((side) => {
                            const gone = side === 'mine' ? c.mineGone : c.theirsGone,
                              text = side === 'mine' ? c.mine : c.theirs;
                            return (
                              <label key={side} className={choices[c.path] === side ? 'on' : ''}>
                                <span>
                                  <input
                                    type="radio"
                                    name={`conflict-${c.path}`}
                                    checked={choices[c.path] === side}
                                    onChange={() => setChoices((all) => ({ ...all, [c.path]: side }))}
                                  />{' '}
                                  {side === 'mine' ? 'Keep the PaperDesk version' : 'Use the GitHub version'}
                                </span>
                                <pre>{gone ? '(deleted)' : (text ?? '(binary or very large file)')}</pre>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {canEdit && (
                  <button className="btn btn-primary" disabled={!!busy || unresolved > 0} onClick={() => void pull()}>
                    <ArrowDownToLine size={15} /> {busy === 'pull' ? 'Pulling…' : 'Pull'}
                  </button>
                )}
              </>
            )}
          </section>
          <section aria-label="Push to GitHub">
            <h4>Push to GitHub</h4>
            {changes.push.length === 0 ? (
              <p className="muted">
                {changes.behind ? 'Pull first to see what is left to push.' : 'Everything here is already on GitHub.'}
              </p>
            ) : (
              <>
                <ul className="sync-files">
                  {changes.push.map((change) => (
                    <li key={change.path}>
                      <button
                        className="link-btn"
                        aria-expanded={open === change.path}
                        onClick={() => setOpen(open === change.path ? '' : change.path)}
                      >
                        <span className={`sync-status ${change.status}`}>{change.status}</span> {change.path}
                      </button>
                      {open === change.path && <FileDiff change={change} />}
                    </li>
                  ))}
                </ul>
                {canEdit && (
                  <>
                    <label className="sync-message">
                      Commit message
                      <textarea
                        rows={2}
                        value={message}
                        maxLength={2000}
                        placeholder="Describe what changed"
                        onChange={(e) => setMessage(e.target.value)}
                      />
                    </label>
                    {changes.behind && <p className="muted">Pull the changes from GitHub before pushing.</p>}
                    <button
                      className="btn btn-primary"
                      disabled={!!busy || !message.trim() || changes.behind}
                      onClick={() => void push()}
                    >
                      <ArrowUpFromLine size={15} /> {busy === 'push' ? 'Pushing…' : 'Push'}
                    </button>
                  </>
                )}
              </>
            )}
          </section>
        </>
      )}
      {account}
    </div>
  );
}
