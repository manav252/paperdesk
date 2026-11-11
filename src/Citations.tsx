import { useMemo, useState } from 'react';
import { AlertCircle, TriangleAlert } from 'lucide-react';
import { bibKeys } from './lib/bibtex';

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
type Found = { input: string; ok: boolean; key?: string; bibtex?: string; error?: string };
const NEW_FILE = 'references.bib';

/** Add citations from DOIs, doi.org links or arXiv ids (one per line): look up, review and edit, then insert. */
export function CitationDialog({ bibFiles, canCite, apiFetch, onAdd, close }: {
  bibFiles: { name: string; content: string }[]; canCite: boolean; apiFetch: Fetcher;
  onAdd: (entries: string[], citeKeys: string[], target: string, cite: boolean) => void; close: () => void;
}) {
  const [input, setInput] = useState('');
  const [state, setState] = useState<{ busy?: boolean; error?: string }>({});
  const [found, setFound] = useState<Found[]>([]);
  const [texts, setTexts] = useState<Record<number, string>>({});
  const [target, setTarget] = useState(bibFiles[0]?.name ?? NEW_FILE);
  const [cite, setCite] = useState(canCite);
  const existing = useMemo(() => new Set(bibKeys(bibFiles.find(f => f.name === target)?.content ?? '')), [bibFiles, target]);

  const lookUp = async () => {
    const ids = input.split('\n').map(line => line.trim()).filter(Boolean);
    if (!ids.length) { setState({ error: 'Paste a DOI, a doi.org link or an arXiv ID.' }); return; }
    setState({ busy: true });
    try {
      const response = await apiFetch('/api/citations/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) { setState({ error: data?.error ?? 'The lookup service answered with an error. Try again in a moment.' }); return; }
      setFound(data.results);
      setTexts(Object.fromEntries((data.results as Found[]).map((r, i) => [i, r.bibtex ?? ''])));
      setState({});
    } catch { setState({ error: navigator.onLine === false ? 'You’re offline. Connect to the internet and try again.' : 'The lookup service couldn’t be reached. Check your connection and try again.' }); }
  };

  // Keys as they are now, after any edits; a key already in the file (or repeated here) is cited but not added twice.
  const seen = new Set<string>();
  const rows = found.map((result, i) => {
    const key = result.ok ? bibKeys(texts[i] ?? '')[0] : undefined;
    const duplicate = !!key && (existing.has(key) || seen.has(key));
    if (key) seen.add(key);
    return { result, i, key, duplicate, invalid: result.ok && !key };
  });
  const usable = rows.filter(r => r.result.ok && r.key);
  const adding = usable.filter(r => !r.duplicate);
  const add = () => { onAdd(adding.map(r => texts[r.i]!), usable.map(r => r.key!), target, cite && canCite); close(); };

  return <div className="settings-body citations">
    <label className="citations-label" htmlFor="citation-ids">DOIs, doi.org links or arXiv IDs, one per line</label>
    <textarea id="citation-ids" className="text-input citations-input" rows={3} value={input} onChange={e => setInput(e.target.value)} placeholder={'10.1038/s41586-020-2649-2\narXiv:1706.03762'} spellCheck={false} />
    <div className="citations-row"><button className="btn btn-primary btn-sm" onClick={() => void lookUp()} disabled={state.busy}>{state.busy ? 'Looking up…' : 'Look up'}</button></div>
    {state.error && <div className="inline-alert error" role="alert"><AlertCircle size={15} /><span>{state.error}</span></div>}
    {rows.map(({ result, i, key, duplicate, invalid }) => result.ok
      ? <div className="citation-entry" key={i}>
        <textarea className="text-input citation-preview" aria-label={`BibTeX entry for ${result.input}`} rows={Math.min(14, (texts[i] ?? '').split('\n').length + 1)} value={texts[i] ?? ''} onChange={e => setTexts(t => ({ ...t, [i]: e.target.value }))} spellCheck={false} />
        {duplicate && <p className="citation-note" role="status"><TriangleAlert size={13} /> The key <code>{key}</code> is already in {target}. It will be cited, not added again; change the key to add it as a new entry.</p>}
        {invalid && <p className="citation-note" role="alert"><TriangleAlert size={13} /> This entry has no citation key, so it will be skipped.</p>}
      </div>
      : <div className="inline-alert error" role="alert" key={i}><AlertCircle size={15} /><span><strong>{result.input}</strong>: {result.error}</span></div>)}
    {usable.length > 0 && <>
      <div className="field-row"><div><strong>Add to</strong><span>The .bib file that receives the entries.</span></div>
        <select className="select" aria-label="Bibliography file" value={target} onChange={e => setTarget(e.target.value)}>{bibFiles.map(f => <option key={f.name}>{f.name}</option>)}{!bibFiles.some(f => f.name === NEW_FILE) && <option value={NEW_FILE}>New file: {NEW_FILE}</option>}</select></div>
      <label className="citations-check"><input type="checkbox" checked={cite && canCite} disabled={!canCite} onChange={e => setCite(e.target.checked)} /> Insert <code>\cite{'{'}{usable.map(r => r.key).join(',')}{'}'}</code> at the cursor{!canCite && ' (open a .tex file to use this)'}</label>
    </>}
    <div className="modal-foot"><button className="btn btn-secondary" onClick={close}>Cancel</button><button className="btn btn-primary" disabled={!usable.length} onClick={add}>{adding.length ? `Add ${adding.length} ${adding.length === 1 ? 'citation' : 'citations'}` : 'Cite'}</button></div>
  </div>;
}
