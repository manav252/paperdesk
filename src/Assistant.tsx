import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, ArrowUp, Check, Copy, CornerDownLeft, FileDiff, MessageSquarePlus, Sigma, Sparkles, Square, Table2, Image as ImageIcon, Quote, Wrench, X } from 'lucide-react';
import { findFix, inlineTokens, parseAnswer, readEvents, recentMessages, type ChatMessage, type LineFix } from './lib/assistant';
import type { LogEntry } from './lib/latexLog';

export type AssistantContext = Record<string, unknown>;
export type AssistantStatus = { configured: boolean; model: string } | null;
type Message = ChatMessage & { id: string; state?: 'streaming' | 'done' | 'stopped' | 'error'; notice?: string; fix?: LineFix | null; fixSource?: { file: string; shown: string }; applied?: boolean };
export type SendOptions = { mode?: 'chat' | 'explain'; context?: AssistantContext; fixSource?: { file: string; shown: string } };

const NOT_CONFIGURED = 'not_configured';
const STOP_NOTICES: Record<string, string> = {
  max_tokens: 'The answer was cut off because it got too long. Ask a narrower question.',
  refusal: 'The assistant couldn’t answer this request.',
};

/** Conversation state and the streaming request. Lives in the editor so the chat survives closing the panel. */
export function useAssistant(onUnconfigured: () => void) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const patch = (id: string, fn: (m: Message) => Message) => setMessages(ms => ms.map(m => (m.id === id ? fn(m) : m)));

  const send = async (question: string, opts: SendOptions = {}) => {
    const text = question.trim();
    if (!text || busy) return;
    const user: Message = { id: crypto.randomUUID(), role: 'user', content: text };
    const reply: Message = { id: crypto.randomUUID(), role: 'assistant', content: '', state: 'streaming', fixSource: opts.fixSource };
    const history = [...messages.filter(m => m.content && m.state !== 'error'), user];
    setMessages(ms => [...ms, user, reply]);
    setBusy(true);
    const controller = new AbortController();
    abort.current = controller;
    let answer = '';
    try {
      const res = await fetch('/api/assistant', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ mode: opts.mode ?? 'chat', messages: recentMessages(history.map(({ role, content }) => ({ role, content }))), context: opts.context }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => null);
        if (data?.code === NOT_CONFIGURED) onUnconfigured();
        throw new Error(data?.code === NOT_CONFIGURED ? 'Assistant not configured.' : data?.error ?? 'The assistant needs the PaperDesk API. Start everything with “npm run dev:all”.');
      }
      let stopReason: string | null = null;
      await readEvents(res.body, e => {
        if (e.type === 'text') { answer += e.text; patch(reply.id, m => ({ ...m, content: answer })); }
        else if (e.type === 'done') stopReason = e.stopReason;
        else throw new Error(e.error);
      });
      const fix = opts.fixSource && answer ? findFix(answer, opts.fixSource.file, opts.fixSource.shown) : null;
      patch(reply.id, m => ({ ...m, content: answer, state: 'done', fix, notice: stopReason ? STOP_NOTICES[stopReason] : undefined }));
    } catch (e) {
      if (controller.signal.aborted) patch(reply.id, m => ({ ...m, content: answer, state: 'stopped', notice: 'Stopped.' }));
      else patch(reply.id, m => ({ ...m, content: answer, state: 'error', notice: e instanceof TypeError ? 'The assistant needs the PaperDesk API. Start everything with “npm run dev:all”.' : e instanceof Error ? e.message : 'The assistant failed.' }));
    } finally {
      abort.current = null;
      setBusy(false);
    }
  };

  return {
    messages, busy, send,
    stop: () => abort.current?.abort(),
    reset: () => { abort.current?.abort(); setMessages([]); },
    markApplied: (fix: LineFix) => setMessages(ms => ms.map(m => (m.fix === fix ? { ...m, applied: true } : m))),
  };
}

export const QUICK_PROMPTS: { id: string; label: string; icon: ReactNode; prompt?: string }[] = [
  { id: 'table', label: 'Insert table', icon: <Table2 size={13} />, prompt: 'Show me how to insert a simple table with a caption and a label I can reference.' },
  { id: 'figure', label: 'Insert figure', icon: <ImageIcon size={13} />, prompt: 'How do I insert a figure from an image file, with a caption and a label I can reference?' },
  { id: 'citation', label: 'Add citation', icon: <Quote size={13} />, prompt: 'How do I cite a source and add a bibliography to my document with BibTeX?' },
  { id: 'equation', label: 'Write equation', icon: <Sigma size={13} />, prompt: 'Help me write a numbered equation. Give an example I can adapt.' },
  { id: 'fix', label: 'Fix my compile errors', icon: <Wrench size={13} /> },
];

type PanelProps = {
  assistant: ReturnType<typeof useAssistant>;
  status: AssistantStatus;
  apiOnline: boolean | null;
  share: boolean;
  setShare: (v: boolean) => void;
  shared: string[];
  onQuick: (id: string) => void;
  onAsk: (question: string) => void;
  onInsert: (code: string) => void;
  onReviewFix: (fix: LineFix) => void;
  onClose: () => void;
};

export function AssistantPanel({ assistant, status, apiOnline, share, setShare, shared, onQuick, onAsk, onInsert, onReviewFix, onClose }: PanelProps) {
  const { messages, busy } = assistant;
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const unavailable = apiOnline === false ? 'offline' : status && !status.configured ? 'unconfigured' : '';
  useEffect(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; }, [messages]);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const submit = () => { if (!draft.trim() || busy || unavailable) return; onAsk(draft); setDraft(''); };

  return <aside className="assistant-panel" aria-label="Assistant">
    <div className="pane-toolbar assistant-head">
      <span className="pane-title"><Sparkles size={14} /> Assistant</span>
      <span className="side-tools">
        <button className="icon-btn sm" title="New chat" aria-label="New chat" disabled={!messages.length} onClick={assistant.reset}><MessageSquarePlus size={15} /></button>
        <button className="icon-btn sm" title="Close assistant" aria-label="Close assistant" onClick={onClose}><X size={15} /></button>
      </span>
    </div>
    <div className="assistant-messages" ref={listRef} aria-live="polite">
      {unavailable ? <div className="assistant-notice">
        <AlertCircle size={18} />
        {unavailable === 'offline' ? <><strong>The assistant needs the PaperDesk API</strong><p>Start everything with <code>npm run dev:all</code>.</p></>
          : <><strong>Assistant not configured</strong><p>The API server needs an Anthropic API key. Set <code>ANTHROPIC_API_KEY</code> in the server’s <code>.env</code> file (or in your hosting dashboard), then restart the API. See <code>.env.example</code>.</p></>}
      </div>
      : !messages.length ? <div className="assistant-welcome">
        <strong>Hi! I can help you with LaTeX.</strong>
        <p>Ask how to do something, or pick a starting point. I’ll show examples you can insert at your cursor.</p>
      </div>
      : messages.map(m => m.role === 'user'
        ? <div className="chat-msg user" key={m.id}>{m.content}</div>
        : <div className={`chat-msg bot ${m.state ?? ''}`} key={m.id}>
          {m.content ? <Answer text={m.content} streaming={m.state === 'streaming'} fix={m.fix} applied={m.applied} onInsert={onInsert} onReviewFix={onReviewFix} /> : m.state === 'streaming' ? <span className="typing" aria-label="Assistant is writing"><i /><i /><i /></span> : null}
          {m.notice && <p className={`chat-notice ${m.state === 'error' ? 'error' : ''}`}>{m.state === 'error' && <AlertCircle size={13} />}{m.notice}</p>}
        </div>)}
    </div>
    {!unavailable && <div className="quick-prompts" role="group" aria-label="Quick prompts">
      {QUICK_PROMPTS.map(q => <button key={q.id} className="chip" disabled={busy} onClick={() => onQuick(q.id)}>{q.icon}{q.label}</button>)}
    </div>}
    <div className="assistant-compose">
      <div className="context-toggle">
        <label className="switch"><input type="checkbox" checked={share} onChange={e => setShare(e.target.checked)} /><span aria-hidden /><b>Share editor context</b></label>
        <p className="context-summary" title="What is sent with each question">{share ? (shared.length ? `Sends: ${shared.join(' · ')}` : 'Nothing to share yet.') : 'Only your question is sent.'}</p>
      </div>
      <div className="compose-box">
        <textarea ref={inputRef} rows={2} value={draft} disabled={!!unavailable} placeholder="Ask about LaTeX…" aria-label="Ask the assistant" onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
        {busy ? <button className="send-btn" title="Stop" aria-label="Stop answer" onClick={assistant.stop}><Square size={13} fill="currentColor" /></button>
          : <button className="send-btn" title="Send (Enter)" aria-label="Send question" disabled={!draft.trim() || !!unavailable} onClick={submit}><ArrowUp size={15} /></button>}
      </div>
      <p className="assistant-foot">Answers can be wrong. Nothing changes in your project until you click Insert or Apply.</p>
    </div>
  </aside>;
}

function Answer({ text, streaming, fix, applied, onInsert, onReviewFix }: { text: string; streaming: boolean; fix?: LineFix | null; applied?: boolean; onInsert: (code: string) => void; onReviewFix: (fix: LineFix) => void }) {
  return <>{parseAnswer(text).map((s, i) => s.type === 'text'
    ? <p className="chat-text" key={i}>{inlineTokens(s.text.replace(/^#{1,6}\s+/gm, '')).map((t, j) => t.type === 'code' ? <code key={j}>{t.text}</code> : t.type === 'bold' ? <strong key={j}>{t.text}</strong> : t.text)}</p>
    : <CodeBlock key={i} code={s.code} label={s.lines ? `Suggested fix · ${fix ? fix.file + ' · ' : ''}lines ${s.lines.start}–${s.lines.end}` : s.lang} pending={s.open && streaming} fix={s.lines && !streaming ? fix : undefined} applied={applied} onInsert={onInsert} onReviewFix={onReviewFix} />)}</>;
}

function CodeBlock({ code, label, pending, fix, applied, onInsert, onReviewFix }: { code: string; label: string; pending: boolean; fix?: LineFix | null; applied?: boolean; onInsert: (code: string) => void; onReviewFix: (fix: LineFix) => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard?.writeText(code).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }).catch(() => undefined);
  return <div className={`code-block ${fix ? 'is-fix' : ''}`}>
    <div className="code-head"><span>{label}</span>
      <span className="code-actions">
        <button title="Copy" aria-label="Copy code" disabled={pending} onClick={copy}>{copied ? <Check size={13} /> : <Copy size={13} />}</button>
        <button disabled={pending} onClick={() => onInsert(code)} title="Insert at the cursor in the editor"><CornerDownLeft size={13} /> Insert at cursor</button>
      </span>
    </div>
    <pre><code>{code}</code></pre>
    {fix && <div className="fix-actions">{applied ? <span className="fix-applied"><Check size={13} /> Fix applied</span> : <button className="btn btn-primary btn-sm" onClick={() => onReviewFix(fix)}><FileDiff size={13} /> Apply fix…</button>}</div>}
    {fix === null && <p className="fix-missing">This suggestion doesn’t match the file anymore; copy the lines you need instead.</p>}
  </div>;
}

/** The "Explain this error" button shown next to each error in Logs. */
export function ExplainButton({ entry, onExplain }: { entry: LogEntry; onExplain: (e: LogEntry) => void }) {
  return <button className="explain-btn" title="Ask the assistant to explain this error and suggest a fix" onClick={() => onExplain(entry)}><Sparkles size={13} /> Explain this error</button>;
}
