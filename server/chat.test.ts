import { describe, expect, it } from 'vitest';
import { ChatStore, cleanText, handleOf, mentioned } from './chat';
import { Kv } from './kv';
import { roleAllows } from './sharing';

const people = [
  { id: 'a', email: 'ada.lovelace@example.com' },
  { id: 'b', email: 'Bob@example.com' },
];

describe('chat text', () => {
  it('keeps text as written apart from control characters, and caps its length', () => {
    expect(cleanText('  hi <b>there</b>\u0000\u0007\r\nnext  ')).toBe('hi <b>there</b>\nnext');
    expect(cleanText('x'.repeat(5000))).toHaveLength(2000);
    expect(cleanText({ toString: () => 'object' })).toBe('');
    expect(cleanText(undefined)).toBe('');
  });
  it('finds the people a message mentions', () => {
    expect(handleOf('Ada.Lovelace+x@example.com')).toBe('ada.lovelacex');
    expect(mentioned('thanks @bob, and @ada.lovelace.', people).map((p) => p.id)).toEqual(['a', 'b']);
    expect(mentioned('mail me at x@bob.com or @nobody', people)).toEqual([]);
    expect(mentioned('@bob @bob @BOB', people)).toHaveLength(1);
  });
});

describe('chat storage', () => {
  it('keeps messages in order and lets only the author edit', async () => {
    const chat = new ChatStore(new Kv(null));
    const first = await chat.add('room', { id: 'a', name: 'Ada' }, 'one');
    const second = await chat.add('room', { id: 'b', name: 'Bob' }, 'two');
    expect((await chat.list('room')).map((m) => m.text)).toEqual(['one', 'two']);
    expect(await chat.list('other')).toEqual([]);

    expect(await chat.change('room', first.id, 'b', { text: 'hijacked' })).toBeNull();
    const edited = await chat.change('room', first.id, 'a', { text: 'one!' });
    expect(edited).toMatchObject({ text: 'one!' });
    expect(edited!.edited).toBeGreaterThan(0);

    // Someone else cannot delete it; the project owner can; a deleted message keeps no text and cannot change again.
    expect(await chat.change('room', second.id, 'a', { deleted: true })).toBeNull();
    expect(await chat.change('room', second.id, 'a', { deleted: true, any: true })).toMatchObject({
      deleted: true,
      text: '',
    });
    expect(await chat.change('room', second.id, 'b', { text: 'back' })).toBeNull();
    await chat.clear('room');
    expect(await chat.list('room')).toEqual([]);
  });
  it('counts notifications as unread until they are marked read', async () => {
    const chat = new ChatStore(new Kv(null));
    await chat.notify('a', {
      kind: 'chat',
      project: 'Paper',
      projectId: 'p1',
      from: 'bob@example.com',
      text: '@ada hi',
    });
    expect(await chat.notices('a')).toMatchObject({ unread: 1, items: [{ project: 'Paper', read: false }] });
    expect((await chat.notices('b')).items).toEqual([]);
    await new Promise((done) => setTimeout(done, 2));
    await chat.markRead('a');
    expect(await chat.notices('a')).toMatchObject({ unread: 0, items: [{ read: true }] });
  });
});

describe('roles for chat and GitHub sync', () => {
  it('lets viewers chat but not sync', () => {
    expect(roleAllows('viewer', 'POST', '/chat')).toBe(true);
    expect(roleAllows('viewer', 'PUT', '/chat/000123-ab')).toBe(true);
    expect(roleAllows('viewer', 'DELETE', '/chat/000123-ab')).toBe(true);
    expect(roleAllows('viewer', 'POST', '/mentions')).toBe(true);
    expect(roleAllows('viewer', 'GET', '/github/changes')).toBe(true);
    for (const sub of ['/github/link', '/github/push', '/github/pull']) {
      expect(roleAllows('viewer', 'POST', sub)).toBe(false);
      expect(roleAllows('editor', 'POST', sub)).toBe(true);
    }
    expect(roleAllows('viewer', 'DELETE', '/github/link')).toBe(false);
    expect(roleAllows('editor', 'DELETE', '/github/link')).toBe(true);
    expect(roleAllows('editor', 'POST', '/chat/x/y')).toBe(false);
  });
});
