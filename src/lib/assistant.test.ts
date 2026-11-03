import { describe, expect, it } from 'vitest';
import { applyFix, findFix, fixStillApplies, inlineTokens, numberedFile, parseAnswer, readEvents, recentMessages, type StreamEvent } from './assistant';

const doc = '\\documentclass{article}\n\\begin{document}\n\\textbf{Hi\n\\end{document}';

describe('numberedFile', () => {
  it('numbers every line of a small file', () => {
    expect(numberedFile('a\nb')).toEqual({ content: '1| a\n2| b', start: 1, end: 2, partial: false });
  });

  it('cuts large files to a window around the focus line', () => {
    const text = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n');
    const r = numberedFile(text, 500, 200);
    expect(r.partial).toBe(true);
    expect(r.start).toBeLessThanOrEqual(500);
    expect(r.end).toBeGreaterThanOrEqual(500);
    expect(r.content.length).toBeLessThanOrEqual(200);
    expect(r.content).toContain(' 500| line 500');
  });
});

describe('parseAnswer', () => {
  it('splits prose from fenced code', () => {
    expect(parseAnswer('Use this:\n```latex\n\\section{A}\n```\nDone.')).toEqual([
      { type: 'text', text: 'Use this:\n' },
      { type: 'code', lang: 'latex', code: '\\section{A}', open: false },
      { type: 'text', text: 'Done.' },
    ]);
  });

  it('keeps a code block that is still streaming', () => {
    expect(parseAnswer('Try:\n```latex\n\\begin{tab')).toEqual([{ type: 'text', text: 'Try:\n' }, { type: 'code', lang: 'latex', code: '\\begin{tab', open: true }]);
  });

  it('recognises replace-lines fix blocks', () => {
    const [, block] = parseAnswer('Fix:\n```latex replace-lines 3-3\n\\textbf{Hi}\n```');
    expect(block).toMatchObject({ type: 'code', lang: 'latex', lines: { start: 3, end: 3 }, code: '\\textbf{Hi}' });
  });
});

describe('fixes', () => {
  const answer = 'The brace is missing.\n```latex replace-lines 3-3\n\\textbf{Hi}\n```';

  it('finds a fix and applies it to the shown file', () => {
    const fix = findFix(answer, 'main.tex', doc)!;
    expect(fix).toEqual({ file: 'main.tex', start: 3, end: 3, replacement: '\\textbf{Hi}', original: ['\\textbf{Hi'] });
    expect(applyFix(doc, fix)).toBe('\\documentclass{article}\n\\begin{document}\n\\textbf{Hi}\n\\end{document}');
  });

  it('can replace one line with several', () => {
    const fix = findFix('```latex replace-lines 1-1\n\\documentclass{article}\n\\usepackage{graphicx}\n```', 'main.tex', doc)!;
    expect(applyFix(doc, fix).split('\n')).toHaveLength(5);
  });

  it('ignores ranges outside the file and unfinished blocks', () => {
    expect(findFix('```latex replace-lines 9-12\nx\n```', 'main.tex', doc)).toBeNull();
    expect(findFix('```latex replace-lines 3-2\nx\n```', 'main.tex', doc)).toBeNull();
    expect(findFix('```latex replace-lines 3-3\n\\textbf{Hi}', 'main.tex', doc)).toBeNull();
    expect(findFix('```latex\nplain\n```', 'main.tex', doc)).toBeNull();
  });

  it('notices when the file changed under the fix', () => {
    const fix = findFix(answer, 'main.tex', doc)!;
    expect(fixStillApplies(doc, fix)).toBe(true);
    expect(fixStillApplies(doc.replace('Hi', 'Hello'), fix)).toBe(false);
  });

  it('keeps Windows line endings', () => {
    const crlf = doc.replaceAll('\n', '\r\n');
    expect(applyFix(crlf, findFix(answer, 'main.tex', crlf)!)).toBe('\\documentclass{article}\r\n\\begin{document}\r\n\\textbf{Hi}\r\n\\end{document}');
  });
});

describe('inlineTokens', () => {
  it('finds inline code and bold text', () => {
    expect(inlineTokens('Add **graphicx** with `\\usepackage{graphicx}`.')).toEqual([
      { type: 'text', text: 'Add ' }, { type: 'bold', text: 'graphicx' }, { type: 'text', text: ' with ' }, { type: 'code', text: '\\usepackage{graphicx}' }, { type: 'text', text: '.' },
    ]);
  });
});

describe('recentMessages', () => {
  it('keeps the newest turns and starts with a question', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: String(i) }));
    const r = recentMessages(many);
    expect(r.length).toBeLessThanOrEqual(20);
    expect(r[0].role).toBe('user');
    expect(r.at(-1)!.content).toBe('24');
  });
});

describe('readEvents', () => {
  it('parses NDJSON split across chunks', async () => {
    const chunks = ['{"type":"text","te', 'xt":"Hel"}\n{"type":"text","text":"lo"}\n', '{"type":"done","stopReason":"end_turn"}'];
    const body = new ReadableStream<Uint8Array>({ start(c) { for (const s of chunks) c.enqueue(new TextEncoder().encode(s)); c.close(); } });
    const events: StreamEvent[] = [];
    await readEvents(body, e => events.push(e));
    expect(events).toEqual([{ type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' }, { type: 'done', stopReason: 'end_turn' }]);
  });
});
