import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { CollabRoom, CollabRooms } from './collab';
import { replacedSpan } from '../src/lib/textDiff';

describe('live documents', () => {
  it('builds a text per text file and merges two people’s edits', () => {
    const room = new CollabRoom('k', 'o', 'p', [{ name: 'main.tex', content: 'Hello world' }, { name: 'fig.png', content: 'AAAA', encoding: 'base64' }, { name: 'ch/', content: '' }]);
    expect([...room.names.keys()]).toEqual(['main.tex']);
    const ada = new Y.Doc(), bob = new Y.Doc();
    for (const doc of [ada, bob]) Y.applyUpdate(doc, Y.encodeStateAsUpdate(room.doc));
    ada.getText('f:main.tex').insert(0, 'A: ');
    bob.getText('f:main.tex').insert(11, '!');
    Y.applyUpdate(room.doc, Y.encodeStateAsUpdate(ada));
    Y.applyUpdate(room.doc, Y.encodeStateAsUpdate(bob));
    expect(room.texts().get('main.tex')).toBe('A: Hello world!');
  });

  it('mirrors API saves: new, changed and deleted files', () => {
    const room = new CollabRoom('k', 'o', 'p', [{ name: 'main.tex', content: 'one two three' }, { name: 'old.tex', content: 'x' }]);
    room.applyExternal([{ name: 'main.tex', content: 'one 2 three' }, { name: 'new.tex', content: 'N' }], ['old.tex']);
    expect(Object.fromEntries(room.texts())).toEqual({ 'main.tex': 'one 2 three', 'new.tex': 'N' });
  });

  it('saves once after edits stop and reloads after everyone leaves', async () => {
    const saves: string[] = [];
    let stored = 'v1';
    const rooms = new CollabRooms({ load: async () => [{ name: 'main.tex', content: stored }], save: async (_o, _p, texts) => { stored = texts.get('main.tex')!; saves.push(stored); } });
    const room = await rooms.open('k', 'o', 'p');
    expect(await rooms.open('k', 'o', 'p')).toBe(room);
    room.members = 1;
    room.text('main.tex').insert(2, '+a');
    room.text('main.tex').insert(4, '+b');
    await rooms.leave(room);
    expect(saves).toEqual(['v1+a+b']);
    expect(rooms.get('k')).toBeUndefined();
    expect((await rooms.open('k', 'o', 'p')).texts().get('main.tex')).toBe('v1+a+b');
  });

  it('finds the replaced span', () => {
    expect(replacedSpan('one two three', 'one 2 three')).toEqual({ index: 4, remove: 3, insert: '2' });
    expect(replacedSpan('abc', 'abc')).toEqual({ index: 3, remove: 0, insert: '' });
    expect(replacedSpan('aaa', 'aa')).toEqual({ index: 2, remove: 1, insert: '' });
  });
});
