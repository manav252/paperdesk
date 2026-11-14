import crypto from 'node:crypto';
import type express from 'express';
import type { AuthUser } from './auth';
import type { Kv } from './kv';
import type { StoredFile } from './persistence';

/**
 * Sync between a project and a GitHub repository. Each person connects their own GitHub account through an OAuth
 * App; their token is encrypted with a key from the environment, stays on the server, and is used for their own
 * pushes and pulls, so commits carry their GitHub identity. Off unless the three variables below are set.
 */
const API = (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '');
const WEB = (process.env.GITHUB_WEB_URL ?? 'https://github.com').replace(/\/+$/, '');
const CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? '';
const TOKEN_KEY = process.env.TOKEN_ENCRYPTION_KEY ?? '';
export const githubConfigured = !!(CLIENT_ID && CLIENT_SECRET && TOKEN_KEY);

const b64 = (buffer: Buffer) => buffer.toString('base64url');
const keyFrom = (secret: string) => crypto.createHash('sha256').update(secret).digest();

/** AES-256-GCM with a fresh nonce: `nonce.tag.ciphertext`. */
export function seal(text: string, secret = TOKEN_KEY) {
  const iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(b64).join('.');
}
/** Null when the value was not sealed with this key or was altered. */
export function unseal(sealed: string, secret = TOKEN_KEY) {
  try {
    const [iv, tag, data] = sealed.split('.').map((part) => Buffer.from(part, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), iv!);
    decipher.setAuthTag(tag!);
    return Buffer.concat([decipher.update(data!), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Files LaTeX produces while compiling. They are never pushed, and never pulled or deleted on GitHub either. */
export const BUILD_PATTERNS = [
  '*.aux',
  '*.log',
  '*.out',
  '*.toc',
  '*.lof',
  '*.lot',
  '*.fls',
  '*.fdb_latexmk',
  '*.synctex.gz',
  '*.synctex(busy)',
  '*.bbl',
  '*.blg',
  '*.bcf',
  '*.run.xml',
  '*.nav',
  '*.snm',
  '*.vrb',
  '*.xdv',
  '*.dvi',
  '.DS_Store',
];
export const defaultGitignore = (mainFile?: string) =>
  `# LaTeX build files\n${BUILD_PATTERNS.join('\n')}\n` +
  (mainFile && /\.tex$/i.test(mainFile) ? `\n# Compiled document\n/${mainFile.replace(/\.tex$/i, '.pdf')}\n` : '');

function rule(line: string) {
  let pattern = line.trim();
  if (!pattern || pattern.startsWith('#') || pattern.startsWith('!')) return null;
  const folder = pattern.endsWith('/');
  pattern = pattern.replace(/\/+$/, '');
  const anchored = pattern.includes('/');
  pattern = pattern.replace(/^\//, '');
  if (!pattern) return null;
  const body = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`${anchored ? '^' : '(^|/)'}${body}${folder ? '/' : '(/|$)'}`);
}
/**
 * Which paths are left out of a sync: build files, the compiled PDF of each .tex file, and whatever the project's
 * own .gitignore lists (plain names, `*` patterns and folders; negated rules are not supported).
 */
export function ignoreMatcher(paths: string[], gitignore = '') {
  const rules = [...BUILD_PATTERNS, ...gitignore.split('\n')].map(rule).filter((r): r is RegExp => !!r);
  const outputs = new Set(paths.filter((p) => /\.tex$/i.test(p)).map((p) => p.replace(/\.tex$/i, '.pdf')));
  return (path: string) => outputs.has(path) || rules.some((r) => r.test(path));
}

/** The id git gives a file's contents. */
export const blobSha = (content: Buffer) =>
  crypto
    .createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]))
    .digest('hex');

export type Shas = Record<string, string>;
/**
 * What a pull has to do, comparing both sides with the last synced state: files only GitHub changed are taken or
 * removed, files only the project changed are left alone, and files both changed differently are conflicts.
 */
export function planPull(base: Shas, local: Shas, remote: Shas) {
  const take: string[] = [],
    remove: string[] = [],
    conflicts: string[] = [];
  for (const path of [...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])].sort()) {
    const b = base[path],
      l = local[path],
      r = remote[path];
    if (l === r || r === b) continue;
    if (l === b) (r ? take : remove).push(path);
    else conflicts.push(path);
  }
  return { take, remove, conflicts };
}
export type PushChange = { path: string; status: 'added' | 'modified' | 'deleted' };
/** What a push would change on GitHub. Only meaningful when planPull has nothing left to do. */
export function planPush(local: Shas, remote: Shas): PushChange[] {
  const changes: PushChange[] = [];
  for (const path of [...new Set([...Object.keys(local), ...Object.keys(remote)])].sort()) {
    if (local[path] === remote[path]) continue;
    changes.push({ path, status: !remote[path] ? 'added' : !local[path] ? 'deleted' : 'modified' });
  }
  return changes;
}

const toBuffer = (f: StoredFile) =>
  f.encoding === 'base64' ? Buffer.from(f.content ?? '', 'base64') : Buffer.from(String(f.content ?? ''), 'utf8');
const utf8 = new TextDecoder('utf-8', { fatal: true });
/** A file as the project stores it: text when it is valid UTF-8 without NUL bytes, otherwise base64. */
export function toStored(name: string, content: Buffer): StoredFile {
  try {
    if (content.includes(0)) throw new Error('binary');
    return { name, content: utf8.decode(content) };
  } catch {
    return { name, content: content.toString('base64'), encoding: 'base64' };
  }
}

class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
/** One person's access to the GitHub API. */
class Client {
  constructor(private token: string) {}
  async call<T = any>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<T> {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'PaperDesk',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 204 || okStatuses.includes(response.status)) return null as T;
    const data = (await response.json().catch(() => ({}))) as { message?: string };
    if (!response.ok)
      throw new GitHubError(
        response.status,
        response.status === 401
          ? 'GitHub no longer accepts this connection. Disconnect GitHub and connect again.'
          : `GitHub said: ${String(data.message ?? `status ${response.status}`).slice(0, 200)}`,
      );
    return data as T;
  }
  /** The branch's newest commit and its files; null for a repository with no commits. */
  async head(repo: string, branch: string) {
    const ref = await this.call<{ object: { sha: string } } | null>(
      'GET',
      `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
      undefined,
      [404, 409],
    );
    if (!ref) return null;
    const commit = await this.call<{ tree: { sha: string } }>('GET', `/repos/${repo}/git/commits/${ref.object.sha}`);
    const tree = await this.call<{ tree: { path: string; type: string; sha: string }[]; truncated?: boolean }>(
      'GET',
      `/repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`,
    );
    if (tree.truncated) throw new GitHubError(413, 'This repository has too many files to sync with PaperDesk.');
    const files: Shas = {};
    for (const entry of tree.tree) if (entry.type === 'blob') files[entry.path] = entry.sha;
    return { commit: ref.object.sha, tree: commit.tree.sha, files };
  }
  async blob(repo: string, sha: string) {
    const blob = await this.call<{ content: string }>('GET', `/repos/${repo}/git/blobs/${sha}`);
    return Buffer.from(blob.content, 'base64');
  }
}

type Link = { repo: string; branch: string; url: string; base: Shas; synced?: number; by?: string };
type Account = { login: string; token: string };
type Project = { name: string; mainFile?: string; files: StoredFile[] };

export type GithubDeps = {
  kv: Kv;
  user(req: express.Request): Promise<AuthUser | null>;
  originAllowed(origin?: string): boolean;
  overBudget(key: string, limit: number): boolean;
  /** The project's real owner key and id, from the project middleware. */
  owner(res: express.Response): string;
  read(id: string, owner: string): Promise<Project>;
  /** Runs `change` on the stored project under its lock and saves what it returns. */
  change(
    id: string,
    owner: string,
    author: string | null,
    change: (project: Project) => Promise<{ files: StoredFile[]; changed: StoredFile[]; deleted: string[] } | null>,
  ): Promise<void>;
  /** Saves any live edits first, so a sync sees what is on screen. */
  flush(id: string, owner: string): Promise<void>;
  maxBytes: number;
};

const TEXT_PREVIEW_BYTES = 200_000,
  PREVIEW_FILES = 40;

export function registerGithub(app: express.Express, deps: GithubDeps) {
  const { kv } = deps;
  const fail = (res: express.Response, e: unknown) => {
    const status = e instanceof GitHubError ? (e.status === 401 ? 401 : e.status === 404 ? 404 : 502) : 500;
    if (!(e instanceof GitHubError)) console.error('GitHub sync failed:', e);
    res.status(status).json({ error: e instanceof Error ? e.message : 'GitHub sync failed.' });
  };
  const signedIn = async (req: express.Request, res: express.Response) => {
    if (!githubConfigured) return void res.status(501).json({ error: 'GitHub sync not configured' });
    const user = await deps.user(req);
    if (!user) return void res.status(401).json({ error: 'Sign in to use GitHub sync.' });
    return user;
  };
  const account = async (userId: string) => {
    const row = await kv.get<Account>('github', userId);
    const token = row ? unseal(row.value.token) : null;
    return row && token ? { login: row.value.login, client: new Client(token), token } : null;
  };
  const connected = async (req: express.Request, res: express.Response) => {
    const user = await signedIn(req, res);
    if (!user) return null;
    const github = await account(user.id);
    if (!github) return void res.status(409).json({ error: 'Connect your GitHub account first.' });
    return { user, ...github };
  };
  const linkKey = (res: express.Response, id: string) => `${deps.owner(res)}/${id}`;

  app.get('/api/github', async (req, res) => {
    try {
      if (!githubConfigured) return void res.json({ configured: false, connected: false });
      const user = await deps.user(req);
      const row = user ? await kv.get<Account>('github', user.id) : null;
      res.json({ configured: true, connected: !!row, login: row?.value.login });
    } catch (e) {
      fail(res, e);
    }
  });

  // Starts the OAuth round trip: the browser is sent to GitHub, and GitHub sends it back to /api/github/callback.
  app.post('/api/github/connect', async (req, res) => {
    try {
      const user = await signedIn(req, res);
      if (!user) return;
      const site = req.header('Origin');
      if (!site || !deps.originAllowed(site)) return void res.status(400).json({ error: 'Unknown site.' });
      const back = typeof req.body?.back === 'string' && /^#[\w/-]{0,120}$/.test(req.body.back) ? req.body.back : '';
      const state = crypto.randomBytes(24).toString('base64url');
      await kv.set('github-state', state, { user: user.id, site, back });
      res.json({
        url: `${WEB}/login/oauth/authorize?client_id=${encodeURIComponent(CLIENT_ID)}&scope=repo&state=${state}`,
      });
    } catch (e) {
      fail(res, e);
    }
  });

  app.get('/api/github/callback', async (req, res) => {
    const state = String(req.query.state ?? '');
    const pending = /^[\w-]{20,}$/.test(state)
      ? await kv.get<{ user: string; site: string; back: string }>('github-state', state).catch(() => null)
      : null;
    if (!pending || Date.now() - pending.updated > 10 * 60_000)
      return void res.status(400).type('text/plain').send('This GitHub sign-in link has expired. Start again.');
    await kv.delete('github-state', state);
    const done = (result: string) => res.redirect(`${pending.value.site}/?github=${result}${pending.value.back}`);
    try {
      if (!githubConfigured || typeof req.query.code !== 'string') return done('failed');
      const exchange = await fetch(`${WEB}/login/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code: req.query.code }),
        signal: AbortSignal.timeout(20_000),
      });
      const granted = (await exchange.json().catch(() => ({}))) as { access_token?: string };
      if (!granted.access_token) return done('failed');
      const profile = await new Client(granted.access_token).call<{ login: string }>('GET', '/user');
      await kv.set('github', pending.value.user, { login: profile.login, token: seal(granted.access_token) });
      done('connected');
    } catch (e) {
      console.error('Connecting GitHub failed:', e instanceof Error ? e.message : e);
      done('failed');
    }
  });

  // Disconnect: the grant is revoked at GitHub and the stored token deleted.
  app.delete('/api/github', async (req, res) => {
    try {
      const user = await signedIn(req, res);
      if (!user) return;
      const github = await account(user.id);
      if (github)
        await fetch(`${API}/applications/${CLIENT_ID}/grant`, {
          method: 'DELETE',
          headers: {
            Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'User-Agent': 'PaperDesk',
          },
          body: JSON.stringify({ access_token: github.token }),
          signal: AbortSignal.timeout(20_000),
        }).catch((e) => console.error('Revoking the GitHub grant failed:', e instanceof Error ? e.message : e));
      await kv.delete('github', user.id);
      res.status(204).end();
    } catch (e) {
      fail(res, e);
    }
  });

  app.get('/api/github/repos', async (req, res) => {
    try {
      const github = await connected(req, res);
      if (!github) return;
      const repos = await github.client.call<
        { full_name: string; private: boolean; permissions?: { push?: boolean } }[]
      >('GET', '/user/repos?per_page=100&sort=updated');
      res.json(
        repos.filter((r) => r.permissions?.push !== false).map((r) => ({ name: r.full_name, private: r.private })),
      );
    } catch (e) {
      fail(res, e);
    }
  });

  app.get('/api/projects/:id/github', async (req, res) => {
    try {
      const row = githubConfigured ? await kv.get<Link>('github-link', linkKey(res, req.params.id)) : null;
      const link = row?.value;
      res.json({ link: link ? { repo: link.repo, branch: link.branch, url: link.url, synced: link.synced } : null });
    } catch (e) {
      fail(res, e);
    }
  });

  app.post('/api/projects/:id/github/link', async (req, res) => {
    try {
      const github = await connected(req, res);
      if (!github) return;
      await deps.read(req.params.id, deps.owner(res));
      let name = String(req.body?.repo ?? '');
      if (req.body?.create) {
        const wanted = String(req.body.create.name ?? '').trim();
        if (!/^[\w.-]{1,100}$/.test(wanted))
          return void res.status(400).json({ error: 'Use letters, numbers, dots, dashes and underscores.' });
        // Created with a first commit, so there is a branch to push to.
        const made = await github.client.call<{ full_name: string }>('POST', '/user/repos', {
          name: wanted,
          private: req.body.create.private !== false,
          auto_init: true,
        });
        name = made.full_name;
      }
      if (!/^[\w.-]+\/[\w.-]+$/.test(name)) return void res.status(400).json({ error: 'Choose a repository.' });
      const repo = await github.client.call<{
        full_name: string;
        default_branch: string;
        html_url: string;
        permissions?: { push?: boolean };
      }>('GET', `/repos/${name}`);
      if (repo.permissions?.push === false)
        return void res.status(403).json({ error: 'You cannot push to this repository.' });
      const branch = repo.default_branch || 'main';
      // A repository made here starts as this project: the starter files GitHub added are replaced by the first push.
      const base = req.body?.create ? ((await github.client.head(repo.full_name, branch))?.files ?? {}) : {};
      const link: Link = { repo: repo.full_name, branch, url: repo.html_url, base };
      await kv.set('github-link', linkKey(res, req.params.id), link);
      res.json({ link: { repo: link.repo, branch: link.branch, url: link.url } });
    } catch (e) {
      fail(res, e);
    }
  });

  app.delete('/api/projects/:id/github/link', async (req, res) => {
    try {
      if (!(await signedIn(req, res))) return;
      await kv.delete('github-link', linkKey(res, req.params.id));
      res.status(204).end();
    } catch (e) {
      fail(res, e);
    }
  });

  /** Both sides of a sync as path → git id, with ignored paths left out of each. */
  const compare = (project: Project, link: Link, remoteFiles: Shas) => {
    const real = project.files.filter((f) => !f.name.endsWith('/'));
    const gitignore = real.find((f) => f.name === '.gitignore' && f.encoding !== 'base64')?.content ?? '';
    const ignored = ignoreMatcher(
      real.map((f) => f.name),
      gitignore,
    );
    const buffers = new Map(real.filter((f) => !ignored(f.name)).map((f) => [f.name, toBuffer(f)]));
    const local: Shas = {};
    for (const [name, buffer] of buffers) local[name] = blobSha(buffer);
    const remote: Shas = {};
    for (const [path, sha] of Object.entries(remoteFiles)) if (!ignored(path)) remote[path] = sha;
    // Without a .gitignore on either side, the first push adds the default one.
    if (!local['.gitignore']) {
      if (remote['.gitignore'])
        local['.gitignore'] = remote['.gitignore']; // the repository's own one stays as it is
      else {
        const buffer = Buffer.from(defaultGitignore(project.mainFile));
        buffers.set('.gitignore', buffer);
        local['.gitignore'] = blobSha(buffer);
      }
    }
    return { local, remote, buffers, pull: planPull(link.base, local, remote) };
  };
  const preview = (buffer: Buffer | undefined) => {
    if (!buffer || buffer.length > TEXT_PREVIEW_BYTES) return undefined;
    const stored = toStored('', buffer);
    return stored.encoding ? undefined : stored.content;
  };
  const linked = async (req: express.Request, res: express.Response) => {
    const github = await connected(req, res);
    if (!github) return null;
    const row = await kv.get<Link>('github-link', linkKey(res, String(req.params.id)));
    if (!row) return void res.status(409).json({ error: 'Link this project to a repository first.' });
    return { ...github, link: row.value };
  };

  // What a push would send and what a pull would bring, with the text of changed files for the preview.
  app.get('/api/projects/:id/github/changes', async (req, res) => {
    try {
      const sync = await linked(req, res);
      if (!sync) return;
      const { link, client } = sync;
      await deps.flush(req.params.id, deps.owner(res));
      const [project, head] = await Promise.all([
        deps.read(req.params.id, deps.owner(res)),
        client.head(link.repo, link.branch),
      ]);
      const { local, remote, buffers, pull } = compare(project, link, head?.files ?? {});
      const theirs = async (path: string) =>
        remote[path] ? preview(await client.blob(link.repo, remote[path])) : undefined;
      const incoming = [...pull.take, ...pull.remove, ...pull.conflicts];
      const behind = incoming.length > 0;
      const push = planPush(local, remote).filter((c) => !incoming.includes(c.path));
      res.json({
        behind,
        push: await Promise.all(
          push.map(async (change, index) => ({
            ...change,
            before: index < PREVIEW_FILES && change.status === 'modified' ? await theirs(change.path) : undefined,
            after: index < PREVIEW_FILES ? preview(buffers.get(change.path)) : undefined,
          })),
        ),
        pull: {
          take: pull.take,
          remove: pull.remove,
          conflicts: await Promise.all(
            pull.conflicts.map(async (path) => ({
              path,
              mine: preview(buffers.get(path)),
              theirs: await theirs(path),
              mineGone: !local[path],
              theirsGone: !remote[path],
            })),
          ),
        },
      });
    } catch (e) {
      fail(res, e);
    }
  });

  app.post('/api/projects/:id/github/push', async (req, res) => {
    try {
      const sync = await linked(req, res);
      if (!sync) return;
      const { link, client, user, login } = sync;
      if (deps.overBudget(`github:${user.id}`, 12))
        return void res.status(429).json({ error: 'Too many syncs. Wait a minute and try again.' });
      const message = String(req.body?.message ?? '')
        .replace(/\r\n?/g, '\n')
        .trim()
        .slice(0, 2000);
      if (!message) return void res.status(400).json({ error: 'Write a commit message.' });
      const owner = deps.owner(res);
      await deps.flush(req.params.id, owner);
      const project = await deps.read(req.params.id, owner);
      let head = await client.head(link.repo, link.branch);
      if (!head) {
        // A repository without commits has no branch yet: its first commit is the .gitignore.
        await client.call('PUT', `/repos/${link.repo}/contents/.gitignore`, {
          message: 'Add .gitignore',
          content: Buffer.from(defaultGitignore(project.mainFile)).toString('base64'),
          branch: link.branch,
        });
        head = await client.head(link.repo, link.branch);
        if (!head) throw new GitHubError(502, 'GitHub did not create the first commit. Try again.');
      }
      const { local, remote, buffers, pull } = compare(project, link, head.files);
      if (pull.take.length || pull.remove.length || pull.conflicts.length)
        return void res
          .status(409)
          .json({ error: 'GitHub has changes that are not in this project yet. Pull first.', behind: true });
      const changes = planPush(local, remote);
      if (!changes.length) return void res.status(400).json({ error: 'Nothing to push: GitHub is up to date.' });
      const tree = [];
      for (const change of changes) {
        if (change.status === 'deleted') tree.push({ path: change.path, mode: '100644', type: 'blob', sha: null });
        else {
          const blob = await client.call<{ sha: string }>('POST', `/repos/${link.repo}/git/blobs`, {
            content: buffers.get(change.path)!.toString('base64'),
            encoding: 'base64',
          });
          tree.push({ path: change.path, mode: '100644', type: 'blob', sha: blob.sha });
        }
      }
      const made = await client.call<{ sha: string }>('POST', `/repos/${link.repo}/git/trees`, {
        base_tree: head.tree,
        tree,
      });
      // No author is named: GitHub records the person whose account this is. The message is sent as written.
      const commit = await client.call<{ sha: string }>('POST', `/repos/${link.repo}/git/commits`, {
        message,
        tree: made.sha,
        parents: [head.commit],
      });
      // Not forced: if someone pushed in the meantime GitHub refuses, and nothing of theirs is overwritten.
      await client.call('PATCH', `/repos/${link.repo}/git/refs/heads/${encodeURIComponent(link.branch)}`, {
        sha: commit.sha,
        force: false,
      });
      const base = { ...head.files };
      for (const change of changes) {
        if (change.status === 'deleted') delete base[change.path];
        else base[change.path] = local[change.path]!;
      }
      const synced = Date.now();
      await kv.set('github-link', linkKey(res, req.params.id), { ...link, base, synced, by: login });
      res.json({ commit: commit.sha, files: changes.length, synced });
    } catch (e) {
      if (e instanceof GitHubError && e.status === 422)
        return void res
          .status(409)
          .json({ error: 'GitHub changed while pushing. Pull first, then push again.', behind: true });
      fail(res, e);
    }
  });

  app.post('/api/projects/:id/github/pull', async (req, res) => {
    try {
      const sync = await linked(req, res);
      if (!sync) return;
      const { link, client, user, login } = sync;
      if (deps.overBudget(`github:${user.id}`, 12))
        return void res.status(429).json({ error: 'Too many syncs. Wait a minute and try again.' });
      const choices = (req.body?.resolutions ?? {}) as Record<string, unknown>;
      const owner = deps.owner(res);
      await deps.flush(req.params.id, owner);
      const head = await client.head(link.repo, link.branch);
      if (!head) return void res.status(400).json({ error: 'This repository has no commits yet. Push first.' });
      let unresolved: string[] = [],
        taken = 0;
      await deps.change(req.params.id, owner, user.email ?? login, async (project) => {
        const { remote, pull } = compare(project, link, head.files);
        unresolved = pull.conflicts.filter((path) => choices[path] !== 'mine' && choices[path] !== 'theirs');
        if (unresolved.length) return null;
        const theirs = pull.conflicts.filter((path) => choices[path] === 'theirs');
        const take = [...pull.take, ...theirs.filter((path) => remote[path])],
          remove = new Set([...pull.remove, ...theirs.filter((path) => !remote[path])]);
        taken = take.length + remove.size;
        if (!taken) return null;
        const fetched = await Promise.all(
          take.map(async (path) => toStored(path, await client.blob(link.repo, remote[path]!))),
        );
        const names = new Set(take);
        const files = [...project.files.filter((f) => !names.has(f.name) && !remove.has(f.name)), ...fetched];
        const size = files.reduce((sum, f) => sum + toBuffer(f).length, 0);
        if (size > deps.maxBytes)
          throw new GitHubError(413, 'Pulling would make this project larger than PaperDesk allows.');
        return { files, changed: fetched, deleted: [...remove] };
      });
      if (unresolved.length)
        return void res.status(409).json({
          error: 'Some files changed both here and on GitHub. Choose which version to keep.',
          conflicts: unresolved,
        });
      // Everything on GitHub is now accounted for; files kept from this side show up as changes to push.
      const synced = Date.now();
      await kv.set('github-link', linkKey(res, req.params.id), { ...link, base: head.files, synced, by: login });
      res.json({ files: taken, synced });
    } catch (e) {
      fail(res, e);
    }
  });
}
