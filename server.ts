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
const COMPILING = new Set<string>();
const SYNCING = new Set<string>();
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

function nativeCompilePath(id: string, owner: string) {
  const scope = persistence.mode === 'neon-r2' ? `${owner}/${id}` : id;
  const suffix = crypto.createHash('sha256').update(scope).digest('hex').slice(0, 24);
  return path.join(os.tmpdir(), `paperdesk-compile-${suffix}`);
}

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
    const current = await persistence.read(id, owner).catch(() => null);
    const files = p.files ?? current?.files ?? [];
    validateFiles(files);
    return persistence.write(id, owner, { ...p, files });
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

function latexmkArgs(engine: string, mainFile: string, stopOnFirstError: boolean, draft: boolean) {
  const command = engine === 'pdflatex' ? '$pdflatex = "pdflatex -no-shell-escape %O %S";'
    : engine === 'xelatex' ? '$xelatex = "xelatex -no-shell-escape %O %S";'
      : '$lualatex = "lualatex -no-shell-escape %O %S";';
  return [ENGINES[engine]!, '-e', command, '-synctex=1', '-interaction=nonstopmode', '-file-line-error', ...(stopOnFirstError ? ['-halt-on-error'] : []), ...(draft ? ['-draftmode'] : []), '-norc', mainFile];
}

/** Starts a process group so timeout cleanup also kills TeX and bibliography children. */
function runNativeCompiler(cwd: string, args: string[], timeoutMs: number) {
  return new Promise<{ stdout: string; stderr: string; killed: boolean; reason?: 'timeout' | 'output_limit'; code: number | null }>((resolve, reject) => {
    const memoryBytes = Math.max(192, COMPILE_MEMORY_MB) * 1024 * 1024;
    const safeEnv = {
      PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: cwd, TMPDIR: path.join(cwd, 'tmp'),
      TEXMFVAR: path.join(cwd, 'texmf-var'), TEXMFCONFIG: path.join(cwd, 'texmf-config'),
      FONTCONFIG_CACHE: path.join(cwd, 'font-cache'),
    };
    const child = spawn('setpriv', ['--reuid=65534', '--regid=65534', '--clear-groups', '--bounding-set=-all', '--', 'prlimit', `--as=${memoryBytes}`, '--cpu=120', '--nproc=64', '--fsize=52428800', '--nofile=128', '--', 'latexmk', ...args], {
      cwd, env: safeEnv,
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
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
    const current = await readProject(req.params.id, projectOwner(res)).catch(() => null);
    const files = Array.isArray(req.body.files) ? req.body.files : current?.files ?? [];
    res.json(await writeProject(req.params.id, { name: req.body.name ?? current?.name, files, mainFile: req.body.mainFile ?? current?.mainFile, archived: req.body.archived ?? current?.archived, settings: req.body.settings ?? current?.settings, versions: req.body.versions ?? current?.versions, comments: req.body.comments ?? current?.comments, changes: req.body.changes ?? current?.changes }, { replace: Array.isArray(req.body.files) }, projectOwner(res)));
  } catch (e) { send(res, 400, e); }
});

app.delete('/api/projects/:id', async (req, res) => {
  try {
    projectPath(req.params.id);
    if (persistence.mode === 'neon-r2') await persistence.delete(req.params.id, projectOwner(res));
    else await fs.rm(projectPath(req.params.id), { recursive: true, force: true });
    RESULTS.delete(resultKey(req.params.id, projectOwner(res)));
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

/**
 * Compiles in a throwaway container: no network, read-only root, resource limits.
 * LaTeX errors are a normal result (200 with success:false); 503 means the compiler itself is unavailable.
 */
app.post('/api/projects/:id/compile', async (req, res) => {
  let tmp = '';
  const container = `paperdesk-compile-${crypto.randomUUID()}`;
  const started = Date.now();
  let compileId = '';
  try {
    const id = String(req.params.id);
    const owner = projectOwner(res);
    projectPath(id);
    compileId = id;
    if (COMPILING.has(id) || COMPILING.size >= 1) return void send(res, 429, 'A compile is already running. Try again when it finishes.');
    COMPILING.add(id);
    // A new browser-only project can reach Compile before its debounced save.
    // Prefer the submitted source; only require a stored project when no files
    // were included. In Neon/R2 mode, register the project so its source and
    // artifacts remain available after the compile request completes.
    const submittedFiles: StoredFile[] | null = Array.isArray(req.body.files) ? req.body.files : null;
    let currentProject = persistence.mode === 'neon-r2' && !submittedFiles ? await readProject(id, owner) : null;
    const files: StoredFile[] = submittedFiles ?? (currentProject ?? await readProject(id, owner)).files;
    validateFiles(files);
    const engine = String(req.body.engine ?? 'pdflatex');
    if (!ENGINES[engine]) return void send(res, 400, 'Unsupported compiler');
    const mainFile = safeName(String(req.body.mainFile ?? 'main.tex'));
    const timeoutMs = Math.max(5_000, Math.min(MAX_COMPILE_TIMEOUT_MS, Number(req.body.timeoutMs) || COMPILE_TIMEOUT_MS));
    const draft = Boolean(req.body.draft);
    const stopOnFirstError = req.body.stopOnFirstError !== false;
    if (!mainFile.endsWith('.tex')) return void send(res, 400, 'Main file must be a .tex file');
    if (!files.some(f => f.name === mainFile)) return void send(res, 400, `Main file “${mainFile}” not found in the project`);
    if (persistence.mode === 'neon-r2' && submittedFiles) {
      currentProject = await writeProject(id, {
        name: String(req.body.name ?? currentProject?.name ?? 'Untitled Project'),
        files,
        mainFile,
        settings: req.body.settings,
        versions: req.body.versions,
        comments: req.body.comments,
        changes: req.body.changes,
      }, { replace: true }, owner);
    }

    if (COMPILE_MODE === 'native') {
      tmp = nativeCompilePath(id, owner);
      await fs.rm(tmp, { recursive: true, force: true });
      await fs.mkdir(tmp, { recursive: true, mode: 0o755 });
    } else tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'paperdesk-'));
    await fs.chmod(tmp, 0o755);
    await fs.mkdir(path.join(tmp, 'tmp'), { recursive: true });
    await fs.mkdir(path.join(tmp, 'texmf-var'), { recursive: true });
    await fs.mkdir(path.join(tmp, 'texmf-config'), { recursive: true });
    await fs.mkdir(path.join(tmp, 'font-cache'), { recursive: true });
    for (const f of files) {
      const name = safeName(String(f.name));
      if (f.name.endsWith('/')) { await fs.mkdir(path.join(tmp, name), { recursive: true }); continue; }
      const target = path.join(tmp, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, toBuffer(f));
    }

    const texArgs = latexmkArgs(engine, mainFile, stopOnFirstError, draft);

    let output = '';
    let exitError: any = null;
    if (COMPILE_MODE === 'native') {
      try {
        await giveCompileFilesToSandboxUser(tmp);
        const r = await runNativeCompiler(tmp, texArgs, timeoutMs);
        output = r.stdout + '\n' + r.stderr;
        if (r.code !== 0 || r.killed) exitError = { code: r.code, killed: r.killed, reason: r.reason, stdout: r.stdout, stderr: r.stderr };
      } catch (e: any) {
        if (e?.code === 'ENOENT') return void send(res, 503, 'The LaTeX tools are not installed in this service.');
        throw e;
      }
    } else {
      const args = ['run', '--rm', '--name', container, '--network=none', '--memory=1g', '--cpus=2', '--pids-limit=256',
        '--security-opt=no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,nosuid,exec,size=256m',
        // Run as the host user so output files in the bind mount aren't owned by root on Linux hosts.
        ...(process.getuid && process.getgid ? ['--user', `${process.getuid()}:${process.getgid()}`] : []),
        '-e', 'HOME=/tmp', '-e', 'TEXMFVAR=/tmp/texmf-var', '-e', 'TEXMFCONFIG=/tmp/texmf-config',
        '-v', `${tmp}:/work:rw`, '-w', '/work', IMAGE, 'latexmk', ...texArgs];
      try {
        const r = await exec('docker', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
        output = r.stdout + '\n' + r.stderr;
      } catch (e: any) {
        exitError = e;
        output = [e.stdout, e.stderr].filter(Boolean).join('\n');
      }
    }

    const stderr = String(exitError?.stderr ?? '');
    if (COMPILE_MODE === 'docker' && exitError && (/Cannot connect to the Docker daemon|failed to connect to the docker API|docker.sock/i.test(stderr) || exitError.code === 'ENOENT')) {
      return void send(res, 503, 'Docker isn’t running. Start Docker Desktop, then recompile.');
    }
    if (exitError && /Unable to find image|No such image|pull access denied/i.test(stderr)) {
      return void send(res, 503, `The LaTeX compiler image (${IMAGE}) isn’t built. Run “npm run compiler:build” once, then recompile.`);
    }
    if (exitError?.killed) {
      if (COMPILE_MODE === 'docker') await exec('docker', ['rm', '-f', container]).catch(() => undefined);
      output += exitError.reason === 'output_limit'
        ? '\nCompilation stopped because the output exceeded the 4 MB limit.'
        : `\nCompilation timed out after ${Math.round(timeoutMs / 1000)} seconds.`;
    }

    const base = mainFile.replace(/\.tex$/i, '');
    const texLog = await fs.readFile(path.join(tmp, base + '.log'), 'utf8').catch(() => '');
    const blg = await fs.readFile(path.join(tmp, base + '.blg'), 'utf8').catch(() => '');
    const parsed = parseLatexLog(texLog, blg, mainFile);
    const pdf = await fs.readFile(path.join(tmp, base + '.pdf')).catch(() => null);
    const success = !exitError && !!pdf;
    if (!success && !parsed.errors.length) {
      parsed.errors.push({ file: mainFile, line: null, message: exitError?.reason === 'output_limit' ? 'Compiler output exceeded the 4 MB limit.' : exitError?.killed ? 'Compilation timed out.' : 'Compilation failed. See the full log for details.' });
    }
    const log = [texLog || output, blg && `\n──── BibTeX (${base}.blg) ────\n${blg}`, texLog && `\n──── latexmk ────\n${output}`].filter(Boolean).join('\n');
    const result: CompileResult = { success, log, errors: parsed.errors, warnings: parsed.warnings, durationMs: Date.now() - started };
    RESULTS.set(resultKey(id, owner), result);
    if (pdf && success && !draft) {
      const syncFile = path.join(tmp, base + '.synctex.gz');
      if (persistence.mode === 'neon-r2') {
        await persistence.putArtifact(id, owner, 'compiled.pdf', pdf);
        if (await fs.access(syncFile).then(() => true, () => false)) await persistence.putArtifact(id, owner, 'synctex.gz', await fs.readFile(syncFile));
      } else {
        const stored = path.join(projectPath(id), 'compiled.pdf');
        await fs.mkdir(path.dirname(stored), { recursive: true });
        await fs.writeFile(stored, pdf);
      }
      if (persistence.mode === 'local' && await fs.access(syncFile).then(() => true, () => false)) {
        const syncRoot = path.join(projectPath(id), 'synctex');
        await fs.rm(syncRoot, { recursive: true, force: true });
        await fs.mkdir(syncRoot, { recursive: true });
        for (const f of files) {
          const name = safeName(String(f.name));
          const target = path.join(syncRoot, name);
          if (f.name.endsWith('/')) await fs.mkdir(target, { recursive: true });
          else { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, toBuffer(f)); }
        }
        await fs.copyFile(path.join(tmp, base + '.pdf'), path.join(syncRoot, base + '.pdf'));
        await fs.copyFile(syncFile, path.join(syncRoot, base + '.synctex.gz'));
      }
    }
    io.to(id).emit('compile:complete', { success });
    res.json(result);
  } catch (e) {
    send(res, 400, e);
  } finally {
    if (compileId) COMPILING.delete(compileId);
    if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
});

app.get('/api/projects/:id/pdf', async (req, res) => {
  try {
    projectPath(req.params.id);
    const pdf = persistence.mode === 'neon-r2' ? await persistence.getArtifact(req.params.id, projectOwner(res), 'compiled.pdf') : await fs.readFile(path.join(projectPath(req.params.id), 'compiled.pdf'));
    res.type('application/pdf').send(pdf);
  } catch { send(res, 404, 'No compiled PDF exists yet'); }
});

app.post('/api/projects/:id/synctex', async (req, res) => {
  let temporaryRoot = '';
  let syncLockKey = '';
  try {
    const id = String(req.params.id);
    const owner = projectOwner(res);
    projectPath(id);
    if (COMPILING.has(id)) return void send(res, 429, 'SyncTeX is unavailable while the project is compiling.');
    syncLockKey = resultKey(id, owner);
    if (SYNCING.has(syncLockKey)) return void send(res, 429, 'A SyncTeX lookup is already running.');
    SYNCING.add(syncLockKey);
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

    if (COMPILE_MODE === 'native') {
      const project = await readProject(id, owner);
      temporaryRoot = nativeCompilePath(id, owner);
      await fs.rm(temporaryRoot, { recursive: true, force: true });
      await fs.mkdir(temporaryRoot, { recursive: true, mode: 0o755 });
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
        const result = await exec('synctex', args, { cwd: syncRoot, timeout: 8_000, maxBuffer: 1024 * 1024 });
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
  } catch (e) { send(res, 400, e); }
  finally {
    if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    if (syncLockKey) SYNCING.delete(syncLockKey);
  }
});

app.delete('/api/projects/:id/cache', async (req, res) => {
  try {
    projectPath(req.params.id);
    if (persistence.mode === 'neon-r2') await persistence.deleteArtifacts(req.params.id, projectOwner(res));
    else { await fs.rm(path.join(projectPath(req.params.id), 'compiled.pdf'), { force: true }); await fs.rm(path.join(projectPath(req.params.id), 'synctex'), { recursive: true, force: true }); }
    RESULTS.delete(resultKey(req.params.id, projectOwner(res))); res.status(204).end();
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
