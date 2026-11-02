import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import multer from 'multer';
import unzipper from 'unzipper';
import archiver from 'archiver';
import { parseLatexLog, type LogEntry } from './src/lib/latexLog';

const exec = promisify(execFile);
const app = express();
const http = createServer(app);
const io = new Server(http, { cors: { origin: true } });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const PORT = Number(process.env.PORT ?? 3001);
const DATA = path.resolve(process.env.PAPERDESK_DATA ?? './backend/storage');
const PROJECTS = path.join(DATA, 'projects');
const IMAGE = process.env.LATEX_DOCKER_IMAGE ?? 'paperdesk-texlive:latest';
const COMPILE_TIMEOUT_MS = Number(process.env.COMPILE_TIMEOUT_MS ?? 120_000);
/** latexmk flag per engine. Bare `-pdflatex` is not a valid latexmk switch. */
const ENGINES: Record<string, string> = { pdflatex: '-pdf', xelatex: '-xelatex', lualatex: '-lualatex' };
/** Files returned to the client as base64; everything else is UTF-8 text. */
const BINARY = /\.(png|jpe?g|gif|bmp|tiff?|pdf|eps|ps|zip|gz|ttf|otf|woff2?)$/i;

type StoredFile = { name: string; content: string; encoding?: 'base64' };
type CompileResult = { success: boolean; log: string; errors: LogEntry[]; warnings: LogEntry[]; durationMs: number };
const RESULTS = new Map<string, CompileResult>();

app.use(express.json({ limit: '25mb' }));
app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

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

async function readProject(id: string) {
  const dir = projectPath(id);
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'project.json'), 'utf8'));
  const files = await walkFiles(path.join(dir, 'files'));
  return { ...meta, files } as { id: string; name: string; modified: number; files: StoredFile[] };
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
async function writeProject(id: string, p: { name?: string; files?: StoredFile[] }, { replace = false } = {}) {
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
  const meta = { id, name: p.name ?? 'Untitled Project', modified: Date.now() };
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(meta));
  return readProject(id);
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

const send = (res: express.Response, status: number, error: unknown) => res.status(status).json({ error: error instanceof Error ? error.message : String(error) });

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

app.get('/api/health', async (_req, res) => {
  const status = await dockerStatus();
  res.json({ ok: true, ...status, compilerImage: IMAGE });
});

app.get('/api/projects', async (_req, res) => {
  try {
    await fs.mkdir(PROJECTS, { recursive: true });
    const ids = await fs.readdir(PROJECTS);
    const records = [];
    for (const id of ids) {
      try { records.push(await readProject(id)); } catch { /* skip unreadable project folders */ }
    }
    res.json(records);
  } catch (e) { send(res, 500, e); }
});

app.post('/api/projects', async (req, res) => {
  try {
    const id = typeof req.body.id === 'string' && /^[\w-]+$/.test(req.body.id) ? req.body.id : crypto.randomUUID();
    res.status(201).json(await writeProject(id, { name: String(req.body.name ?? 'Untitled Project'), files: req.body.files ?? [] }, { replace: true }));
  } catch (e) { send(res, 400, e); }
});

app.get('/api/projects/:id', async (req, res) => {
  try { res.json(await readProject(req.params.id)); } catch { send(res, 404, 'Project not found'); }
});

/** Saves a project; creates it if it doesn't exist yet. A `files` list replaces the stored files. */
app.put('/api/projects/:id', async (req, res) => {
  try {
    const current = await readProject(req.params.id).catch(() => null);
    const files = Array.isArray(req.body.files) ? req.body.files : current?.files ?? [];
    res.json(await writeProject(req.params.id, { name: req.body.name ?? current?.name, files }, { replace: Array.isArray(req.body.files) }));
  } catch (e) { send(res, 400, e); }
});

app.delete('/api/projects/:id', async (req, res) => {
  try {
    await fs.rm(projectPath(req.params.id), { recursive: true, force: true });
    RESULTS.delete(req.params.id);
    res.status(204).end();
  } catch (e) { send(res, 400, e); }
});

app.get('/api/projects/:id/files', async (req, res) => {
  try { res.json((await readProject(req.params.id)).files); } catch { send(res, 404, 'Project not found'); }
});

app.post('/api/projects/:id/files', async (req, res) => {
  try {
    const p = await readProject(req.params.id);
    const name = safeName(String(req.body.name ?? ''));
    if (p.files.some(f => f.name === name)) return void send(res, 409, 'File already exists');
    const result = await writeProject(req.params.id, { ...p, files: [{ name, content: req.body.content ?? '', encoding: req.body.encoding === 'base64' ? 'base64' : undefined }] });
    res.status(201).json(result.files.find(f => f.name === name));
  } catch (e) { send(res, 400, e); }
});

app.put('/api/projects/:id/files/:fileId', async (req, res) => {
  try {
    const p = await readProject(req.params.id);
    const name = safeName(decodeURIComponent(req.params.fileId));
    if (!p.files.some(f => f.name === name)) return void send(res, 404, 'File not found');
    await writeProject(req.params.id, { ...p, files: [{ name, content: req.body.content ?? '', encoding: req.body.encoding === 'base64' ? 'base64' : undefined }] });
    res.json({ name });
  } catch (e) { send(res, 400, e); }
});

app.delete('/api/projects/:id/files/:fileId', async (req, res) => {
  try {
    const name = safeName(decodeURIComponent(req.params.fileId));
    await fs.rm(path.join(projectPath(req.params.id), 'files', name), { recursive: true, force: true });
    res.status(204).end();
  } catch (e) { send(res, 400, e); }
});

app.post('/api/projects/:id/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return void send(res, 400, 'ZIP file required');
    const projectId = String(req.params.id);
    const root = path.join(projectPath(projectId), 'files');
    const existing = await readProject(projectId).catch(() => null);
    if (!existing) await writeProject(projectId, { name: req.file.originalname.replace(/\.zip$/i, '') });
    const directory = await unzipper.Open.buffer(req.file.buffer);
    // Strip a single top-level folder (common in exported archives) so main.tex lands at the root.
    const names = directory.files.map((f: any) => String(f.path)).filter((n: string) => !n.startsWith('__MACOSX/'));
    const tops = new Set(names.map((n: string) => n.split('/')[0]));
    const prefix = tops.size === 1 && names.every((n: string) => n.includes('/')) ? [...tops][0] + '/' : '';
    for (const entry of directory.files) {
      if (String(entry.path).startsWith('__MACOSX/')) continue;
      const rel = String(entry.path).slice(prefix.length);
      if (!rel) continue;
      const name = safeName(rel);
      if (entry.type === 'Directory') { await fs.mkdir(path.join(root, name), { recursive: true }); continue; }
      const target = path.join(root, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await pipeline(entry.stream(), createWriteStream(target));
    }
    res.json(await readProject(projectId));
  } catch (e) { send(res, 400, `Unable to import ZIP: ${e instanceof Error ? e.message : String(e)}`); }
});

app.get('/api/projects/:id/download', async (req, res) => {
  try {
    const p = await readProject(req.params.id);
    const root = path.join(projectPath(req.params.id), 'files');
    const filename = p.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.zip"`);
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.pipe(res);
    archive.directory(root, false);
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
  try {
    const id = String(req.params.id);
    projectPath(id);
    const files: StoredFile[] = Array.isArray(req.body.files) ? req.body.files : (await readProject(id)).files;
    const engine = String(req.body.engine ?? 'pdflatex');
    if (!ENGINES[engine]) return void send(res, 400, 'Unsupported compiler');
    const mainFile = safeName(String(req.body.mainFile ?? 'main.tex'));
    if (!mainFile.endsWith('.tex')) return void send(res, 400, 'Main file must be a .tex file');
    if (!files.some(f => f.name === mainFile)) return void send(res, 400, `Main file “${mainFile}” not found in the project`);

    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'paperdesk-'));
    for (const f of files) {
      const name = safeName(String(f.name));
      if (f.name.endsWith('/')) { await fs.mkdir(path.join(tmp, name), { recursive: true }); continue; }
      const target = path.join(tmp, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, toBuffer(f));
    }

    const args = ['run', '--rm', '--name', container, '--network=none', '--memory=1g', '--cpus=2', '--pids-limit=256',
      '--security-opt=no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=256m',
      // Run as the host user so output files in the bind mount aren't owned by root on Linux hosts.
      ...(process.getuid && process.getgid ? ['--user', `${process.getuid()}:${process.getgid()}`] : []),
      '-e', 'HOME=/tmp', '-e', 'TEXMFVAR=/tmp/texmf-var', '-e', 'TEXMFCONFIG=/tmp/texmf-config',
      '-v', `${tmp}:/work:rw`, '-w', '/work', IMAGE,
      'latexmk', ENGINES[engine], '-interaction=nonstopmode', '-file-line-error', '-halt-on-error', '-norc', mainFile];

    let output = '';
    let exitError: any = null;
    try {
      const r = await exec('docker', args, { timeout: COMPILE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
      output = r.stdout + '\n' + r.stderr;
    } catch (e: any) {
      exitError = e;
      output = [e.stdout, e.stderr].filter(Boolean).join('\n');
    }

    const stderr = String(exitError?.stderr ?? '');
    if (exitError && (/Cannot connect to the Docker daemon|failed to connect to the docker API|docker.sock/i.test(stderr) || exitError.code === 'ENOENT')) {
      return void send(res, 503, 'Docker isn’t running. Start Docker Desktop, then recompile.');
    }
    if (exitError && /Unable to find image|No such image|pull access denied/i.test(stderr)) {
      return void send(res, 503, `The LaTeX compiler image (${IMAGE}) isn’t built. Run “npm run compiler:build” once, then recompile.`);
    }
    if (exitError?.killed) {
      await exec('docker', ['rm', '-f', container]).catch(() => undefined);
      output += `\nCompilation timed out after ${Math.round(COMPILE_TIMEOUT_MS / 1000)} seconds.`;
    }

    const base = mainFile.replace(/\.tex$/i, '');
    const texLog = await fs.readFile(path.join(tmp, base + '.log'), 'utf8').catch(() => '');
    const blg = await fs.readFile(path.join(tmp, base + '.blg'), 'utf8').catch(() => '');
    const parsed = parseLatexLog(texLog, blg, mainFile);
    const pdf = await fs.readFile(path.join(tmp, base + '.pdf')).catch(() => null);
    const success = !exitError && !!pdf;
    if (!success && !parsed.errors.length) {
      parsed.errors.push({ file: mainFile, line: null, message: exitError?.killed ? 'Compilation timed out.' : 'Compilation failed. See the full log for details.' });
    }
    const log = [texLog || output, blg && `\n──── BibTeX (${base}.blg) ────\n${blg}`, texLog && `\n──── latexmk ────\n${output}`].filter(Boolean).join('\n');
    const result: CompileResult = { success, log, errors: parsed.errors, warnings: parsed.warnings, durationMs: Date.now() - started };
    RESULTS.set(id, result);
    if (pdf && success) {
      const stored = path.join(projectPath(id), 'compiled.pdf');
      await fs.mkdir(path.dirname(stored), { recursive: true });
      await fs.writeFile(stored, pdf);
    }
    io.to(id).emit('compile:complete', { success });
    res.json(result);
  } catch (e) {
    send(res, 400, e);
  } finally {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
});

app.get('/api/projects/:id/pdf', async (req, res) => {
  try { res.type('application/pdf').send(await fs.readFile(path.join(projectPath(req.params.id), 'compiled.pdf'))); } catch { send(res, 404, 'No compiled PDF exists yet'); }
});

app.get('/api/projects/:id/logs', (req, res) => {
  const result = RESULTS.get(req.params.id);
  res.json(result ? { ...result } : { success: null, log: '', errors: [], warnings: [], durationMs: 0 });
});

io.on('connection', socket => {
  socket.on('project:join', (id: string) => { if (typeof id === 'string' && /^[\w-]+$/.test(id)) socket.join(id); });
  socket.on('project:leave', (id: string) => socket.leave(id));
});

app.use((_req, res) => send(res, 404, 'Not found'));

http.listen(PORT, () => console.log(`PaperDesk API listening at http://localhost:${PORT}`));
