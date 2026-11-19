/**
 * The live preview: Typst documents compile in the browser as you type. The compiler runs in a worker
 * (src/typst.worker.ts); this module decides what to send it and turns its answers into the editor's diagnostics.
 */
import type { LogEntry } from './latexLog';
import type { ProjectFile } from './project';

export type LiveDiagnostic = { package?: string; path: string; range: string; severity: string; message: string };
export type WorkerRequest =
  | { type: 'init'; fontsUrl: string }
  | {
      type: 'compile';
      id: number;
      main: string;
      reset: boolean;
      /** Recompile: drop everything the compiler cached, not only its files. */
      fresh?: boolean;
      sources: { path: string; content: string }[];
      binaries: { path: string; bytes: Uint8Array }[];
      removed: string[];
    };
export type WorkerResponse =
  | { type: 'result'; id: number; pdf: Uint8Array | null; diagnostics: LiveDiagnostic[]; ms: number }
  | { type: 'failed'; id: number; error: string };

/** Pause after the last keystroke before compiling. */
export const LIVE_DELAY_MS = 200;

/** Which languages compile live. LaTeX could join by getting a browser compiler and an entry here. */
export const LIVE_LANGUAGES = new Set(['typst']);

const hash = (file: ProjectFile) => `${file.encoding ?? 'text'}:${file.content.length}:${simpleHash(file.content)}`;
function simpleHash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
function base64Bytes(content: string) {
  const binary = atob(content);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * What changed since the files last sent to the compiler: text files to (re)add, binary files such as images to
 * (re)map, and paths to drop. `sent` is updated to the new state.
 */
export function changedFiles(files: ProjectFile[], sent: Map<string, string>) {
  const sources: { path: string; content: string }[] = [];
  const binaries: { path: string; bytes: Uint8Array }[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (file.name.endsWith('/')) continue;
    const path = `/${file.name}`;
    seen.add(path);
    const now = hash(file);
    if (sent.get(path) === now) continue;
    sent.set(path, now);
    if (file.encoding === 'base64') binaries.push({ path, bytes: base64Bytes(file.content) });
    else sources.push({ path, content: file.content });
  }
  const removed = [...sent.keys()].filter((path) => !seen.has(path));
  for (const path of removed) sent.delete(path);
  return { sources, binaries, removed };
}

/** The compiler's diagnostics as the editor's errors and warnings, with one-based lines. Hints join their error. */
export function liveDiagnostics(entries: LiveDiagnostic[], mainFile: string) {
  const errors: LogEntry[] = [],
    warnings: LogEntry[] = [];
  let last: LogEntry | null = null;
  for (const entry of entries) {
    const inProject = !entry.package && entry.path.startsWith('/');
    const line = Number(/^(\d+):/.exec(entry.range)?.[1]);
    const item: LogEntry = {
      file: inProject ? entry.path.slice(1) : mainFile,
      line: inProject && Number.isFinite(line) ? line + 1 : null,
      message: inProject ? entry.message : `${entry.message} (in ${entry.package || entry.path})`,
    };
    if (entry.severity === 'hint') {
      if (last) last.message += ` (hint: ${entry.message})`;
      continue;
    }
    (entry.severity === 'error' ? errors : warnings).push(item);
    last = item;
  }
  return { errors, warnings };
}

/**
 * Runs compiles one at a time and only ever the newest: a request made while one is running waits, replacing any
 * other waiting request, and a result that is older than the newest edit is reported as stale.
 */
export class LiveCompiler {
  private worker: Worker | null = null;
  private sent = new Map<string, string>();
  /** The project and main file the compiler holds; a different one starts from an empty file set. */
  private scope = '';
  private nextId = 1;
  private running: { id: number; done: (r: WorkerResponse) => void } | null = null;
  private waiting: {
    files: ProjectFile[];
    main: string;
    scope: string;
    fresh: boolean;
    resolve: (r: LiveOutcome | null) => void;
  } | null = null;
  latest = 0;

  constructor(
    private create: () => Worker,
    private fontsUrl: string,
  ) {}

  private start() {
    if (this.worker) return this.worker;
    const worker = this.create();
    worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      if (this.running?.id === data.id) this.running.done(data);
    };
    worker.postMessage({ type: 'init', fontsUrl: this.fontsUrl } satisfies WorkerRequest);
    this.worker = worker;
    return worker;
  }

  /**
   * Compiles these files of one project (`project` names it), or resolves to null if a newer request replaced this
   * one before it started.
   */
  compile(files: ProjectFile[], main: string, project = '', fresh = false): Promise<LiveOutcome | null> {
    this.latest = this.nextId++;
    const requested = this.latest;
    const scope = `${project}|${main}`;
    if (this.running) {
      // A waiting fresh compile stays fresh even if a normal one replaces it.
      fresh ||= this.waiting?.fresh ?? false;
      this.waiting?.resolve(null);
      return new Promise((resolve) => (this.waiting = { files, main, scope, fresh, resolve }));
    }
    return this.run(files, main, scope, requested, fresh);
  }

  private async run(
    files: ProjectFile[],
    main: string,
    scope: string,
    id: number,
    fresh = false,
  ): Promise<LiveOutcome> {
    const worker = this.start();
    const reset = fresh || (this.scope !== '' && this.scope !== scope);
    if (reset) this.sent.clear();
    this.scope = scope;
    const changes = changedFiles(files, this.sent);
    const response = await new Promise<WorkerResponse>((done) => {
      this.running = { id, done };
      worker.postMessage(
        { type: 'compile', id, main: `/${main}`, reset, fresh, ...changes } satisfies WorkerRequest,
        changes.binaries.map((b) => b.bytes.buffer),
      );
    });
    this.running = null;
    const waiting = this.waiting;
    this.waiting = null;
    if (waiting)
      void this.run(waiting.files, waiting.main, waiting.scope, this.latest, waiting.fresh).then(waiting.resolve);
    if (response.type === 'failed') {
      // A crashed compiler loses its files: send everything again next time.
      this.sent.clear();
      return { id, stale: id !== this.latest, error: response.error };
    }
    return { id, stale: id !== this.latest, pdf: response.pdf, diagnostics: response.diagnostics, ms: response.ms };
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.sent.clear();
    this.scope = '';
  }
}
export type LiveOutcome = {
  id: number;
  stale: boolean;
  pdf?: Uint8Array | null;
  diagnostics?: LiveDiagnostic[];
  ms?: number;
  error?: string;
};

export type CompileMode = 'auto' | 'manual';
/**
 * How a file compiles: `auto` (live preview as you type) or `manual` (only Recompile, Ctrl/Cmd+S or Ctrl/Cmd+Enter).
 * The single place this is decided. `.tex` files are always manual. `.typ` files, and the other files of a Typst
 * project (images, bibliographies, data), are auto, since editing them changes the Typst preview.
 */
export function getCompileMode(fileName: string | undefined, mainFile: string): CompileMode {
  if (fileName && /\.(tex|sty|cls|ltx|bbl)$/i.test(fileName)) return 'manual';
  const language = /\.typ$/i.test(mainFile) ? 'typst' : 'latex';
  return LIVE_LANGUAGES.has(language) && (!fileName || !/\.typ$/i.test(fileName) || language === 'typst')
    ? 'auto'
    : 'manual';
}
