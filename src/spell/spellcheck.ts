import type { Monaco } from '@monaco-editor/react';
import type { editor, IDisposable, IRange } from 'monaco-editor';
import affUrl from 'dictionary-en-files/index.aff?url';
import dicUrl from 'dictionary-en-files/index.dic?url';

const OWNER = 'spellcheck';
const DICTIONARY_KEY = 'paperdesk-dictionary';
export type SpellMenu = { x: number; y: number; word: string; range: IRange; suggestions: string[] | null };

const readPersonal = (): string[] => { try { return JSON.parse(localStorage.getItem(DICTIONARY_KEY) ?? '[]'); } catch { return []; } };

/**
 * Spell checks LaTeX and BibTeX-free text files in an editor: a Web Worker finds misspelled prose, which is
 * underlined; right-clicking a marked word opens `onMenu` with suggestions. Returns a function that turns it off.
 */
export function attachSpellcheck(monaco: Monaco, ed: editor.IStandaloneCodeEditor, onMenu: (menu: SpellMenu | null) => void) {
  const worker = new Worker(new URL('./spell.worker.ts', import.meta.url), { type: 'module' });
  worker.postMessage({ type: 'init', aff: new URL(affUrl, location.href).href, dic: new URL(dicUrl, location.href).href, personal: readPersonal() });
  let nextId = 0, timer = 0;
  const pending = new Map<number, (data: any) => void>();
  worker.onmessage = (event: MessageEvent) => { const data = event.data; if (data.id !== undefined) { pending.get(data.id)?.(data); pending.delete(data.id); } };
  const ask = <T,>(message: object) => new Promise<T>(resolve => { const id = ++nextId; pending.set(id, resolve); worker.postMessage({ ...message, id }); });

  const checkable = (model: editor.ITextModel | null) => !!model && model.getLanguageId() === 'latex';
  const check = async () => {
    const model = ed.getModel();
    if (!checkable(model)) return;
    const version = model!.getVersionId();
    const { words } = await ask<{ words: { word: string; offset: number }[] }>({ type: 'check', text: model!.getValue() });
    if (model!.isDisposed() || model!.getVersionId() !== version) return;
    monaco.editor.setModelMarkers(model!, OWNER, words.map(w => {
      const start = model!.getPositionAt(w.offset), end = model!.getPositionAt(w.offset + w.word.length);
      return { owner: OWNER, source: 'Spelling', severity: monaco.MarkerSeverity.Warning, message: `“${w.word}” may be misspelled. Right-click for suggestions.`, startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column };
    }));
  };
  const schedule = (delay = 450) => { window.clearTimeout(timer); timer = window.setTimeout(() => void check(), delay); };

  const markerAt = (position: { lineNumber: number; column: number } | null | undefined) => {
    const model = ed.getModel();
    if (!model || !position) return null;
    return monaco.editor.getModelMarkers({ owner: OWNER, resource: model.uri })
      .find(m => m.startLineNumber === position.lineNumber && m.startColumn <= position.column && position.column <= m.endColumn) ?? null;
  };
  // A right-click on a marked word shows suggestions instead of the editor's own menu. Listening in the capture
  // phase runs before Monaco's handler, so other right-clicks keep the normal menu.
  const onContextMenu = (event: MouseEvent) => {
    const target = ed.getTargetAtClientPoint(event.clientX, event.clientY);
    const marker = markerAt(target?.position);
    if (!marker) return;
    event.preventDefault();
    event.stopPropagation();
    const model = ed.getModel()!;
    const range = { startLineNumber: marker.startLineNumber, startColumn: marker.startColumn, endLineNumber: marker.endLineNumber, endColumn: marker.endColumn };
    const word = model.getValueInRange(range);
    const at = { x: event.clientX, y: event.clientY };
    onMenu({ ...at, word, range, suggestions: null });
    void ask<{ suggestions: string[] }>({ type: 'suggest', word }).then(r => onMenu({ ...at, word, range, suggestions: r.suggestions }));
  };
  const node = ed.getDomNode();
  node?.addEventListener('contextmenu', onContextMenu, true);
  const disposables: IDisposable[] = [
    ed.onDidChangeModelContent(() => schedule()),
    ed.onDidChangeModel(() => schedule(50)),
    { dispose: () => node?.removeEventListener('contextmenu', onContextMenu, true) },
  ];
  schedule(50);

  return {
    replace(range: IRange, text: string) { ed.executeEdits(OWNER, [{ range, text }]); ed.focus(); },
    addWord(word: string) {
      const personal = readPersonal();
      if (!personal.includes(word)) { personal.push(word); try { localStorage.setItem(DICTIONARY_KEY, JSON.stringify(personal)); } catch { /* still added for this session */ } }
      worker.postMessage({ type: 'add', word });
      schedule(0);
    },
    dispose() {
      window.clearTimeout(timer);
      disposables.forEach(d => d.dispose());
      for (const model of monaco.editor.getModels()) monaco.editor.setModelMarkers(model, OWNER, []);
      worker.terminate();
    },
  };
}
export type Spellchecker = ReturnType<typeof attachSpellcheck>;
