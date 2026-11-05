import { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import symbolGroups from './lib/symbols.json';
import type { WordCount } from './lib/wordcount';

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
type TextFile = { name: string; content: string; encoding?: 'base64' };
type SymbolEntry = { char: string; command: string; keywords?: string };

/** Counts words with texcount on the server, using the current (possibly uncompiled) text files. */
export function WordCountView({ projectId, files, mainFile, apiFetch }: { projectId: string; files: TextFile[]; mainFile: string; apiFetch: Fetcher }) {
  const [state, setState] = useState<{ count?: WordCount; error?: string }>({});
  // Read once when the dialog opens, like Overleaf; reopening counts again.
  const [body] = useState(() => JSON.stringify({ mainFile, files: files.filter(f => f.encoding !== 'base64' && /\.(tex|bib|sty|cls)$/i.test(f.name)).map(f => ({ name: f.name, content: f.content })) }));
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await apiFetch(`/api/projects/${projectId}/wordcount`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        const data = await response.json();
        if (live) setState(response.ok ? { count: data } : { error: data.error ?? 'Word count failed.' });
      } catch { if (live) setState({ error: 'The word count service could not be reached.' }); }
    })();
    return () => { live = false; };
  }, [apiFetch, projectId, body]);

  if (state.error) return <div className="inline-alert error" role="alert"><span>{state.error}</span></div>;
  if (!state.count) return <p className="muted" role="status">Counting words in {mainFile}…</p>;
  const c = state.count;
  const rows: [string, number][] = [
    ['Words in text', c.text], ['Words in headers', c.headers], ['Words in captions and other text', c.captions],
    ['Headers', c.headerCount], ['Floats, tables and figures', c.floats], ['Inline math', c.mathInline], ['Displayed math', c.mathDisplay],
  ];
  const included = c.files - 1;
  return <div className="wordcount">
    <div className="wordcount-total"><strong data-testid="word-total">{c.total.toLocaleString()}</strong><span>words in {mainFile}{included > 0 ? ` and ${included} included file${included > 1 ? 's' : ''}` : ''}</span></div>
    <table className="wordcount-table"><tbody>{rows.map(([label, value]) => <tr key={label}><th scope="row">{label}</th><td>{value.toLocaleString()}</td></tr>)}</tbody></table>
    <p className="muted">Counted with texcount. Commands, comments and math are not counted as words.</p>
  </div>;
}

const GROUPS = symbolGroups as { name: string; symbols: SymbolEntry[] }[];

/** Docked panel of math symbols; a click inserts the LaTeX command at the cursor. */
export function SymbolPalette({ onInsert, onClose }: { onInsert: (command: string) => void; onClose: () => void }) {
  const [tab, setTab] = useState(GROUPS[0]!.name);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = q
    ? GROUPS.flatMap(g => g.symbols).filter(s => s.command.toLowerCase().includes(q) || s.char === q || (s.keywords ?? '').includes(q))
    : GROUPS.find(g => g.name === tab)!.symbols;
  return <section className="symbol-palette" aria-label="Symbol palette">
    <div className="symbol-head">
      <div className="symbol-tabs" role="tablist" aria-label="Symbol groups">
        {GROUPS.map(g => <button key={g.name} role="tab" aria-selected={!q && tab === g.name} className={!q && tab === g.name ? 'on' : ''} onClick={() => { setTab(g.name); setQuery(''); }}>{g.name}</button>)}
      </div>
      <label className="symbol-search"><Search size={13} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search symbols" aria-label="Search symbols" /></label>
      <button className="icon-btn" aria-label="Close symbol palette" title="Close" onClick={onClose}><X size={14} /></button>
    </div>
    <div className="symbol-grid">
      {shown.length === 0 && <p className="muted">No symbols match “{query}”.</p>}
      {shown.map(s => <button key={s.command} className="symbol" title={s.command} aria-label={`Insert ${s.command}`} onClick={() => onInsert(s.command)}>{s.char}</button>)}
    </div>
  </section>;
}

/** Right-click menu for a misspelled word: suggestions first, then “Add to dictionary”. */
export function SpellSuggestions({ menu, replace, addWord, close }: { menu: { x: number; y: number; word: string; suggestions: string[] | null }; replace: (text: string) => void; addWord: () => void; close: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const onDown = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest?.('.spell-menu')) close(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown); };
  }, [close]);
  const left = Math.min(menu.x, window.innerWidth - 220), top = Math.min(menu.y, window.innerHeight - 260);
  return <div className="spell-menu" role="menu" aria-label={`Spelling suggestions for ${menu.word}`} style={{ left, top }}>
    {menu.suggestions === null && <div className="spell-menu-note">Finding suggestions…</div>}
    {menu.suggestions?.length === 0 && <div className="spell-menu-note">No suggestions</div>}
    {menu.suggestions?.map(s => <button key={s} role="menuitem" className="spell-suggestion" onClick={() => replace(s)}>{s}</button>)}
    <div className="spell-menu-sep" />
    <button role="menuitem" onClick={addWord}>Add “{menu.word}” to dictionary</button>
  </div>;
}
