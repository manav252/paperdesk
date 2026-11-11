import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleAlert, FileArchive, FileText, Info, Wrench } from 'lucide-react';
import { loadPdfjs } from './PdfViewer';
import { ownerHeaders } from './lib/api';
import type { LogEntry } from './lib/latexLog';
import { checkSubmission, flatten, type CompileFacts, type ExportKind, type Fix, type FontInfo, type Issue, type SubmissionFile } from './lib/submission';

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
type Props = {
  projectId: string; projectName: string; files: SubmissionFile[]; mainFile: string; engine: string;
  compile: CompileFacts | null; pdfUrl: string; pdfData: Uint8Array | null; canEdit: boolean; compiling: boolean;
  apiFetch: Fetcher; onJump: (file: string, line: number | null) => void; onFix: (fix: Fix) => void; onCompile: () => void;
  download: (blob: Blob, name: string) => void;
};

/** Fonts used on the PDF's pages and whether each one's file is inside the PDF. */
async function readPdfFonts(url: string, data: Uint8Array | null): Promise<FontInfo[]> {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument(data ? { data: data.slice() } : { url, httpHeaders: ownerHeaders() }).promise;
  try {
    const fonts = new Map<string, boolean>();
    for (let n = 1; n <= Math.min(doc.numPages, 80); n++) {
      const page = await doc.getPage(n), ops = await page.getOperatorList();
      ops.fnArray.forEach((fn: number, i: number) => {
        if (fn !== pdfjs.OPS.setFont) return;
        const font = page.commonObjs.get(ops.argsArray[i][0]);
        // Type 3 fonts are drawn by the PDF itself, so there is no font file to embed.
        if (font?.name) fonts.set(font.name, !font.missingFile || font.isType3Font === true || font.type === 'Type3');
      });
      page.cleanup();
    }
    return [...fonts].map(([name, embedded]) => ({ name: name.replace(/^[A-Z]{6}\+/, ''), embedded }));
  } finally { void doc.destroy(); }
}

const GROUPS: { severity: Issue['severity']; title: string }[] = [
  { severity: 'error', title: 'Errors' }, { severity: 'warning', title: 'Warnings' }, { severity: 'info', title: 'Suggestions' },
];
const slug = (name: string) => name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';

/** "Check before submitting": problems in the latest compile and the project's files, with fixes, and the exports. */
export function SubmissionCheck({ projectId, projectName, files, mainFile, engine, compile, pdfUrl, pdfData, canEdit, compiling, apiFetch, onJump, onFix, onCompile, download }: Props) {
  // undefined while the PDF is being read, null when there is no PDF or it can't be read.
  const [fonts, setFonts] = useState<FontInfo[] | null | undefined>(undefined);
  const [exporting, setExporting] = useState<{ kind: ExportKind; error?: string; errors?: LogEntry[]; done?: boolean } | null>(null);
  const hasPdf = !!(pdfUrl || pdfData);
  useEffect(() => {
    let live = true;
    if (!hasPdf) { setFonts(null); return; }
    setFonts(undefined);
    readPdfFonts(pdfUrl, pdfData).then(found => { if (live) setFonts(found); }).catch(() => { if (live) setFonts(null); });
    return () => { live = false; };
  }, [hasPdf, pdfUrl, pdfData]);
  const issues = useMemo(() => checkSubmission(files, mainFile, compile, fonts === undefined ? [] : fonts), [files, mainFile, compile, fonts]);
  const names = useMemo(() => new Set(files.map(f => f.name)), [files]);
  const compiled = !!compile && compile.success !== null;

  const exportZip = async (kind: ExportKind) => {
    setExporting({ kind });
    try {
      const response = await apiFetch(`/api/projects/${projectId}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, engine, mainFile, files: files.filter(f => !f.name.endsWith('/')) }) });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        return void setExporting({ kind, error: data.error ?? 'The export failed.', errors: data.errors });
      }
      download(await response.blob(), `${slug(projectName)}-${kind}.zip`);
      setExporting({ kind, done: true });
    } catch { setExporting({ kind, error: 'The export service could not be reached.' }); }
  };
  const exportFlat = () => download(new Blob([flatten(files, mainFile)], { type: 'text/x-tex' }), `${slug(projectName)}-flattened.tex`);
  const busy = !!exporting && !exporting.error && !exporting.done;
  const location = (file?: string | null, line?: number | null) => file && names.has(file)
    ? <button type="button" className="submission-where" onClick={() => onJump(file, line ?? null)}>{file}{line ? `, line ${line}` : ''}</button>
    : file ? <span className="submission-where plain">{file}{line ? `, line ${line}` : ''}</span> : null;

  return <div className="submission">
    <div className={`submission-summary ${issues.some(i => i.severity === 'error') ? 'bad' : issues.some(i => i.severity === 'warning') ? 'warn' : 'good'}`} role="status" data-testid="submission-summary">
      {issues.length === 0 ? <><CheckCircle2 size={18}/><span><strong>No problems found.</strong> {mainFile} is ready to submit.</span></>
        : <><CircleAlert size={18}/><span><strong>{GROUPS.map(g => [issues.filter(i => i.severity === g.severity).length, g.title.toLowerCase()] as const).filter(([n]) => n).map(([n, title]) => `${n} ${n === 1 ? title.replace(/s$/, '') : title}`).join(', ')}.</strong> {compiled ? 'Checked against the latest compile.' : ''}</span></>}
      {!compiled && <button type="button" className="btn btn-sm btn-secondary" onClick={onCompile} disabled={compiling}>{compiling ? 'Compiling…' : 'Compile now'}</button>}
    </div>
    {compiled && fonts === undefined && <p className="muted submission-note" role="status">Checking the fonts in the PDF…</p>}
    {GROUPS.map(group => {
      const list = issues.filter(i => i.severity === group.severity);
      if (!list.length) return null;
      return <section key={group.severity} className={`submission-group ${group.severity}`} aria-label={group.title}>
        <h3>{group.severity === 'error' ? <CircleAlert size={14}/> : group.severity === 'warning' ? <AlertTriangle size={14}/> : <Info size={14}/>}{group.title}<span className="count-pill">{list.length}</span></h3>
        <ul>{list.map((issue, i) => <li key={`${issue.kind}-${issue.file ?? ''}-${issue.line ?? ''}-${i}`} data-kind={issue.kind}>
          <div className="submission-text"><span>{issue.message}</span>{location(issue.file, issue.line)}</div>
          {issue.fix && canEdit && <button type="button" className="btn btn-sm btn-secondary" onClick={() => onFix(issue.fix!)}><Wrench size={13}/>{issue.fix.label}</button>}
        </li>)}</ul>
      </section>;
    })}
    <section className="submission-export" aria-label="Export">
      <h3>Export for submission</h3>
      <p className="muted">The ZIPs hold only the files {mainFile} needs, with the bibliography (.bbl) and no build files. Each one is compiled on its own on the server first, so you only get a ZIP that builds.</p>
      <div className="submission-buttons">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void exportZip('arxiv')}><FileArchive size={15}/>arXiv ZIP</button>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void exportZip('journal')}><FileArchive size={15}/>Journal ZIP</button>
        <button type="button" className="btn btn-secondary" onClick={exportFlat}><FileText size={15}/>Single .tex file</button>
      </div>
      {busy && <p className="muted submission-note" role="status">Building the {exporting!.kind === 'arxiv' ? 'arXiv' : 'journal'} ZIP and test-compiling it. This can take a minute…</p>}
      {exporting?.done && <p className="submission-note good" role="status"><CheckCircle2 size={14}/>The {exporting.kind === 'arxiv' ? 'arXiv' : 'journal'} ZIP compiled on its own and was downloaded.</p>}
      {exporting?.error && <div className="inline-alert error" role="alert"><div><span>{exporting.error}</span>
        {!!exporting.errors?.length && <ul className="submission-errors">{exporting.errors.map((entry, i) => <li key={i}>{entry.message} {location(entry.file, entry.line)}</li>)}</ul>}
      </div></div>}
    </section>
  </div>;
}
