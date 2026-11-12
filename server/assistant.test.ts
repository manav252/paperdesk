import { describe, expect, it } from 'vitest';
import { buildMessages, createRateLimiter, formatContext, LIMITS, parseAssistantRequest } from './assistant';

const ask = (content = 'How do I add a table?') => ({ mode: 'chat', messages: [{ role: 'user', content }] });

describe('parseAssistantRequest', () => {
  it('accepts a question with editor context', () => {
    const r = parseAssistantRequest({
      ...ask(),
      context: {
        file: 'main.tex',
        cursor: { line: 3, col: 1 },
        selection: 'x',
        content: '1| \\documentclass{article}',
        log: {
          success: false,
          errors: [{ file: 'main.tex', line: 3, message: 'Undefined control sequence.' }],
          warnings: [],
        },
      },
    });
    expect(r.ok).toBe(true);
  });

  it('rejects malformed conversations', () => {
    expect(parseAssistantRequest(null).ok).toBe(false);
    expect(parseAssistantRequest({ messages: [] }).ok).toBe(false);
    expect(parseAssistantRequest({ messages: [{ role: 'system', content: 'x' }] }).ok).toBe(false);
    expect(
      parseAssistantRequest({
        messages: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
        ],
      }).ok,
    ).toBe(false);
    expect(parseAssistantRequest({ ...ask(), mode: 'other' }).ok).toBe(false);
    expect(parseAssistantRequest({ ...ask(), context: { cursor: { line: 'x' } } }).ok).toBe(false);
    expect(parseAssistantRequest({ ...ask(), context: { log: { errors: [{ message: 1 }], warnings: [] } } }).ok).toBe(
      false,
    );
  });

  it('rejects oversized input with 413', () => {
    const r = parseAssistantRequest(ask('x'.repeat(LIMITS.messageChars + 1)));
    expect(r).toMatchObject({ ok: false, status: 413 });
    expect(parseAssistantRequest({ ...ask(), context: { content: 'x'.repeat(LIMITS.fileChars + 1) } })).toMatchObject({
      ok: false,
      status: 413,
    });
    const long = Array.from({ length: LIMITS.messages + 1 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: 'q',
    }));
    expect(parseAssistantRequest({ messages: long })).toMatchObject({ ok: false, status: 413 });
  });

  it('drops unexpected fields from messages', () => {
    const r = parseAssistantRequest({ messages: [{ role: 'user', content: 'hi', extra: true }] });
    expect(r.ok && r.request.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});

describe('context', () => {
  it('is sent as data in front of the newest question only', () => {
    const r = parseAssistantRequest({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'second' },
      ],
      context: { file: 'main.tex', cursor: { line: 2, col: 4 } },
    });
    if (!r.ok) throw new Error(r.error);
    const messages = buildMessages(r.request);
    expect(messages.slice(0, 2)).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
    ]);
    expect(messages[2].content).toEqual([
      { type: 'text', text: expect.stringContaining('<cursor>line 2, column 4</cursor>') },
      { type: 'text', text: 'second' },
    ]);
  });

  it('formats errors and log tails', () => {
    const text = formatContext({
      error: { file: 'a.tex', line: 5, message: 'Oops' },
      log: { success: false, errors: [{ file: null, line: null, message: 'Bad' }], warnings: [], tail: 'l.5' },
    });
    expect(text).toContain('- a.tex:5: Oops');
    expect(text).toContain('Last compile failed.');
    expect(text).toContain('- (unknown file): Bad');
    expect(formatContext({})).toBe('');
  });
});

describe('createRateLimiter', () => {
  it('allows a fixed number of requests per window and per client', () => {
    let t = 0;
    const limit = createRateLimiter(2, 1000, () => t);
    expect(limit('a').allowed).toBe(true);
    expect(limit('a').allowed).toBe(true);
    expect(limit('a')).toEqual({ allowed: false, retryAfterSec: 1 });
    expect(limit('b').allowed).toBe(true);
    t = 1000;
    expect(limit('a').allowed).toBe(true);
  });
});
