import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, MessageSquare, Pencil, Send, Trash2, X } from 'lucide-react';
import { mentionQuery, tokenize } from './lib/chatText';
import { live } from './live';

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
export type ChatPerson = { id: string; email: string; handle: string };
export type ChatMessage = {
  id: string;
  author: string;
  name: string;
  text: string;
  at: number;
  edited?: number;
  deleted?: boolean;
};
const json = { 'Content-Type': 'application/json' };
const readKey = (projectId: string) => `paperdesk-chat-read:${projectId}`;
const stored = (key: string) => {
  try {
    return Number(localStorage.getItem(key)) || 0;
  } catch {
    return 0;
  }
};
const failure = async (r: Response, fallback: string) =>
  ((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? fallback;

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
export function chatTime(at: number, now = Date.now()) {
  const date = new Date(at),
    time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay(date, new Date(now))
    ? time
    : `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}

/** A project's chat: loads the messages, follows new ones live, and counts the ones not read yet. */
export function useChat(projectId: string, apiFetch: Fetcher, enabled: boolean, open: boolean, signedIn: boolean) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [people, setPeople] = useState<ChatPerson[]>([]);
  const [me, setMe] = useState('');
  const [error, setError] = useState('');
  const [read, setRead] = useState(0);
  const upsert = (message: ChatMessage) =>
    setMessages((list) =>
      list.some((m) => m.id === message.id)
        ? list.map((m) => (m.id === message.id ? message : m))
        : [...list, message].sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
  const base = `/api/projects/${projectId}`;

  useEffect(() => {
    setMessages([]);
    setPeople([]);
    setError('');
    setRead(stored(readKey(projectId)));
    if (!projectId || !enabled) return;
    let current = true;
    const load = () =>
      apiFetch(`${base}/chat`)
        .then(async (r) => {
          if (!current || !r.ok) return;
          const body = (await r.json()) as { me: string; messages: ChatMessage[]; people: ChatPerson[] };
          setMe(body.me);
          setMessages(body.messages);
          setPeople(body.people);
        })
        .catch(() => undefined);
    void load();
    if (!signedIn) return () => void (current = false);
    // Live messages arrive over the app's connection, in the project's room; a reconnect catches up.
    let leave = () => {};
    void live().then((socket) => {
      if (!current) return;
      const join = () => socket.emit('project:join', projectId, () => void load());
      const onMessage = (message: ChatMessage) => current && upsert(message);
      socket.on('connect', join);
      socket.on('chat:message', onMessage);
      if (socket.connected) join();
      leave = () => {
        socket.off('connect', join);
        socket.off('chat:message', onMessage);
        socket.emit('project:leave', projectId);
      };
    });
    return () => {
      current = false;
      leave();
    };
  }, [projectId, enabled, signedIn]);

  const latest = messages.length ? messages[messages.length - 1]!.at : 0;
  useEffect(() => {
    if (!open || !projectId || latest <= read) return;
    setRead(latest);
    try {
      localStorage.setItem(readKey(projectId), String(latest));
    } catch {
      /* the badge then only resets for this visit */
    }
  }, [open, latest, projectId]);

  const call = async (path: string, method: string, text?: string) => {
    setError('');
    try {
      const r = await apiFetch(`${base}${path}`, {
        method,
        headers: json,
        body: text === undefined ? undefined : JSON.stringify({ text }),
      });
      if (!r.ok) {
        setError(await failure(r, 'The message could not be sent.'));
        return false;
      }
      upsert((await r.json()) as ChatMessage);
      return true;
    } catch {
      setError('The PaperDesk server isn’t reachable. Try again in a moment.');
      return false;
    }
  };
  return {
    messages,
    people,
    me,
    error,
    unread: open ? 0 : messages.filter((m) => m.at > read && m.author !== me && !m.deleted).length,
    send: (text: string) => call('/chat', 'POST', text),
    edit: (id: string, text: string) => call(`/chat/${id}`, 'PUT', text),
    remove: (id: string) => call(`/chat/${id}`, 'DELETE'),
  };
}
export type Chat = ReturnType<typeof useChat>;

/** Message or comment text with @mentions highlighted and file references turned into jump links. Always plain text. */
export function RichText({
  text,
  files,
  people,
  onJump,
}: {
  text: string;
  files: string[];
  people: ChatPerson[];
  onJump?: (file: string, line: number | null) => void;
}) {
  const tokens = useMemo(
    () =>
      tokenize(
        text,
        files,
        people.map((p) => p.handle),
      ),
    [text, files, people],
  );
  return (
    <>
      {tokens.map((token, i) =>
        token.type === 'mention' ? (
          <span className="mention" key={i} title={people.find((p) => p.handle === token.handle)?.email}>
            {token.text}
          </span>
        ) : token.type === 'file' && onJump ? (
          <button
            key={i}
            className="file-link"
            title={`Go to ${token.file}${token.line ? `, line ${token.line}` : ''}`}
            onClick={() => onJump(token.file, token.line)}
          >
            {token.text}
          </button>
        ) : (
          <Fragment key={i}>{token.text}</Fragment>
        ),
      )}
    </>
  );
}

/** A text box that offers the project's people after “@”. Enter submits, Shift+Enter starts a new line. */
export function MentionInput({
  value,
  onChange,
  people,
  onSubmit,
  label,
  placeholder,
  disabled,
  focusKey,
}: {
  value: string;
  onChange: (value: string) => void;
  people: ChatPerson[];
  onSubmit: () => void;
  label: string;
  placeholder?: string;
  disabled?: boolean;
  /** Changing this focuses the box (for example when a message is opened for editing). */
  focusKey?: string;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [picked, setPicked] = useState(0);
  const [closed, setClosed] = useState(false);
  const query = closed ? null : mentionQuery(value, caret);
  const options = query ? people.filter((p) => p.handle.startsWith(query.query)).slice(0, 6) : [];
  useEffect(() => {
    if (focusKey !== undefined) box.current?.focus();
  }, [focusKey]);
  const choose = (person: ChatPerson) => {
    if (!query) return;
    const before = `${value.slice(0, query.start)}@${person.handle} `;
    onChange(before + value.slice(caret));
    setCaret(before.length);
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(before.length, before.length);
    });
  };
  return (
    <div className="mention-input">
      {options.length > 0 && (
        <ul className="mention-list" role="listbox" aria-label="People on this project">
          {options.map((p, i) => (
            <li
              key={p.id}
              role="option"
              aria-selected={i === picked % options.length}
              className={i === picked % options.length ? 'on' : ''}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(p);
              }}
            >
              <strong>@{p.handle}</strong>
              <span>{p.email}</span>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={box}
        rows={2}
        value={value}
        aria-label={label}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={2000}
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart);
          setPicked(0);
          setClosed(false);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={(e) => {
          if (options.length) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setPicked((n) => (n + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              choose(options[picked % options.length]!);
              return;
            }
            if (e.key === 'Escape') {
              e.stopPropagation();
              setClosed(true);
              return;
            }
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
    </div>
  );
}

export function ChatPanel({
  chat,
  files,
  onJump,
  onClose,
}: {
  chat: Chat;
  files: string[];
  onJump: (file: string, line: number | null) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  // Braces matter: scrollIntoView may return a promise, which React would take for a cleanup function.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [chat.messages.length]);
  const submit = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    const ok = editing ? await chat.edit(editing, text) : await chat.send(text);
    setBusy(false);
    if (ok) {
      setDraft('');
      setEditing(null);
    }
  };
  return (
    <aside className="assistant-panel chat-panel" aria-label="Chat">
      <div className="pane-toolbar assistant-head">
        <span className="pane-title">
          <MessageSquare size={14} /> Chat
        </span>
        <div className="side-tools">
          <button className="icon-btn sm" aria-label="Close chat" title="Close" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
      </div>
      <div className="chat-messages" role="log" aria-label="Messages">
        {chat.messages.length === 0 && (
          <p className="muted chat-empty">
            No messages yet. Type @ to mention someone, or a file name like main.tex:12 to link to that line.
          </p>
        )}
        {chat.messages.map((m) => {
          const mine = m.author === chat.me;
          return (
            <div className={`chat-message ${mine ? 'mine' : ''}`} key={m.id} data-testid="chat-message">
              <div className="chat-meta">
                <strong>{mine ? 'You' : m.name}</strong>
                <time dateTime={new Date(m.at).toISOString()} title={new Date(m.at).toLocaleString()}>
                  {chatTime(m.at)}
                </time>
                {m.edited && !m.deleted && <span className="chat-edited">(edited)</span>}
                {mine && !m.deleted && (
                  <span className="chat-actions">
                    <button
                      className="icon-btn sm"
                      aria-label="Edit message"
                      title="Edit"
                      onClick={() => {
                        setEditing(m.id);
                        setDraft(m.text);
                      }}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      className="icon-btn sm"
                      aria-label="Delete message"
                      title="Delete"
                      onClick={() => void chat.remove(m.id)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </span>
                )}
              </div>
              {m.deleted ? (
                <p className="chat-deleted">This message was deleted.</p>
              ) : (
                <p className="chat-text">
                  <RichText text={m.text} files={files} people={chat.people} onJump={onJump} />
                </p>
              )}
            </div>
          );
        })}
        <div ref={end} />
      </div>
      {chat.error && (
        <p className="chat-error" role="alert">
          {chat.error}
        </p>
      )}
      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {editing && (
          <div className="chat-editing">
            Editing your message
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setEditing(null);
                setDraft('');
              }}
            >
              Cancel
            </button>
          </div>
        )}
        <div className="chat-compose">
          <MentionInput
            value={draft}
            onChange={setDraft}
            people={chat.people}
            onSubmit={() => void submit()}
            label="Message"
            placeholder="Write a message…"
            focusKey={editing ?? 'new'}
          />
          <button className="btn btn-primary btn-sm" disabled={busy || !draft.trim()} aria-label="Send message">
            <Send size={14} />
          </button>
        </div>
      </form>
    </aside>
  );
}

type Notice = {
  id: string;
  kind: 'chat' | 'comment';
  project: string;
  projectId: string;
  from: string;
  text: string;
  at: number;
  read?: boolean;
};

/** The bell: mentions of the signed-in person, newest first. Opening the list marks them read. */
export function NotificationBell({ apiFetch, onOpen }: { apiFetch: Fetcher; onOpen: (projectId: string) => void }) {
  const [items, setItems] = useState<Notice[]>([]);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let current = true;
    const load = () =>
      apiFetch('/api/notifications')
        .then(async (r) => {
          if (current && r.ok) setItems(((await r.json()) as { items: Notice[] }).items);
        })
        .catch(() => undefined);
    void load();
    let stop = () => {};
    void live().then((socket) => {
      if (!current) return;
      const onNotice = (notice: Notice) => setItems((list) => [notice, ...list.filter((n) => n.id !== notice.id)]);
      socket.on('notify', onNotice);
      socket.on('connect', load);
      stop = () => {
        socket.off('notify', onNotice);
        socket.off('connect', load);
      };
    });
    return () => {
      current = false;
      stop();
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const unread = items.filter((n) => !n.read).length;
  const toggle = () => {
    setOpen((o) => !o);
    if (open) setItems((list) => list.map((n) => ({ ...n, read: true })));
    else if (unread) void apiFetch('/api/notifications/read', { method: 'POST' }).catch(() => undefined);
  };
  return (
    <div className="account bell" ref={box}>
      <button
        className="icon-btn chrome-btn"
        aria-label={unread ? `Notifications, ${unread} new` : 'Notifications'}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Notifications"
        onClick={toggle}
      >
        <Bell size={16} />
        {unread > 0 && <span className="count-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="account-menu bell-menu" role="menu" aria-label="Notifications">
          {items.length === 0 && <p className="muted bell-empty">Nobody has mentioned you yet.</p>}
          {items.map((n) => (
            <button
              role="menuitem"
              key={n.id}
              className={n.read ? '' : 'unread'}
              onClick={() => {
                setOpen(false);
                setItems((list) => list.map((x) => ({ ...x, read: true })));
                onOpen(n.projectId);
              }}
            >
              <span>
                <strong>{n.from}</strong> mentioned you in {n.kind === 'comment' ? 'a comment on' : ''}{' '}
                <strong>{n.project}</strong>
              </span>
              <span className="bell-text">{n.text.length > 140 ? `${n.text.slice(0, 140)}…` : n.text}</span>
              <time>{chatTime(n.at)}</time>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
