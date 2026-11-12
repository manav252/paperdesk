import type { editor } from 'monaco-editor';
import { apiUrl, projectOwnerId } from './lib/api';
import { currentAccessToken } from './lib/auth';
import { replacedSpan } from './lib/textDiff';

export type Peer = { name: string; color: string };
export type CollabHandlers = {
  /** Texts that changed in the live document (from anyone), by file name. */
  onTexts(texts: Map<string, string>): void;
  /** The set of file names the live document manages changed. */
  onNames(names: Set<string>): void;
  /** Someone added, removed or uploaded files: reload the file list. */
  onFiles(): void;
  onPeers(peers: Peer[]): void;
  onCompiled(success: boolean): void;
};
export type Collab = {
  has(name: string): boolean;
  text(name: string): string;
  /** Replaces a file's text with a minimal edit (for changes that don't come from typing in the editor). */
  setText(name: string, content: string): void;
  /** Connects the editor's current model to a file's live text; null disconnects. */
  bind(ed: editor.IStandaloneCodeEditor, name: string | null): void;
  destroy(): void;
};

const COLORS = ['#d9480f', '#1971c2', '#2f9e44', '#9c36b5', '#c2255c', '#0c8599', '#e67700', '#5f3dc4'];
const textKey = (name: string) => `f:${name}`;

/**
 * Real-time co-editing for one project: a Yjs document synced through the API's socket, bound to the Monaco
 * editor with y-monaco, with everyone's cursors. The libraries are downloaded only when a shared project opens.
 */
export async function startCollab(projectId: string, me: { name: string }, handlers: CollabHandlers): Promise<Collab> {
  const [{ io }, Y, awarenessProtocol, { MonacoBinding }] = await Promise.all([
    import('socket.io-client'),
    import('yjs'),
    import('y-protocols/awareness'),
    import('y-monaco'),
  ]);
  const socket = io(apiUrl('/').replace(/\/$/, '') || undefined, {
    auth: (cb) => {
      const token = currentAccessToken();
      cb(token ? { token } : { owner: projectOwnerId() });
    },
  });
  const color = COLORS[Math.floor(Math.random() * COLORS.length)]!;
  const style = document.createElement('style');
  document.head.appendChild(style);

  let doc: InstanceType<typeof Y.Doc> | null = null;
  let awareness: InstanceType<typeof awarenessProtocol.Awareness> | null = null;
  let epoch = '';
  let binding: { destroy(): void } | null = null;
  let bound: { ed: editor.IStandaloneCodeEditor; name: string } | null = null;
  let known = new Map<string, string>();
  let knownNames = '';
  let flushQueued = false;
  let destroyed = false;

  const names = () => new Set(doc ? [...doc.getMap('names').keys()] : []);
  /** Tells the app which texts and names changed since the last call. */
  const flush = () => {
    flushQueued = false;
    if (!doc || destroyed) return;
    const current = names(),
      changed = new Map<string, string>(),
      next = new Map<string, string>();
    for (const name of current) {
      const value = doc.getText(textKey(name)).toString();
      next.set(name, value);
      if (known.get(name) !== value) changed.set(name, value);
    }
    known = next;
    const key = [...current].sort().join('\n');
    if (key !== knownNames) {
      knownNames = key;
      handlers.onNames(current);
    }
    if (changed.size) handlers.onTexts(changed);
  };
  const queueFlush = () => {
    if (!flushQueued) {
      flushQueued = true;
      queueMicrotask(flush);
    }
  };

  const showPeers = () => {
    if (!awareness || !doc) return;
    const peers: Peer[] = [],
      rules: string[] = [];
    awareness.getStates().forEach((state, clientId) => {
      const user = (state as { user?: Peer }).user;
      if (!user || clientId === doc!.clientID) return;
      peers.push(user);
      const label = JSON.stringify(user.name.slice(0, 24));
      rules.push(
        `.yRemoteSelection-${clientId}{background-color:${user.color}33}.yRemoteSelectionHead-${clientId}{border-left:2px solid ${user.color}}.yRemoteSelectionHead-${clientId}::after{content:${label};background:${user.color}}`,
      );
    });
    style.textContent = rules.join('\n');
    handlers.onPeers(peers);
  };

  const attach = () => {
    binding?.destroy();
    binding = null;
    const model = bound?.ed.getModel();
    if (!doc || !awareness || !bound || !model || !names().has(bound.name)) return;
    binding = new MonacoBinding(doc.getText(textKey(bound.name)), model, new Set([bound.ed]), awareness);
  };

  /** Starts from the server's copy; after a short disconnect of the same server document, sends what it missed. */
  const join = () =>
    socket.emit('collab:join', projectId, (reply: { ok: boolean; epoch?: string; state?: ArrayBuffer }) => {
      if (destroyed || !reply?.ok || !reply.state) return;
      const state = new Uint8Array(reply.state);
      if (doc && reply.epoch === epoch) {
        Y.applyUpdate(doc, state, 'remote');
        socket.emit('collab:update', Y.encodeStateAsUpdate(doc));
      } else {
        binding?.destroy();
        binding = null;
        awareness?.destroy();
        doc?.destroy();
        const fresh = new Y.Doc();
        Y.applyUpdate(fresh, state, 'remote');
        doc = fresh;
        epoch = reply.epoch ?? '';
        known = new Map();
        knownNames = '\u0000';
        fresh.on('update', (update: Uint8Array, origin: unknown) => {
          if (origin !== 'remote') socket.emit('collab:update', update);
          queueFlush();
        });
        const aware = new awarenessProtocol.Awareness(fresh);
        awareness = aware;
        aware.on(
          'update',
          ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
            if (origin !== 'remote')
              socket.emit(
                'collab:awareness',
                awarenessProtocol.encodeAwarenessUpdate(aware, [...added, ...updated, ...removed]),
              );
            showPeers();
          },
        );
        aware.setLocalStateField('user', { name: me.name, color });
        attach();
      }
      socket.emit('collab:client', doc.clientID);
      if (awareness)
        socket.emit('collab:awareness', awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]));
      flush();
    });

  socket.on('connect', join);
  socket.on('collab:update', (update: ArrayBuffer) => {
    if (doc) Y.applyUpdate(doc, new Uint8Array(update), 'remote');
  });
  socket.on('collab:awareness', (update: ArrayBuffer) => {
    if (awareness) awarenessProtocol.applyAwarenessUpdate(awareness, new Uint8Array(update), 'remote');
  });
  socket.on('collab:left', (clientId: number) => {
    if (awareness) awarenessProtocol.removeAwarenessStates(awareness, [clientId], 'remote');
  });
  socket.on('collab:files', () => handlers.onFiles());
  socket.on('collab:compiled', (result: { success: boolean }) => handlers.onCompiled(!!result?.success));

  return {
    has: (name) => names().has(name),
    text: (name) => doc?.getText(textKey(name)).toString() ?? '',
    setText(name, content) {
      if (!doc || !names().has(name)) return;
      const text = doc.getText(textKey(name));
      const span = replacedSpan(text.toString(), content);
      if (!span.remove && !span.insert) return;
      doc.transact(() => {
        if (span.remove) text.delete(span.index, span.remove);
        if (span.insert) text.insert(span.index, span.insert);
      }, 'app');
    },
    bind(ed, name) {
      bound = name === null ? null : { ed, name };
      attach();
    },
    destroy() {
      destroyed = true;
      binding?.destroy();
      socket.emit('collab:leave');
      socket.close();
      awareness?.destroy();
      doc?.destroy();
      style.remove();
    },
  };
}
