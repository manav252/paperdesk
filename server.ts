import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import multer from 'multer';
import unzipper from 'unzipper';
import archiver from 'archiver';
import { parseLatexLog, type LogEntry } from './src/lib/latexLog';
import { parseForwardSync, parseInverseSync } from './src/lib/synctex';
import { assistantConfigured, assistantModel, assistantRouter } from './server/assistant';
import { ProjectPersistence, type ProjectData, type StoredFile } from './server/persistence';
import { syncWorkspace, Workspaces, type SourceFile, type Workspace } from './server/workspace';

// Local settings and secrets come from an untracked .env (see .env.example); real environment variables win.
try { process.loadEnvFile(); } catch { /* no .env file */ }

const exec = promisify(execFile);
const app = express();
const http = createServer(app);
const allowedOrigins = (process.env.PAPERDESK_CORS_ORIGINS ?? '').split(',').map(origin => origin.trim()).filter(Boolean);
const localOrigin = (origin: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
const originAllowed = (origin?: string) => !origin || allowedOrigins.includes(origin) || (process.env.NODE_ENV !== 'production' && localOrigin(origin));
const io = new Server(http, { cors: { origin: (origin, callback) => callback(null, originAllowed(origin)) } });
const PORT = Number(process.env.PORT ?? 3001);
const DATA = path.resolve(process.env.PAPERDESK_DATA ?? './backend/storage');
const PROJECTS = path.join(DATA, 'projects');
const IMAGE = process.env.LATEX_DOCKER_IMAGE ?? 'paperdesk-texlive:latest';
const COMPILE_MODE = process.env.COMPILE_MODE ?? 'docker';
const persistence = new ProjectPersistence();
const COMPILE_TIMEOUT_MS = Number(process.env.COMPILE_TIMEOUT_MS ?? 120_000);
const MAX_COMPILE_TIMEOUT_MS = Number(process.env.MAX_COMPILE_TIMEOUT_MS ?? 600_000);
const COMPILE_MEMORY_MB = Number(process.env.COMPILE_MEMORY_MB ?? 384);
const MAX_PROJECT_BYTES = Number(process.env.MAX_PROJECT_BYTES ?? 25 * 1024 * 1024);
if (process.env.NODE_ENV === 'production' && persistence.mode === 'local') throw new Error('Production requires Neon and R2 storage environment variables.');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: Math.min(MAX_PROJECT_BYTES, 25 * 1024 * 1024) } });
/** latexmk flag per engine. Bare `-pdflatex` is not a valid latexmk switch. */
const ENGINES: Record<string, string> = { pdflatex: '-pdf', xelatex: '-xelatex', lualatex: '-lualatex' };
/** Files returned to the client as base64; everything else is UTF-8 text. */
const BINARY = /\.(png|jpe?g|gif|bmp|tiff?|pdf|eps|ps|zip|gz|ttf|otf|woff2?)$/i;

type CompileResult = { success: boolean; log: string; errors: LogEntry[]; warnings: LogEntry[]; durationMs: number };
const RESULTS = new Map<string, CompileResult>();
/** Parsing a large .synctex.gz (e.g. the Springer template) can take several seconds on Render's small CPU share. */
const SYNCTEX_TIMEOUT_MS = 25_000;
/** SyncTeX lookups per project run one after another; a second lookup waits instead of being refused. */
const SYNCING = new Map<string, Promise<void>>();
let nativeCompilerReady = COMPILE_MODE !== 'native';
const resultKey = (id: string, owner: string) => persistence.mode === 'neon-r2' ? `${owner}/${id}` : id;

// Behind a proxy (Render), set TRUST_PROXY=1 so rate limits see the client's IP rather than the proxy's.
if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) return next();
  if (!originAllowed(origin)) return send(res, 403, 'This website origin is not allowed.');
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-PaperDesk-Owner');
  if (req.method === 'OPTIONS') return void res.status(204).end();
  next();
});
app.use('/api/projects', (req, res, next) => {
  if (persistence.mode !== 'neon-r2') return next();
  const owner = String(req.header('X-PaperDesk-Owner') ?? req.query.owner ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner)) return void send(res, 401, 'This browser has no valid project workspace key.');
  res.locals.projectOwner = owner;
  next();
});
// The assistant parses its own, much smaller, request bodies.
app.use(assistantRouter());
app.use(express.json({ limit: '36mb' }));

const safeName = (name: string) => {
  const normalized = path.posix.normalize(name.replaceAll('\\', '/'));
  if (!normalized || normalized === '.' || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) throw new Error('Invalid file path');
  return normalized;
};

const projectPath = (id: string) => {
  if (!/^[\w-]+$/.test(id)) throw new Error('Invalid project ID');
  return path.join(PROJECTS, id);
};

const utf8 = new TextDecoder('utf-8', { fatal: true });
const decodeUtf8 = (buf: Buffer) => { try { return utf8.decode(buf); } catch { return null; } };
const toBuffer = (f: StoredFile) => (f.encoding === 'base64' ? Buffer.from(f.content ?? '', 'base64') : Buffer.from(String(f.content ?? ''), 'utf8'));
function validateFiles(files: StoredFile[]) {
  let size = 0;
  for (const file of files) {
    safeName(String(file.name));
    size += toBuffer(file).length;
    if (size > MAX_PROJECT_BYTES) throw new Error(`Project files exceed the ${Math.floor(MAX_PROJECT_BYTES / 1024 / 1024)} MB limit.`);
  }
}

async function readProject(id: string, owner = '') {
  projectPath(id);
  if (persistence.mode === 'neon-r2') return persistence.read(id, owner);
  const dir = projectPath(id);
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'project.json'), 'utf8'));
  const files = await walkFiles(path.join(dir, 'files'));
  return { ...meta, files } as { id: string; name: string; modified: number; files: StoredFile[]; mainFile?: string; archived?: boolean; settings?: unknown; versions?: unknown[]; comments?: unknown[]; changes?: unknown[] };
}

async function walkFiles(root: string, relative = ''): Promise<StoredFile[]> {
  let entries;
  try { entries = await fs.readdir(path.join(root, relative), { withFileTypes: true }); } catch { return []; }
  const out: StoredFile[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = path.posix.join(relative, e.name);
    if (e.isDirectory()) {
      out.push({ name: rel + '/', content: '' }, ...(await walkFiles(root, rel)));
    } else if (e.isFile()) {
      const buf = await fs.readFile(path.join(root, rel));
      // Text that isn't valid UTF-8 (e.g. Latin-1 .bst files) is sent as base64 so it round-trips byte for byte.
      const text = BINARY.test(rel) ? null : decodeUtf8(buf);
      out.push(text === null ? { name: rel, content: buf.toString('base64'), encoding: 'base64' } : { name: rel, content: text });
    }
  }
  return out;
}

/** Writes the given files. With `replace`, files and folders not in the list are removed so deletes and renames stick. */
type ProjectUpdate = { name?: string; files?: StoredFile[]; mainFile?: string; archived?: boolean; settings?: unknown; versions?: unknown[]; comments?: unknown[]; changes?: unknown[] };
/** Writes to one project run one at a time: overlapping saves (initial sync and autosave) used to read a half-written project.json. */
const projectLocks = new Map<string, Promise<unknown>>();
function writeProject(id: string, p: ProjectUpdate, options: { replace?: boolean } = {}, owner = '') {
  const lockId = persistence.mode === 'neon-r2' ? `${owner}/${id}` : id;
  const run = (projectLocks.get(lockId) ?? Promise.resolve()).catch(() => undefined).then(() => writeProjectNow(id, p, options, owner));
  projectLocks.set(lockId, run);
  run.finally(() => { if (projectLocks.get(lockId) === run) projectLocks.delete(lockId); }).catch(() => undefined);
  return run;
}

async function writeProjectNow(id: string, p: ProjectUpdate, { replace = false } = {}, owner = '') {
  projectPath(id);
  if (persistence.mode === 'neon-r2') {
    if (p.files) validateFiles(p.files);
    return persistence.write(id, owner, p);
  }
  const dir = projectPath(id);
  const root = path.join(dir, 'files');
  await fs.mkdir(root, { recursive: true });
  const keep = new Set<string>();
  for (const f of p.files ?? []) {
    const name = safeName(f.name);
    if (f.name.endsWith('/')) {
      await fs.mkdir(path.join(root, name), { recursive: true });
      keep.add(name.replace(/\/$/, ''));
      continue;
    }
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, toBuffer(f));
    keep.add(name);
    // Parent folders of a kept file are implicitly kept.
    for (let d = path.posix.dirname(name); d !== '.'; d = path.posix.dirname(d)) keep.add(d);
  }
  if (replace) await prune(root, '', keep);
  const metaPath = path.join(dir, 'project.json');
  const previous: Record<string, unknown> = await fs.readFile(metaPath, 'utf8').then(x => JSON.parse(x) as Record<string, unknown>).catch(() => ({} as Record<string, unknown>));
  const meta = { ...previous, id, name: p.name ?? previous.name ?? 'Untitled Project', modified: Date.now(), ...Object.fromEntries(['mainFile', 'archived', 'settings', 'versions', 'comments', 'changes'].filter(k => p[k as keyof typeof p] !== undefined).map(k => [k, p[k as keyof typeof p]])) };
  // Write-then-rename so readers never see a partial file.
  const tmp = `${metaPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(meta));
  await fs.rename(tmp, metaPath);
  return readProject(id, owner);
}

async function listProjects(owner = '') {
  if (persistence.mode === 'neon-r2') return persistence.list(owner);
  await fs.mkdir(PROJECTS, { recursive: true });
  const ids = await fs.readdir(PROJECTS);
  const records: ProjectData[] = [];
  for (const id of ids) { try { records.push(await readProject(id)); } catch { /* skip unreadable project folders */ } }
  return records;
}

async function prune(root: string, relative: string, keep: Set<string>) {
  let entries;
  try { entries = await fs.readdir(path.join(root, relative), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const rel = path.posix.join(relative, e.name);
    if (!keep.has(rel)) await fs.rm(path.join(root, rel), { recursive: true, force: true });
    else if (e.isDirectory()) await prune(root, rel, keep);
  }
}

async function giveCompileFilesToSandboxUser(root: string): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) await giveCompileFilesToSandboxUser(child);
    await fs.chown(child, 65534, 65534);
  }
  await fs.chown(root, 65534, 65534);
}

const send = (res: express.Response, status: number, error: unknown) => res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
const projectOwner = (res: express.Response) => String(res.locals.projectOwner ?? '');

async function dockerStatus() {
  try {
    await exec('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 5000 });
  } catch {
    return { docker: false, image: false };
  }
  try {
    await exec('docker', ['image', 'inspect', IMAGE], { timeout: 5000 });
    return { docker: true, image: true };
  } catch {
    return { docker: true, image: false };
  }
}

// Restricted shell escape (TeX Live's default) lets TeX run only a fixed list of helpers such as repstopdf and
// kpsewhich. It converts EPS figures and avoids the "epstopdf: Shell escape feature is not enabled" warning that
// every graphicx document otherwise logs. Arbitrary commands (\write18 with anything else) stay disabled.
function latexmkArgs(engine: string, mainFile: string, stopOnFirstError: boolean, draft: boolean, format?: string) {
  const fmt = format ? ` -fmt=${format}` : '';
  const command = engine === 'pdflatex' ? `$pdflatex = "pdflatex -shell-restricted${fmt} %O %S";`
    : engine === 'xelatex' ? '$xelatex = "xelatex -shell-restricted %O %S";'
      : '$lualatex = "lualatex -shell-restricted %O %S";';
  return [ENGINES[engine]!, '-e', command, '-synctex=1', '-interaction=nonstopmode', '-file-line-error', ...(stopOnFirstError ? ['-halt-on-error'] : []), ...(draft ? ['-draftmode'] : []), '-norc', mainFile];
}

/** One engine pass without latexmk, whose startup alone costs most of a second on a small instance. */
function directArgs(engine: string, mainFile: string, stopOnFirstError: boolean, format?: string) {
  return ['-shell-restricted', ...(format ? [`-fmt=${format}`] : []), '-synctex=1', '-interaction=nonstopmode', '-file-line-error', ...(stopOnFirstError ? ['-halt-on-error'] : []), mainFile];
}

/** Name of the cached preamble format (pdfLaTeX only; see buildPreambleFormat). */
const PREAMBLE_FORMAT = 'pd-preamble';
/** Identifies the preamble: its text plus local style files and files it \\inputs. A change means rebuilding the format. */
function preambleKey(ws: Workspace, source: string) {
  const preamble = source.split(/\\begin\s*\{document\}/)[0] ?? source;
  const inputs = [...preamble.matchAll(/\\(?:input|include|usepackage|documentclass|RequirePackage)(?:\[[^\]]*\])?\{([^}]+)\}/g)].flatMap(m => m[1].split(',').map(n => n.trim()));
  const deps = [...ws.hashes].filter(([name]) => /\.(sty|cls|cfg|def|clo|ldf|fd)$/i.test(name) || inputs.some(i => name === i || name === `${i}.tex`)).sort().map(([n, h]) => `${n}:${h}`);
  return crypto.createHash('sha256').update(preamble).update(deps.join('|')).digest('hex').slice(0, 24);
}

/** Starts a process group so timeout cleanup also kills TeX and bibliography children. */
function runNativeCompiler(cwd: string, argv: string[], timeoutMs: number, onStart?: (kill: () => void) => void) {
  return new Promise<{ stdout: string; stderr: string; killed: boolean; reason?: 'timeout' | 'output_limit'; code: number | null }>((resolve, reject) => {
    const memoryBytes = Math.max(192, COMPILE_MEMORY_MB) * 1024 * 1024;
    const safeEnv = {
      PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: cwd, TMPDIR: path.join(cwd, 'tmp'),
      TEXMFVAR: path.join(cwd, 'texmf-var'), TEXMFCONFIG: path.join(cwd, 'texmf-config'),
      FONTCONFIG_CACHE: path.join(cwd, 'font-cache'),
    };
    const child = spawn('setpriv', ['--reuid=65534', '--regid=65534', '--clear-groups', '--bounding-set=-all', '--', 'prlimit', `--as=${memoryBytes}`, '--cpu=120', '--nproc=64', '--fsize=52428800', '--nofile=128', '--', ...argv], {
      cwd, env: safeEnv,
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    onStart?.(() => { killed = true; if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } } });
    let stdout = '', stderr = '', killed = false, reason: 'timeout' | 'output_limit' | undefined, settled = false;
    const limitOutput = 4 * 1024 * 1024;
    const collect = (target: 'stdout' | 'stderr') => (chunk: Buffer) => {
      if (stdout.length + stderr.length + chunk.length > limitOutput) {
        killed = true; reason = 'output_limit';
        if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
        return;
      }
      if (target === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    const timer = setTimeout(() => {
      killed = true; reason = 'timeout';
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    }, timeoutMs);
    child.once('error', error => { if (settled) return; settled = true; clearTimeout(timer); reject(error); });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, killed, reason, code });
    });
  });
}

app.get('/api/health', async (_req, res) => {
  const status = COMPILE_MODE === 'native' ? { docker: false, image: false } : await dockerStatus();
  const compilerReady = COMPILE_MODE === 'native' ? nativeCompilerReady : status.docker && status.image;
  res.status(compilerReady ? 200 : 503).json({ ok: compilerReady, ...status, compilerMode: COMPILE_MODE, compilerReady, maxCompileTimeoutMs: MAX_COMPILE_TIMEOUT_MS, storage: { mode: persistence.mode, ready: persistence.ready || persistence.mode === 'neon-r2' }, compilerImage: IMAGE, assistant: { configured: assistantConfigured(), model: assistantModel() } });
});

app.get('/api/projects', async (_req, res) => {
  try { res.json(await listProjects(projectOwner(res))); } catch (e) { send(res, 500, e); }
});

app.post('/api/projects', async (req, res) => {
  try {
    const id = typeof req.body.id === 'string' && /^[\w-]+$/.test(req.body.id) ? req.body.id : crypto.randomUUID();
    const files = Array.isArray(req.body.files) ? req.body.files as StoredFile[] : [];
    validateFiles(files);
    res.status(201).json(await writeProject(id, { name: String(req.body.name ?? 'Untitled Project'), files }, { replace: true }, projectOwner(res)));
  } catch (e) { send(res, 400, e); }
});

app.get('/api/projects/:id', async (req, res) => {
  try { res.json(await readProject(req.params.id, projectOwner(res))); } catch { send(res, 404, 'Project not found'); }
});

/** Saves a project; creates it if it doesn't exist yet. A `files` list replaces the stored files. */
app.put('/api/projects/:id', async (req, res) => {
  try {
    // Fields left out of the body keep their stored values (the storage layer merges them).
    const files = Array.isArray(req.body.files) ? req.body.files : undefined;
    const saved = await writeProject(req.params.id, { name: req.body.name, files, mainFile: req.body.mainFile, archived: req.body.archived, settings: req.body.settings, versions: req.body.versions, comments: req.body.comments, changes: req.body.changes }, { replace: !!files }, projectOwner(res));
    // The browser already has the files it just sent; echoing them back would double the transfer.
    res.json({ ...saved, files: files ? undefined : saved.files });
  } catch (e) { send(res, 400, e); }
});

app.delete('/api/projects/:id', async (req, res) => {
  try {
    projectPath(req.params.id);
    if (persistence.mode === 'neon-r2') await persistence.delete(req.params.id, projectOwner(res));
    else await fs.rm(projectPath(req.params.id), { recursive: true, force: true });
    const key = resultKey(req.params.id, projectOwner(res));
    RESULTS.delete(key); ARTIFACTS.delete(key); await workspaces.dropProject(`${key}:`);
    res.status(204).end();
  } catch (e) { send(res, 400, e); }
});

app.get('/api/projects/:id/files', async (req, res) => {
  try { res.json((await readProject(req.params.id, projectOwner(res))).files); } catch { send(res, 404, 'Project not found'); }
});

app.post('/api/projects/:id/files', async (req, res) => {
  try {
    const p = await readProject(req.params.id, projectOwner(res));
    const name = safeName(String(req.body.name ?? ''));
    if (p.files.some(f => f.name === name)) return void send(res, 409, 'File already exists');
    const file = { name, content: req.body.content ?? '', encoding: req.body.encoding === 'base64' ? 'base64' as const : undefined };
    const result = await writeProject(req.params.id, { ...p, files: [...p.files, file] }, { replace: true }, projectOwner(res));
    res.status(201).json(result.files.find(f => f.name === name));
  } catch (e) { send(res, 400, e); }
});

app.put('/api/projects/:id/files/:fileId', async (req, res) => {
  try {
    const p = await readProject(req.params.id, projectOwner(res));
    const name = safeName(decodeURIComponent(req.params.fileId));
    if (!p.files.some(f => f.name === name)) return void send(res, 404, 'File not found');
    const file = { name, content: req.body.content ?? '', encoding: req.body.encoding === 'base64' ? 'base64' as const : undefined };
    await writeProject(req.params.id, { ...p, files: p.files.map(f => f.name === name ? file : f) }, { replace: true }, projectOwner(res));
    res.json({ name });
  } catch (e) { send(res, 400, e); }
});

app.delete('/api/projects/:id/files/:fileId', async (req, res) => {
  try {
    const p = await readProject(req.params.id, projectOwner(res));
    const name = safeName(decodeURIComponent(req.params.fileId));
    await writeProject(req.params.id, { ...p, files: p.files.filter(file => file.name !== name && !file.name.startsWith(`${name}/`)) }, { replace: true }, projectOwner(res));
    res.status(204).end();
  } catch (e) { send(res, 400, e); }
});

app.post('/api/projects/:id/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return void send(res, 400, 'ZIP file required');
    const projectId = String(req.params.id);
    const owner = projectOwner(res);
    const existing = await readProject(projectId, owner).catch(() => null);
    if (!existing) await writeProject(projectId, { name: req.file.originalname.replace(/\.zip$/i, '') }, {}, owner);
    const directory = await unzipper.Open.buffer(req.file.buffer);
    // Strip a single top-level folder (common in exported archives) so main.tex lands at the root.
    const names = directory.files.map((f: any) => String(f.path)).filter((n: string) => !n.startsWith('__MACOSX/'));
    const tops = new Set(names.map((n: string) => n.split('/')[0]));
    const prefix = tops.size === 1 && names.every((n: string) => n.includes('/')) ? [...tops][0] + '/' : '';
    const imported: StoredFile[] = [];
    let expandedBytes = 0;
    for (const entry of directory.files) {
      if (String(entry.path).startsWith('__MACOSX/')) continue;
      const rel = String(entry.path).slice(prefix.length);
      if (!rel) continue;
      const name = safeName(rel);
      if (entry.type === 'Directory') { imported.push({ name: name.endsWith('/') ? name : `${name}/`, content: '' }); continue; }
      const content = await entry.buffer();
      expandedBytes += content.length;
      if (expandedBytes > MAX_PROJECT_BYTES) return void send(res, 413, `ZIP expands beyond the ${Math.floor(MAX_PROJECT_BYTES / 1024 / 1024)} MB project limit.`);
      const text = BINARY.test(name) ? null : decodeUtf8(content);
      imported.push(text === null ? { name, content: content.toString('base64'), encoding: 'base64' } : { name, content: text });
    }
    validateFiles(imported);
    const current = await readProject(projectId, owner);
    const updated = await writeProject(projectId, { ...current, files: imported }, { replace: true }, owner);
    res.json(updated);
  } catch (e) { send(res, 400, `Unable to import ZIP: ${e instanceof Error ? e.message : String(e)}`); }
});

/**
 * Read-only copy link. Stores a snapshot of the project as sent by its owner; anyone with the link can open the
 * snapshot as a new project in their own browser. The owner's project is never exposed or changed.
 */
app.post('/api/projects/:id/share', async (req, res) => {
  try {
    projectPath(String(req.params.id));
    const files = Array.isArray(req.body.files) ? req.body.files as StoredFile[] : (await readProject(String(req.params.id), projectOwner(res))).files;
    validateFiles(files);
    const snapshot = { name: String(req.body.name ?? 'Shared project').slice(0, 200), mainFile: typeof req.body.mainFile === 'string' ? safeName(req.body.mainFile) : 'main.tex', files, created: Date.now() };
    const shareId = crypto.randomUUID();
    if (persistence.mode === 'neon-r2') await persistence.putShare(shareId, snapshot);
    else { await fs.mkdir(path.join(DATA, 'shares'), { recursive: true }); await fs.writeFile(path.join(DATA, 'shares', `${shareId}.json`), JSON.stringify(snapshot)); }
    res.status(201).json({ id: shareId });
  } catch (e) { send(res, 400, e); }
});

app.get('/api/shares/:shareId', async (req, res) => {
  try {
    const shareId = String(req.params.shareId);
    if (!/^[0-9a-f-]{36}$/i.test(shareId)) return void send(res, 404, 'This link is invalid.');
    const snapshot = persistence.mode === 'neon-r2' ? await persistence.getShare(shareId) : JSON.parse(await fs.readFile(path.join(DATA, 'shares', `${shareId}.json`), 'utf8'));
    res.json(snapshot);
  } catch { send(res, 404, 'This shared project no longer exists.'); }
});

app.get('/api/projects/:id/download', async (req, res) => {
  try {
    const p = await readProject(req.params.id, projectOwner(res));
    const filename = p.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.zip"`);
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.pipe(res);
    for (const file of p.files) {
      const name = safeName(file.name);
      if (file.name.endsWith('/')) archive.append('', { name: name.endsWith('/') ? name : `${name}/` });
      else archive.append(toBuffer(file), { name });
    }
    await archive.finalize();
  } catch (e) { send(res, 404, e); }
});

/** One compile at a time on the server (Render's free instance has 512 MB); others wait their turn. */
const compileQueue: (() => void)[] = [];
let compileBusy = false;
function compileSlot(signal: AbortSignal, waitMs = 90_000) {
  return new Promise<() => void>((resolve, reject) => {
    const release = () => { compileBusy = false; compileQueue.shift()?.(); };
    // A request the browser already abandoned must not take a turn (and delay everyone behind it).
    if (signal.aborted) return reject(new Error('cancelled'));
    if (!compileBusy) { compileBusy = true; return resolve(release); }
    const timer = setTimeout(() => { remove(); reject(new Error('The compile server is busy. Try again in a moment.')); }, waitMs);
    const start = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); compileBusy = true; resolve(release); };
    const remove = () => { const i = compileQueue.indexOf(start); if (i >= 0) compileQueue.splice(i, 1); };
    const cancel = () => { clearTimeout(timer); remove(); reject(new Error('cancelled')); };
    signal.addEventListener('abort', cancel, { once: true });
    compileQueue.push(start);
  });
}

/** Running compiles by project, so a newer compile (or the browser going away) stops a stale one. */
const RUNNING = new Map<string, { cancel: () => void; done: Promise<unknown> }>();
/** Saves of compile results still in flight, by project; SyncTeX waits for one before reading storage. */
const PERSISTING = new Map<string, Promise<unknown>>();
const BOOT_ID = crypto.randomUUID();
const workspaces = new Workspaces(os.tmpdir(), Number(process.env.COMPILE_WORKSPACES ?? 8));
/** The last PDF and SyncTeX data per project, so the preview and SyncTeX don't wait for object storage. */
const ARTIFACTS = new Map<string, { pdf: Buffer; synctex: Buffer | null; workspace: string; at: number }>();
const ARTIFACT_LIMIT = 6;
function rememberArtifacts(key: string, value: { pdf: Buffer; synctex: Buffer | null; workspace: string }) {
  ARTIFACTS.delete(key);
  ARTIFACTS.set(key, { ...value, at: Date.now() });
  while (ARTIFACTS.size > ARTIFACT_LIMIT) ARTIFACTS.delete(ARTIFACTS.keys().next().value!);
}

/** Gives files written by the API (as root) to the sandbox user that runs TeX. */
async function chownForSandbox(root: string, names: string[]) {
  const seen = new Set<string>();
  for (const name of names) {
    let rel = name.replace(/\/$/, '');
    while (rel && rel !== '.' && !seen.has(rel)) { seen.add(rel); await fs.chown(path.join(root, rel), 65534, 65534).catch(() => undefined); rel = path.posix.dirname(rel); }
  }
}

/**
 * Compiles in a warm per-project folder. Native mode runs TeX as an unprivileged user with resource limits;
 * Docker mode uses a throwaway container with no network and a read-only root.
 * LaTeX errors are a normal result (200 with success:false); 503 means the compiler itself is unavailable.
 * The browser may send only changed files (with hashes for the rest); 409 lists files the server lacks.
 */
app.post('/api/projects/:id/compile', async (req, res) => {
  const started = Date.now();
  const timings: Record<string, number> = {};
  const mark = (name: string, since: number) => { timings[name] = Date.now() - since; };
  const closed = new AbortController();
  res.on('close', () => { if (!res.writableFinished) closed.abort(); });
  let release: (() => void) | null = null;
  let key = '';
  let finished: () => void = () => undefined;
  let entry: { cancel: () => void; done: Promise<unknown> } | null = null;
  let superseded = false;
  let killedWorkspace: Workspace | null = null;
  try {
    const id = String(req.params.id);
    const owner = projectOwner(res);
    projectPath(id);
    key = resultKey(id, owner);
    const files: SourceFile[] = Array.isArray(req.body.files) ? req.body.files : (await readProject(id, owner)).files;
    validateFiles(files.filter(f => f.content !== undefined) as StoredFile[]);
    const engine = String(req.body.engine ?? 'pdflatex');
    if (!ENGINES[engine]) return void send(res, 400, 'Unsupported compiler');
    const mainFile = safeName(String(req.body.mainFile ?? 'main.tex'));
    const timeoutMs = Math.max(5_000, Math.min(MAX_COMPILE_TIMEOUT_MS, Number(req.body.timeoutMs) || COMPILE_TIMEOUT_MS));
    const draft = Boolean(req.body.draft);
    const stopOnFirstError = req.body.stopOnFirstError !== false;
    if (!mainFile.endsWith('.tex')) return void send(res, 400, 'Main file must be a .tex file');
    if (!files.some(f => f.name === mainFile)) return void send(res, 400, `Main file “${mainFile}” not found in the project`);

    // A newer compile of the same project replaces a stale one that is still running or waiting.
    const previous = RUNNING.get(key);
    if (previous) { previous.cancel(); await previous.done.catch(() => undefined); }
    if (closed.signal.aborted) return; // abandoned while the stale compile was stopping
    let cancelRun: () => void = () => undefined;
    const done = new Promise<void>(resolve => { finished = resolve; });
    entry = { cancel: () => { superseded = true; closed.abort(); cancelRun(); }, done };
    RUNNING.set(key, entry);

    let t = Date.now();
    release = await compileSlot(closed.signal);
    if (closed.signal.aborted) return; // abandoned while queued
    mark('queue', t);

    t = Date.now();
    const ws = await workspaces.acquire(`${key}:${engine}`);
    const sync = await syncWorkspace(ws, files, safeName);
    if (sync.missing.length) return void res.status(409).json({ error: 'Some files need to be sent again.', missing: sync.missing, session: BOOT_ID });
    for (const dir of ['tmp', 'texmf-var', 'texmf-config', 'font-cache']) await fs.mkdir(path.join(ws.dir, dir), { recursive: true });
    if (COMPILE_MODE === 'native') {
      if (ws.fresh) await giveCompileFilesToSandboxUser(ws.dir);
      else await chownForSandbox(ws.dir, sync.written);
    }
    mark('sync', t);

    const base = mainFile.replace(/\.tex$/i, '');
    const runTex = (argv: string[]) => runTool(ws.dir, argv, timeoutMs, kill => { cancelRun = kill; });
    const mainSource = await fs.readFile(path.join(ws.dir, mainFile), 'utf8').catch(() => '');
    const fmtKey = engine === 'pdflatex' && !draft ? preambleKey(ws, mainSource) : '';
    let format = fmtKey && ws.format?.key === fmtKey && ws.format.ok ? PREAMBLE_FORMAT : undefined;
    // Fast path: in a warm folder whose last compile succeeded, one direct engine pass is usually enough. Fall back
    // to latexmk when references, the table of contents or the bibliography may need more passes.
    const bibChanged = [...sync.written, ...sync.removed].some(n => /\.(bib|bst|bbx|cbx|bcf)$/i.test(n));
    const fast = !ws.fresh && !draft && !bibChanged && ws.last?.ok === true && ws.last.mainFile === mainFile;
    const auxState = async () => (await Promise.all(['aux', 'toc', 'lof', 'lot', 'out', 'nav', 'snm'].map(ext => fs.readFile(path.join(ws.dir, `${base}.${ext}`)).then(b => crypto.createHash('sha1').update(b).digest('hex'), () => '-')))).join(',');
    let output = '';
    let exitError: any = null;
    let passes = '';
    t = Date.now();
    try {
      let r: TexRun;
      if (fast) {
        const before = await auxState();
        r = await runTex([engine, ...directArgs(engine, mainFile, stopOnFirstError, format)]);
        passes = 'direct';
        const log = await fs.readFile(path.join(ws.dir, base + '.log'), 'utf8').catch(() => '');
        const more = r.code === 0 && !r.killed && (before !== await auxState() || /Rerun to get|Label\(s\) may have changed|Please \(re\)run|run BibTeX|run Biber|Rerun LaTeX/i.test(log));
        if (more && !closed.signal.aborted) { r = await runTex(['latexmk', ...latexmkArgs(engine, mainFile, stopOnFirstError, draft, format)]); passes += '+latexmk'; }
      } else { r = await runTex(['latexmk', ...latexmkArgs(engine, mainFile, stopOnFirstError, draft, format)]); passes = 'latexmk'; }
      // A cached preamble that the document disagrees with must never cost a working compile: retry without it.
      if (format && (r.code !== 0 || r.killed) && !r.killed && !closed.signal.aborted) {
        ws.format = { key: fmtKey, ok: false };
        format = undefined;
        r = await runTex(['latexmk', ...latexmkArgs(engine, mainFile, stopOnFirstError, draft)]);
        passes += '+retry';
      }
      output = r.stdout + '\n' + r.stderr;
      if (r.code !== 0 || r.killed) exitError = { code: r.code, killed: r.killed, reason: r.reason, stdout: r.stdout, stderr: r.stderr };
    } catch (e: any) {
      if (e?.code === 'ENOENT') return void send(res, COMPILE_MODE === 'docker' ? 503 : 503, COMPILE_MODE === 'docker' ? 'Docker isn’t running. Start Docker Desktop, then recompile.' : 'The LaTeX tools are not installed in this service.');
      throw e;
    }
    ws.last = { ok: !exitError, mainFile };
    // A run stopped part-way (by a newer compile or the browser leaving) can leave half-written .aux/.toc files
    // that make the next compile fail; clear them and let the next run go through latexmk from clean state.
    if (closed.signal.aborted && exitError?.killed) killedWorkspace = ws;
    mark('tex', t);
    timings.passes = passes === 'direct' ? 1 : passes.includes('latexmk') ? 2 : 0;
    timings.preamble = format ? 1 : 0;
    if (closed.signal.aborted) return; // superseded or the browser left; answered in finally

    const stderr = String(exitError?.stderr ?? '');
    if (COMPILE_MODE === 'docker' && exitError && (/Cannot connect to the Docker daemon|failed to connect to the docker API|docker.sock/i.test(stderr) || exitError.code === 'ENOENT')) {
      return void send(res, 503, 'Docker isn’t running. Start Docker Desktop, then recompile.');
    }
    if (exitError && /Unable to find image|No such image|pull access denied/i.test(stderr)) {
      return void send(res, 503, `The LaTeX compiler image (${IMAGE}) isn’t built. Run “npm run compiler:build” once, then recompile.`);
    }
    if (exitError?.killed) {
      output += exitError.reason === 'output_limit'
        ? '\nCompilation stopped because the output exceeded the 4 MB limit.'
        : `\nCompilation timed out after ${Math.round(timeoutMs / 1000)} seconds.`;
      // A run killed half way can leave broken auxiliary files; start clean next time.
      await workspaces.drop(ws.key);
    }

    t = Date.now();
    const texLog = await fs.readFile(path.join(ws.dir, base + '.log'), 'utf8').catch(() => '');
    const blg = await fs.readFile(path.join(ws.dir, base + '.blg'), 'utf8').catch(() => '');
    const parsed = parseLatexLog(texLog, blg, mainFile);
    const pdf = exitError?.killed ? null : await fs.readFile(path.join(ws.dir, base + '.pdf')).catch(() => null);
    const success = !exitError && !!pdf;
    if (!success && !parsed.errors.length) {
      parsed.errors.push({ file: mainFile, line: null, message: exitError?.reason === 'output_limit' ? 'Compiler output exceeded the 4 MB limit.' : exitError?.killed ? 'Compilation timed out.' : 'Compilation failed. See the full log for details.' });
    }
    const log = [texLog || output, blg && `\n──── BibTeX (${base}.blg) ────\n${blg}`, texLog && `\n──── latexmk ────\n${output}`].filter(Boolean).join('\n');
    const result: CompileResult = { success, log, errors: parsed.errors, warnings: parsed.warnings, durationMs: Date.now() - started };
    RESULTS.set(key, result);
    const synctex = success && !draft ? await fs.readFile(path.join(ws.dir, base + '.synctex.gz')).catch(() => null) : null;
    if (pdf && success && !draft) rememberArtifacts(key, { pdf, synctex, workspace: ws.key });
    mark('read', t);
    timings.total = Date.now() - started;
    res.setHeader('Server-Timing', Object.entries(timings).map(([name, ms]) => `${name};dur=${ms}`).join(', '));
    // The PDF travels with the result so the preview needs no second request.
    res.json({ ...result, session: BOOT_ID, timings, ...(pdf && success && pdf.length <= 8 * 1024 * 1024 ? { pdf: pdf.toString('base64') } : {}) });
    io.to(id).emit('compile:complete', { success });

    // Save the source snapshot, PDF and SyncTeX data after answering: waiting for storage added 1.5–3 s to every
    // compile on Render. SyncTeX normally reads the warm folder; when it has to rebuild from storage (after a
    // process restart) it first waits for a save still in flight for this project (see PERSISTING).
    if (pdf && success && !draft) {
      const sources = files.every(file => file.content !== undefined) ? files : null;
      const saving = (async () => {
        // A new browser project can compile before its debounced autosave reaches the API. Keep the exact
        // successful source snapshot with the PDF so a cold instance can reconstruct a SyncTeX workspace.
        if (sources) await writeProject(id, { name: String(req.body.name ?? 'Untitled Project'), mainFile, files: sources.map(file => ({ name: file.name, content: file.content ?? '', ...(file.encoding ? { encoding: file.encoding } : {}) })) }, { replace: true }, owner);
        await storeArtifacts(id, owner, pdf, synctex);
      })().catch(error => console.error('Saving the compile source, PDF and SyncTeX files failed:', error));
      PERSISTING.set(key, saving);
      void saving.finally(() => { if (PERSISTING.get(key) === saving) PERSISTING.delete(key); });
    }

    if (success && fmtKey && ws.format?.key !== fmtKey) void buildPreambleFormat(ws, mainFile, fmtKey).catch(error => console.error('Building the preamble format failed:', error));
  } catch (e) {
    if (closed.signal.aborted || (e instanceof Error && e.message === 'cancelled')) return; // answered in finally
    send(res, e instanceof Error && /busy/.test(e.message) ? 429 : 400, e);
  } finally {
    if (killedWorkspace) { await clearBuildProducts(killedWorkspace).catch(() => undefined); killedWorkspace.last = undefined; }
    // A compile replaced by a newer one still gets an answer, so the request doesn't hang until the proxy times out.
    if (superseded && !res.headersSent && !res.writableEnded) res.status(410).json({ error: 'Replaced by a newer compile.', superseded: true });
    release?.();
    finished();
    // Only clear our own entry; a newer compile may already have replaced it.
    if (entry && RUNNING.get(key) === entry) RUNNING.delete(key);
  }
});

/** Removes auxiliary build files (not sources, the PDF or the cached preamble) from a warm folder. */
async function clearBuildProducts(ws: Workspace) {
  const AUX = /\.(aux|toc|lof|lot|out|nav|snm|vrb|fls|fdb_latexmk|bbl|blg|bcf|run\.xml|log|synctex\.gz|synctex\(busy\))$/i;
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await fs.readdir(path.join(ws.dir, rel), { withFileTypes: true }).catch(() => [])) {
      const name = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) { if (!['tmp', 'texmf-var', 'texmf-config', 'font-cache'].includes(name)) await walk(name); }
      else if (AUX.test(entry.name) && !ws.hashes.has(name)) await fs.rm(path.join(ws.dir, name), { force: true });
    }
  };
  await walk('');
}

type TexRun = { stdout: string; stderr: string; killed: boolean; reason?: 'timeout' | 'output_limit'; code: number | null };

/** Runs a TeX tool in the build folder: as the sandbox user natively, or in a throwaway container with Docker. */
async function runTool(dir: string, argv: string[], timeoutMs: number, onStart?: (kill: () => void) => void): Promise<TexRun> {
  if (COMPILE_MODE === 'native') return runNativeCompiler(dir, argv, timeoutMs, onStart);
  const container = `paperdesk-compile-${crypto.randomUUID()}`;
  const args = ['run', '--rm', '--name', container, '--network=none', '--memory=1g', '--cpus=2', '--pids-limit=256',
    '--security-opt=no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,nosuid,exec,size=256m',
    // Run as the host user so output files in the bind mount aren't owned by root on Linux hosts.
    ...(process.getuid && process.getgid ? ['--user', `${process.getuid()}:${process.getgid()}`] : []),
    '-e', 'HOME=/tmp', '-e', 'TEXMFVAR=/tmp/texmf-var', '-e', 'TEXMFCONFIG=/tmp/texmf-config',
    '-v', `${dir}:/work:rw`, '-w', '/work', IMAGE, ...argv];
  let killed = false;
  onStart?.(() => { killed = true; void exec('docker', ['rm', '-f', container]).catch(() => undefined); });
  try {
    const r = await exec('docker', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    return { stdout: r.stdout, stderr: r.stderr, killed, code: 0 };
  } catch (e: any) {
    if (e?.killed || e?.signal) { killed = true; await exec('docker', ['rm', '-f', container]).catch(() => undefined); }
    if (e?.code === 'ENOENT' || /Cannot connect to the Docker daemon|failed to connect to the docker API|docker.sock/i.test(String(e?.stderr))) throw Object.assign(new Error('docker'), { code: 'ENOENT' });
    return { stdout: String(e?.stdout ?? ''), stderr: String(e?.stderr ?? ''), killed, reason: killed ? 'timeout' : undefined, code: typeof e?.code === 'number' ? e.code : 1 };
  }
}

/**
 * Precompiles the preamble (everything before \begin{document}) into a format with mylatexformat, so later pdfLaTeX
 * passes skip loading the packages. Runs after the response, holding the compile slot; used only while the preamble
 * and its local files are unchanged.
 */
async function buildPreambleFormat(ws: Workspace, mainFile: string, key: string) {
  const release = await compileSlot(new AbortController().signal).catch(() => null);
  if (!release) return;
  try {
    if (workspaces.peek(ws.key) !== ws || ws.format?.key === key) return;
    const r = await runTool(ws.dir, ['pdftex', '-ini', '-interaction=nonstopmode', '-halt-on-error', `-jobname=${PREAMBLE_FORMAT}`, '&pdflatex', 'mylatexformat.ltx', mainFile], 60_000);
    const built = await fs.access(path.join(ws.dir, `${PREAMBLE_FORMAT}.fmt`)).then(() => true, () => false);
    ws.format = { key, ok: r.code === 0 && !r.killed && built };
  } finally { release(); }
}

async function storeArtifacts(id: string, owner: string, pdf: Buffer, synctex: Buffer | null) {
  if (persistence.mode === 'neon-r2') {
    await persistence.putArtifact(id, owner, 'compiled.pdf', pdf);
    if (synctex) await persistence.putArtifact(id, owner, 'synctex.gz', synctex);
    return;
  }
  const stored = path.join(projectPath(id), 'compiled.pdf');
  await fs.mkdir(path.dirname(stored), { recursive: true });
  await fs.writeFile(stored, pdf);
}

app.get('/api/projects/:id/pdf', async (req, res) => {
  try {
    projectPath(req.params.id);
    const cached = ARTIFACTS.get(resultKey(req.params.id, projectOwner(res)));
    const pdf = cached?.pdf ?? (persistence.mode === 'neon-r2' ? await persistence.getArtifact(req.params.id, projectOwner(res), 'compiled.pdf') : await fs.readFile(path.join(projectPath(req.params.id), 'compiled.pdf')));
    res.type('application/pdf').send(pdf);
  } catch { send(res, 404, 'No compiled PDF exists yet'); }
});

app.post('/api/projects/:id/synctex', async (req, res) => {
  let temporaryRoot = '';
  let syncLockKey = '';
  let endTurn: () => void = () => undefined;
  const turn = new Promise<void>(resolve => { endTurn = resolve; });
  let queued: Promise<void> | null = null;
  try {
    const id = String(req.params.id);
    const owner = projectOwner(res);
    projectPath(id);
    syncLockKey = resultKey(id, owner);
    const previous = SYNCING.get(syncLockKey) ?? Promise.resolve();
    queued = previous.then(() => turn);
    SYNCING.set(syncLockKey, queued);
    await previous;
    let syncRoot = path.join(projectPath(id), 'synctex');
    const mainFile = safeName(String(req.body.mainFile ?? 'main.tex'));
    if (!mainFile.endsWith('.tex')) return void send(res, 400, 'Main document must be a .tex file');
    const pdfFile = mainFile.replace(/\.tex$/i, '.pdf');
    const mode = String(req.body.mode ?? '');
    let syncCoordinates: string;
    let sourceFile = '';
    if (mode === 'forward') {
      sourceFile = safeName(String(req.body.file ?? ''));
      const line = Number(req.body.line), column = Number(req.body.column ?? 1);
      if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) return void send(res, 400, 'A valid source line and column are required');
      syncCoordinates = `${line}:${column}`;
    } else if (mode === 'inverse') {
      const page = Number(req.body.page), x = Number(req.body.x), y = Number(req.body.y);
      if (!Number.isInteger(page) || page < 1 || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 100_000 || Math.abs(y) > 100_000) return void send(res, 400, 'A valid PDF page and position are required');
      syncCoordinates = `${page}:${x}:${y}`;
    } else return void send(res, 400, 'SyncTeX mode must be forward or inverse');

    // The last compile's warm folder already holds the sources, the PDF and its SyncTeX data.
    // A compile still running for this project is rewriting the SyncTeX file; wait for it rather than read half of it.
    await RUNNING.get(syncLockKey)?.done.catch(() => undefined);
    // Prefer the folder of the last answered compile, then any other warm folder of this project that has
    // SyncTeX data (a compile whose answer the browser abandoned still leaves a usable folder behind).
    const hasSyncData = (dir: string) => fs.access(path.join(dir, pdfFile.replace(/\.pdf$/i, '.synctex.gz'))).then(() => true, () => false);
    const cached = ARTIFACTS.get(syncLockKey);
    let warm = cached ? workspaces.peek(cached.workspace) : undefined;
    if (!warm || !await hasSyncData(warm.dir)) {
      warm = undefined;
      for (const candidate of workspaces.forProject(`${syncLockKey}:`)) if (await hasSyncData(candidate.dir)) { warm = candidate; break; }
    }
    const warmReady = !!warm;
    // Rebuilding from storage: make sure the latest compile's save has finished first.
    if (!(warm && warmReady)) await PERSISTING.get(syncLockKey);
    if (warm && warmReady) syncRoot = warm.dir;
    else if (COMPILE_MODE === 'native') {
      const project = await readProject(id, owner);
      temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'paperdesk-sync-'));
      syncRoot = temporaryRoot;
      for (const file of project.files) {
        const name = safeName(file.name), target = path.join(syncRoot, name);
        if (file.name.endsWith('/')) await fs.mkdir(target, { recursive: true });
        else { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, toBuffer(file)); }
      }
      const pdf = persistence.mode === 'neon-r2'
        ? await persistence.getArtifact(id, owner, 'compiled.pdf')
        : await fs.readFile(path.join(projectPath(id), 'compiled.pdf'));
      const syncFile = pdfFile.replace(/\.pdf$/i, '.synctex.gz');
      const synctex = persistence.mode === 'neon-r2'
        ? await persistence.getArtifact(id, owner, 'synctex.gz')
        : await fs.readFile(path.join(projectPath(id), 'synctex', syncFile));
      await fs.mkdir(path.dirname(path.join(syncRoot, pdfFile)), { recursive: true });
      await fs.writeFile(path.join(syncRoot, pdfFile), pdf);
      await fs.writeFile(path.join(syncRoot, syncFile), synctex);
    } else if (persistence.mode === 'neon-r2') {
      const project = await readProject(id, owner);
      temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'paperdesk-sync-'));
      syncRoot = temporaryRoot;
      for (const file of project.files) {
        const name = safeName(file.name), target = path.join(syncRoot, name);
        if (file.name.endsWith('/')) await fs.mkdir(target, { recursive: true });
        else { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, toBuffer(file)); }
      }
      const pdf = await persistence.getArtifact(id, owner, 'compiled.pdf');
      const synctex = await persistence.getArtifact(id, owner, 'synctex.gz');
      await fs.mkdir(path.dirname(path.join(syncRoot, pdfFile)), { recursive: true });
      await fs.writeFile(path.join(syncRoot, pdfFile), pdf);
      await fs.writeFile(path.join(syncRoot, pdfFile.replace(/\.pdf$/i, '.synctex.gz')), synctex);
    }
    await fs.access(path.join(syncRoot, pdfFile));
    await fs.access(path.join(syncRoot, pdfFile.replace(/\.pdf$/i, '.synctex.gz')));
    const sourceRoot = COMPILE_MODE === 'native' ? syncRoot : '/work';
    const args = mode === 'forward'
      ? ['view', '-i', `${syncCoordinates}:${COMPILE_MODE === 'native' ? `${sourceRoot}/./${sourceFile}` : `${sourceRoot}/${sourceFile}`}`, '-o', `${sourceRoot}/${pdfFile}`]
      : ['edit', '-o', `${syncCoordinates}:${sourceRoot}/${pdfFile}`];
    let output = '';
    try {
      if (COMPILE_MODE === 'native') {
        // One retry: a compile that started after the wait above may have replaced the file mid-read.
        const result = await exec('synctex', args, { cwd: syncRoot, timeout: SYNCTEX_TIMEOUT_MS, maxBuffer: 1024 * 1024 })
          .catch(async () => { await new Promise(r => setTimeout(r, 400)); await RUNNING.get(syncLockKey)?.done.catch(() => undefined); return exec('synctex', args, { cwd: syncRoot, timeout: SYNCTEX_TIMEOUT_MS, maxBuffer: 1024 * 1024 }); });
        output = result.stdout;
      } else {
        const containerArgs = ['run', '--rm', '--network=none', '--memory=256m', '--cpus=1', '--pids-limit=64',
          '--security-opt=no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=16m',
          ...(process.getuid && process.getgid ? ['--user', `${process.getuid()}:${process.getgid()}`] : []),
          '-e', 'HOME=/tmp', '-v', `${syncRoot}:/work:ro`, '-w', '/work', IMAGE, 'synctex', ...args];
        const result = await exec('docker', containerArgs, { timeout: 10_000, maxBuffer: 1024 * 1024 });
        output = result.stdout;
      }
    }
    catch { return void send(res, 503, 'SyncTeX lookup failed. Recompile the project and try again.'); }
    if (mode === 'forward') {
      const position = parseForwardSync(output);
      return void res.json(position ? { found: true, ...position } : { found: false });
    }
    const position = parseInverseSync(output, sourceRoot);
    if (!position || !await fs.access(path.join(syncRoot, position.file)).then(() => true, () => false)) return void res.json({ found: false });
    res.json({ found: true, ...position });
  } catch (e) {
    // Nothing compiled is stored yet (for example, the first compile's save hasn't happened): not a client error.
    if (e instanceof Error && /specified key does not exist|NoSuchKey|ENOENT|Project not found/i.test(e.message)) return void res.json({ found: false, recompile: true });
    send(res, 400, e);
  }
  finally {
    if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    endTurn();
    if (syncLockKey && SYNCING.get(syncLockKey) === queued) SYNCING.delete(syncLockKey);
  }
});

app.delete('/api/projects/:id/cache', async (req, res) => {
  try {
    projectPath(req.params.id);
    if (persistence.mode === 'neon-r2') await persistence.deleteArtifacts(req.params.id, projectOwner(res));
    else { await fs.rm(path.join(projectPath(req.params.id), 'compiled.pdf'), { force: true }); await fs.rm(path.join(projectPath(req.params.id), 'synctex'), { recursive: true, force: true }); }
    const key = resultKey(req.params.id, projectOwner(res));
    RESULTS.delete(key); ARTIFACTS.delete(key); await workspaces.dropProject(`${key}:`);
    res.status(204).end();
  } catch (e) { send(res, 400, e); }
});

app.get('/api/projects/:id/logs', (req, res) => {
  const result = RESULTS.get(resultKey(req.params.id, projectOwner(res)));
  res.json(result ? { ...result } : { success: null, log: '', errors: [], warnings: [], durationMs: 0 });
});

io.on('connection', socket => {
  socket.on('project:join', (id: string) => { if (typeof id === 'string' && /^[\w-]+$/.test(id)) socket.join(id); });
  socket.on('project:leave', (id: string) => socket.leave(id));
});

app.use((_req, res) => send(res, 404, 'Not found'));
// Body-parser failures (too large, malformed JSON) as JSON instead of Express's HTML error page.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = Number(err?.status ?? err?.statusCode) || 500;
  if (status >= 500) console.error(err);
  send(res, status, status === 413 ? 'The request is too large.' : status === 400 ? 'The request body isn’t valid JSON.' : 'Internal server error');
});

await persistence.initialize();
if (COMPILE_MODE === 'native') {
  const required = ['latexmk', 'pdflatex', 'xelatex', 'lualatex', 'bibtex', 'biber', 'synctex', 'setpriv', 'prlimit'] as const;
  const checks = await Promise.all(required.map(command => exec(command, ['--version'], { timeout: 8_000 }).then(() => true, () => false)));
  nativeCompilerReady = checks.every(Boolean);
}
http.listen(PORT, '0.0.0.0', () => console.log(`PaperDesk API listening on port ${PORT} (${persistence.mode} storage, ${COMPILE_MODE} compiler)`));
