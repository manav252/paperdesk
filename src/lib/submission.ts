// Checks a project before it is submitted to arXiv or a journal, and prepares the files for export.
// Everything here is pure: the editor runs it on the open project, the API uses the same rules when it builds a ZIP.
import type { LogEntry } from './latexLog';

export type SubmissionFile = { name: string; content: string; encoding?: string };
export type FontInfo = { name: string; embedded: boolean };
export type IssueKind =
  | 'log-error' | 'log-warning' | 'undefined-reference' | 'undefined-citation' | 'multiply-defined'
  | 'missing-file' | 'unused-file' | 'unused-bib-entry' | 'large-image' | 'font-not-embedded'
  | 'absolute-path' | 'non-ascii-name' | 'build-file' | 'not-compiled' | 'fonts-unchecked';
export type Fix =
  | { type: 'delete-files'; files: string[]; label: string }
  | { type: 'remove-bib-entry'; file: string; key: string; label: string }
  | { type: 'ascii-names'; label: string };
export type Issue = { kind: IssueKind; severity: 'error' | 'warning' | 'info'; message: string; file?: string; line?: number; fix?: Fix };
export type CompileFacts = { success: boolean | null; errors: LogEntry[]; warnings: LogEntry[] };

/** Images larger than this are reported: arXiv and most journals ask for small figures. */
export const IMAGE_LIMIT_BYTES = 5 * 1024 * 1024;
/** Files a compile leaves behind, which don't belong in a submission. (.bbl is kept: arXiv needs it.) */
export const BUILD_FILE = /\.(aux|log|out|toc|lof|lot|fls|fdb_latexmk|synctex\.gz|synctex|blg|bcf|run\.xml|nav|snm|vrb|idx|ilg|ind|xdv)$|(^|\/)\.DS_Store$|(^|\/)Thumbs\.db$/i;
const IMAGE = /\.(png|jpe?g|gif|bmp|tiff?|eps|pdf|svg)$/i;
const GRAPHIC_EXTENSIONS = ['', '.pdf', '.png', '.jpg', '.jpeg', '.eps'];
/** Files that are fine to leave in a project without being used by the document. */
const HARMLESS = /(^|\/)(readme[^/]*|license[^/]*|\.gitignore|\.latexmkrc|latexmkrc)$/i;
const ABSOLUTE = /^(\/|~|[A-Za-z]:[\\/])/;
const NON_ASCII = /[^\x20-\x7E]/;

const isFolder = (name: string) => name.endsWith('/');
const isText = (f: SubmissionFile) => f.encoding !== 'base64';
const bytes = (f: SubmissionFile) => f.encoding === 'base64' ? Math.floor(f.content.length * 3 / 4) : new TextEncoder().encode(f.content).length;
const megabytes = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const dirOf = (name: string) => name.includes('/') ? name.slice(0, name.lastIndexOf('/') + 1) : '';
/** Removes a comment from one line of LaTeX (a % that isn't escaped). */
const uncomment = (line: string) => line.replace(/(^|[^\\])%.*$/, '$1');
/** Joins a path written in the document onto the folder the main file is in. */
function resolve(root: string, written: string) {
  const parts: string[] = [];
  for (const part of `${root}${written.trim()}`.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

type Location = { file: string; line: number };
type Use = Location & { key: string };
type FileUse = Location & { written: string; kind: 'graphic' | 'input' | 'bib' | 'other' };
type Scan = {
  reachable: string[];
  labels: Use[]; refs: Use[]; cites: Use[]; bibitems: Use[]; fileUses: FileUse[];
  used: Set<string>; bibFiles: string[]; missing: FileUse[]; absolute: FileUse[]; citesEverything: boolean;
};

/** Reads the main file and everything it \input's: which labels, references, citations and files the document uses. */
export function scanProject(files: SubmissionFile[], mainFile: string): Scan {
  const byName = new Map(files.filter(f => !isFolder(f.name)).map(f => [f.name, f]));
  const root = dirOf(mainFile);
  const scan: Scan = { reachable: [], labels: [], refs: [], cites: [], bibitems: [], fileUses: [], used: new Set(), bibFiles: [], missing: [], absolute: [], citesEverything: false };
  const graphicsPaths = [''];
  const queue = [mainFile];
  const find = (written: string, extensions: string[], folders = ['']) => {
    for (const folder of folders) for (const extension of extensions) {
      const candidate = resolve(root, `${folder}${written}${extension}`);
      if (byName.has(candidate)) return candidate;
    }
    return null;
  };
  const use = (entry: FileUse, extensions: string[], folders?: string[]) => {
    if (/[#\\]/.test(entry.written)) return null; // built from a macro: can't be resolved here
    scan.fileUses.push(entry);
    if (ABSOLUTE.test(entry.written)) { scan.absolute.push(entry); return null; }
    const found = find(entry.written, extensions, folders);
    if (found) scan.used.add(found); else scan.missing.push(entry);
    return found;
  };
  while (queue.length) {
    const name = queue.shift()!, file = byName.get(name);
    if (!file || !isText(file) || scan.reachable.includes(name)) continue;
    scan.reachable.push(name);
    scan.used.add(name);
    file.content.split('\n').forEach((raw, index) => {
      const text = uncomment(raw), at = { file: name, line: index + 1 };
      const each = (pattern: RegExp, visit: (m: RegExpExecArray) => void) => { for (const m of text.matchAll(pattern)) visit(m as RegExpExecArray); };
      const keys = (list: string) => list.split(',').map(k => k.trim()).filter(Boolean);
      each(/\\label\{([^}]+)\}/g, m => scan.labels.push({ ...at, key: m[1]!.trim() }));
      each(/\\(?:ref|eqref|pageref|autoref|nameref|vref|cref|Cref|cpageref)\*?\{([^}]+)\}/g, m => keys(m[1]!).forEach(key => scan.refs.push({ ...at, key })));
      each(/\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\]){0,2}\{([^}]*)\}/g, m => keys(m[1]!).forEach(key => { if (key === '*') scan.citesEverything = true; else scan.cites.push({ ...at, key }); }));
      each(/\\bibitem(?:\[[^\]]*\])?\{([^}]+)\}/g, m => scan.bibitems.push({ ...at, key: m[1]!.trim() }));
      each(/\\graphicspath\{((?:\{[^}]*\})+)\}/g, m => { for (const p of m[1]!.matchAll(/\{([^}]*)\}/g)) graphicsPaths.push(p[1]!.endsWith('/') || !p[1] ? p[1]! : `${p[1]}/`); });
      each(/\\includegraphics\*?(?:\[[^\]]*\])?\{([^}]+)\}/g, m => use({ ...at, written: m[1]!, kind: 'graphic' }, GRAPHIC_EXTENSIONS, graphicsPaths));
      each(/\\(?:input|include|subfile)\{([^}]+)\}/g, m => { const found = use({ ...at, written: m[1]!, kind: 'input' }, ['', '.tex']); if (found) queue.push(found); });
      each(/\\bibliography\{([^}]+)\}/g, m => keys(m[1]!).forEach(written => { const found = use({ ...at, written, kind: 'bib' }, ['', '.bib']); if (found) scan.bibFiles.push(found); }));
      each(/\\addbibresource(?:\[[^\]]*\])?\{([^}]+)\}/g, m => { const found = use({ ...at, written: m[1]!, kind: 'bib' }, ['', '.bib']); if (found) scan.bibFiles.push(found); });
      each(/\\(?:lstinputlisting|verbatiminput|includepdf|includesvg|pgfimage)\*?(?:\[[^\]]*\])?\{([^}]+)\}/g, m => use({ ...at, written: m[1]!, kind: 'other' }, ['', '.pdf', '.svg']));
      // Local classes, packages and bibliography styles count as used; ones from the TeX system aren't in the project.
      const local = (list: string, extension: string) => keys(list).forEach(written => { const found = find(written, [extension]); if (found) scan.used.add(found); });
      each(/\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}/g, m => local(m[1]!, '.cls'));
      each(/\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{([^}]+)\}/g, m => local(m[1]!, '.sty'));
      each(/\\bibliographystyle\{([^}]+)\}/g, m => local(m[1]!, '.bst'));
    });
  }
  // A .bbl next to the main file is the bibliography arXiv compiles with.
  const bbl = mainFile.replace(/\.tex$/i, '.bbl');
  if (byName.has(bbl)) scan.used.add(bbl);
  return scan;
}

/** Entries of a .bib file with where each one starts. */
export function bibEntries(bib: string) {
  const entries: { key: string; index: number; line: number }[] = [];
  for (const m of bib.matchAll(/@(\w+)\s*\{\s*([^,\s{}]+)\s*,/g)) {
    if (/^(comment|string|preamble)$/i.test(m[1]!)) continue;
    entries.push({ key: m[2]!, index: m.index!, line: bib.slice(0, m.index!).split('\n').length });
  }
  return entries;
}

/** Removes one entry (from its @ to its closing brace) from a .bib file. */
export function removeBibEntry(bib: string, key: string) {
  const entry = bibEntries(bib).find(e => e.key === key);
  if (!entry) return bib;
  let depth = 0, end = entry.index;
  for (let i = bib.indexOf('{', entry.index); i < bib.length; i++) {
    if (bib[i] === '{') depth++;
    else if (bib[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  if (end === entry.index) return bib; // unbalanced braces: leave the file alone
  const before = bib.slice(0, entry.index).replace(/\s+$/, ''), after = bib.slice(end).replace(/^\s+/, '');
  return before && after ? `${before}\n\n${after}` : before ? `${before}\n` : after;
}

/** An ASCII version of a path: accents are dropped, anything else outside ASCII becomes a hyphen. */
export function asciiName(name: string, taken: Set<string> = new Set()) {
  const special: Record<string, string> = { ß: 'ss', æ: 'ae', ø: 'o', đ: 'd', ł: 'l', Æ: 'AE', Ø: 'O', Đ: 'D', Ł: 'L' };
  const clean = (text: string) => text.replace(/[ßæøđłÆØĐŁ]/g, c => special[c]!).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').trim() || 'file';
  const parts = name.split('/'), last = parts.pop()!;
  const extension = /(\.[A-Za-z0-9]+)+$/.exec(last)?.[0] ?? '';
  const folder = parts.map(part => `${clean(part)}/`).join('');
  const stem = last ? clean(last.slice(0, last.length - extension.length)) : '';
  let candidate = `${folder}${stem}${extension}`, n = 2;
  while (taken.has(candidate)) candidate = `${folder}${stem}-${n++}${extension}`;
  return candidate;
}

/**
 * Every problem worth fixing before submitting. `compile` is the latest compile (null if the project hasn't been
 * compiled) and `fonts` the fonts of its PDF (null if they couldn't be read).
 */
export function checkSubmission(files: SubmissionFile[], mainFile: string, compile: CompileFacts | null, fonts: FontInfo[] | null): Issue[] {
  const issues: Issue[] = [];
  const scan = scanProject(files, mainFile);
  const real = files.filter(f => !isFolder(f.name));

  // The compile log.
  const reported = new Set<string>();
  const labels = new Map<string, Use[]>();
  for (const label of scan.labels) labels.set(label.key, [...(labels.get(label.key) ?? []), label]);
  for (const ref of scan.refs) if (!labels.has(ref.key)) {
    reported.add(`ref:${ref.key}`);
    issues.push({ kind: 'undefined-reference', severity: 'error', message: `Reference “${ref.key}” has no \\label.`, file: ref.file, line: ref.line });
  }
  for (const [key, where] of labels) if (where.length > 1) {
    reported.add(`label:${key}`);
    for (const use of where.slice(1)) issues.push({ kind: 'multiply-defined', severity: 'error', message: `Label “${key}” is defined ${where.length} times (first in ${where[0]!.file}, line ${where[0]!.line}).`, file: use.file, line: use.line });
  }
  const known = new Set(scan.bibitems.map(b => b.key));
  const unusedEntries: { file: string; key: string; line: number }[] = [];
  const cited = new Set(scan.cites.map(c => c.key));
  for (const name of [...new Set(scan.bibFiles)]) {
    const bib = real.find(f => f.name === name)!, seen = new Map<string, number>();
    for (const entry of bibEntries(bib.content)) {
      known.add(entry.key);
      if (seen.has(entry.key)) issues.push({ kind: 'multiply-defined', severity: 'error', message: `Citation key “${entry.key}” is defined more than once (first on line ${seen.get(entry.key)}).`, file: name, line: entry.line });
      else {
        seen.set(entry.key, entry.line);
        if (!cited.has(entry.key) && !scan.citesEverything) unusedEntries.push({ file: name, key: entry.key, line: entry.line });
      }
    }
  }
  for (const cite of scan.cites) if (!known.has(cite.key)) {
    reported.add(`cite:${cite.key}`);
    issues.push({ kind: 'undefined-citation', severity: 'error', message: `Citation “${cite.key}” isn’t in the bibliography.`, file: cite.file, line: cite.line });
  }

  if (!compile || compile.success === null) issues.push({ kind: 'not-compiled', severity: 'info', message: 'The project hasn’t been compiled yet, so the log and the PDF’s fonts weren’t checked. Compile it and check again.' });
  else {
    for (const entry of compile.errors) issues.push({ kind: 'log-error', severity: 'error', message: entry.message, file: entry.file ?? undefined, line: entry.line ?? undefined });
    for (const entry of compile.warnings) {
      const text = entry.message, key = /[`‘'“"]([^'’”"]+)['’”"]/.exec(text)?.[1];
      const location = { file: entry.file ?? undefined, line: entry.line ?? undefined };
      if (/There were (undefined|multiply-defined)|Label\(s\) may have changed|Rerun to get/i.test(text)) continue; // summaries of the ones below
      if (/Reference .*undefined/i.test(text)) { if (!reported.has(`ref:${key}`)) issues.push({ kind: 'undefined-reference', severity: 'error', message: text, ...location }); }
      else if (/Citation .*undefined/i.test(text)) { if (!reported.has(`cite:${key}`)) issues.push({ kind: 'undefined-citation', severity: 'error', message: text, ...location }); }
      else if (/multiply.defined/i.test(text)) { if (!reported.has(`label:${key}`)) issues.push({ kind: 'multiply-defined', severity: 'error', message: text, ...location }); }
      else issues.push({ kind: 'log-warning', severity: 'warning', message: text, ...location });
    }
  }

  // Files the document asks for.
  for (const use of scan.missing) issues.push({ kind: 'missing-file', severity: 'error', message: `${use.kind === 'graphic' ? 'Figure' : use.kind === 'bib' ? 'Bibliography' : 'File'} “${use.written}” isn’t in the project.`, file: use.file, line: use.line });
  for (const use of scan.absolute) issues.push({ kind: 'absolute-path', severity: 'warning', message: `“${use.written}” is an absolute path. It only works on one computer; use a path inside the project.`, file: use.file, line: use.line });

  // Files in the project.
  const builds = real.filter(f => BUILD_FILE.test(f.name) || f.name === mainFile.replace(/\.tex$/i, '.pdf'));
  const deleteBuilds: Fix | undefined = builds.length ? { type: 'delete-files', files: builds.map(f => f.name), label: builds.length > 1 ? `Delete all ${builds.length} build files` : 'Delete file' } : undefined;
  for (const file of builds) issues.push({ kind: 'build-file', severity: 'warning', message: `${file.name} is left over from compiling and shouldn’t be submitted.`, file: file.name, fix: deleteBuilds });
  for (const file of real) {
    if (builds.includes(file)) continue;
    if (NON_ASCII.test(file.name)) issues.push({ kind: 'non-ascii-name', severity: 'warning', message: `${file.name} has characters outside plain ASCII, which arXiv and many journals refuse.`, file: file.name, fix: { type: 'ascii-names', label: 'Rename to plain ASCII' } });
    if (IMAGE.test(file.name) && bytes(file) > IMAGE_LIMIT_BYTES) issues.push({ kind: 'large-image', severity: 'warning', message: `${file.name} is ${megabytes(bytes(file))}; images over ${megabytes(IMAGE_LIMIT_BYTES)} slow down or fail a submission. Compress or resize it.`, file: file.name });
    if (!scan.used.has(file.name) && !HARMLESS.test(file.name)) issues.push({ kind: 'unused-file', severity: 'info', message: `${file.name} isn’t used by ${mainFile}.`, file: file.name, fix: { type: 'delete-files', files: [file.name], label: 'Delete file' } });
  }
  for (const entry of unusedEntries) issues.push({ kind: 'unused-bib-entry', severity: 'info', message: `Bibliography entry “${entry.key}” is never cited.`, file: entry.file, line: entry.line, fix: { type: 'remove-bib-entry', file: entry.file, key: entry.key, label: 'Remove entry' } });

  // The PDF.
  if (compile && compile.success !== null) {
    if (!fonts) issues.push({ kind: 'fonts-unchecked', severity: 'info', message: 'The fonts in the PDF couldn’t be checked.' });
    else for (const font of fonts) if (!font.embedded) issues.push({ kind: 'font-not-embedded', severity: 'warning', message: `Font “${font.name}” isn’t embedded in the PDF. It usually comes from a figure: export that figure again with fonts embedded.` });
  }
  return issues;
}

/** Applies a fix to the project's files and returns the new list. */
export function applyFix(files: SubmissionFile[], fix: Fix): SubmissionFile[] {
  if (fix.type === 'delete-files') return files.filter(f => !fix.files.includes(f.name));
  if (fix.type === 'remove-bib-entry') return files.map(f => f.name === fix.file ? { ...f, content: removeBibEntry(f.content, fix.key) } : f);
  // Rename every path with non-ASCII characters, and point the document at the new names.
  const taken = new Set(files.filter(f => !NON_ASCII.test(f.name)).map(f => f.name));
  const renames: [string, string][] = [];
  const folders = new Map<string, string>();
  const renamed = files.map(f => {
    if (!NON_ASCII.test(f.name)) return f;
    // Folders keep one name for everything inside them.
    const parts = f.name.split('/'), last = parts.pop()!;
    let prefix = '', plainPrefix = '';
    for (const part of parts) {
      prefix += `${part}/`;
      if (!folders.has(prefix)) folders.set(prefix, `${plainPrefix}${asciiName(part)}/`);
      plainPrefix = folders.get(prefix)!;
    }
    const next = last ? asciiName(`${plainPrefix}${last}`, taken) : plainPrefix;
    taken.add(next);
    renames.push([f.name, next]);
    return { ...f, name: next };
  });
  const stem = (name: string) => name.replace(/\.[A-Za-z0-9]+$/, '');
  const pairs = renames.filter(([from]) => !isFolder(from)).flatMap(([from, to]) => [[from, to], [stem(from), stem(to)]] as [string, string][]).sort((a, b) => b[0].length - a[0].length);
  return renamed.map(f => !isText(f) || !/\.(tex|sty|cls)$/i.test(f.name) ? f : { ...f, content: pairs.reduce((text, [from, to]) => text.split(`{${from}}`).join(`{${to}}`), f.content) });
}

/** One .tex file with every \input and \include replaced by the file it names. */
export function flatten(files: SubmissionFile[], mainFile: string) {
  const byName = new Map(files.map(f => [f.name, f]));
  const root = dirOf(mainFile);
  const expand = (name: string, open: string[]): string => {
    const lines = (byName.get(name)?.content ?? '').split('\n'), out: string[] = [];
    for (const raw of lines) {
      const code = uncomment(raw);
      if (/\\endinput\b/.test(code)) { out.push(raw.slice(0, raw.indexOf('\\endinput'))); break; }
      out.push(raw.replace(/\\(input|include)\{([^}#\\]+)\}/g, (whole, command: string, written: string, offset: number) => {
        if (offset >= code.length) return whole; // inside a comment
        const target = ['', '.tex'].map(extension => resolve(root, `${written}${extension}`)).find(candidate => byName.has(candidate) && isText(byName.get(candidate)!));
        if (!target || open.includes(target)) return whole;
        const body = expand(target, [...open, target]).replace(/\n+$/, '');
        return command === 'include' ? `\\clearpage\n${body}\n\\clearpage` : body;
      }));
    }
    return out.join('\n');
  };
  return expand(mainFile, [mainFile]);
}

/** Project files a compile read, from latexmk's .fls recorder file. */
export function parseFls(fls: string) {
  const cwd = /^PWD (.+)$/m.exec(fls)?.[1]?.trim().replace(/\/+$/, '') ?? '';
  const names = new Set<string>();
  for (const m of fls.matchAll(/^INPUT (.+)$/gm)) {
    let name = m[1]!.trim();
    if (cwd && name.startsWith(`${cwd}/`)) name = name.slice(cwd.length + 1);
    else if (name.startsWith('/')) continue; // a file from the TeX system
    names.add(name.replace(/^\.\//, ''));
  }
  return [...names];
}

export type ExportKind = 'arxiv' | 'journal';
/**
 * Which files go into a submission ZIP. `read` is what the compile read (parseFls). arXiv gets only what the
 * document needs plus the .bbl; a journal also gets the bibliography sources.
 */
export function exportFiles(files: SubmissionFile[], mainFile: string, read: string[], kind: ExportKind) {
  const scan = scanProject(files, mainFile), fromCompile = new Set(read);
  return files.filter(f => !isFolder(f.name) && !BUILD_FILE.test(f.name) && !/\.bbl$/i.test(f.name) && f.name !== mainFile.replace(/\.tex$/i, '.pdf'))
    .filter(f => f.name === mainFile || fromCompile.has(f.name) || (scan.used.has(f.name) && (kind === 'journal' || !/\.(bib|bst)$/i.test(f.name))))
    .filter(f => kind === 'journal' || !/\.(bib|bst)$/i.test(f.name))
    .map(f => f.name);
}
