/**
 * Reading Typst source without the compiler: which parts are printed text, the headings, and a word count.
 * Masking keeps every character offset (stripped parts become spaces, line breaks stay), so positions found in the
 * masked text are positions in the file.
 */
import type { WordCount } from './wordcount';

const blank = (text: string) => text.replace(/[^\n]/g, ' ');

/**
 * The file with everything that is not printed prose replaced by spaces: comments, raw blocks, math, code after `#`
 * up to its content brackets, strings, `key:` names, labels and `@references`. The text inside `[...]` content
 * blocks (captions, bodies) stays, since that is what appears in the PDF.
 */
export function maskTypst(source: string) {
  const text = source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/```[\s\S]*?```/g, blank)
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)))
    .replace(/(?<!\\)\$(?:\\\$|[^$])*\$/g, blank)
    .replace(/<[A-Za-z_][\w:.-]*>/g, blank)
    .replace(/@[A-Za-z_][\w:.-]*/g, blank);
  const out = text.split('');
  const hide = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const ident = /[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*/y;
  /** Skips code from `i`, hiding it, until `end` (a closing bracket or the end of the line) at nesting depth 0. Content blocks stay. */
  const code = (i: number, until: string): number => {
    let depth = 0;
    while (i < text.length) {
      const ch = text[i]!;
      if (until === '\n' && ch === '\n' && depth === 0) return i;
      if (ch === '[') {
        hide(i, i + 1);
        i = markup(i + 1, ']') + 1;
        continue;
      }
      if (ch === '"') {
        const close = text.indexOf('"', i + 1);
        const end = close < 0 ? text.length : close + 1;
        hide(i, end);
        i = end;
        continue;
      }
      if (ch === '(' || ch === '{') depth++;
      if (ch === ')' || ch === '}') {
        if (depth === 0 && ch === until) {
          hide(i, i + 1);
          return i + 1;
        }
        depth--;
      }
      hide(i, i + 1);
      i++;
    }
    return i;
  };
  /** Keeps markup text, hiding `#code` and markup marks, until `end` (`]` for a content block, or the end of the file). */
  const markup = (i: number, end: string): number => {
    let depth = 0;
    while (i < text.length) {
      const ch = text[i]!;
      if (end === ']' && ch === ']' && depth === 0) {
        hide(i, i + 1);
        return i;
      }
      if (ch === '[') depth++;
      if (ch === ']') depth--;
      if (ch === '\\') {
        hide(i, i + 1);
        i += 2;
        continue;
      }
      if (ch === '#') {
        ident.lastIndex = i + 1;
        const m = ident.exec(text);
        if (m) {
          const name = m[0];
          hide(i, i + 1 + name.length);
          i += 1 + name.length;
          // `#let`, `#set`, `#show`, `#import`: code to the end of the line (content blocks in it still count).
          if (/^(let|set|show|import|include|if|for|while|return)$/.test(name)) {
            i = code(i, '\n');
            continue;
          }
          // Arguments and further content blocks of a call: `#name(args)[body][body]`.
          // and method calls chained after them: `#counter(page).update(1)`.
          for (;;) {
            if (text[i] === '(') {
              hide(i, i + 1);
              i = code(i + 1, ')');
            } else if (text[i] === '[') {
              hide(i, i + 1);
              i = markup(i + 1, ']') + 1;
            } else if (text[i] === '.' && /[A-Za-z_]/.test(text[i + 1] ?? '')) {
              ident.lastIndex = i + 1;
              const field = ident.exec(text)!;
              hide(i, i + 1 + field[0].length);
              i += 1 + field[0].length;
            } else break;
          }
          continue;
        }
        if (text[i + 1] === '{' || text[i + 1] === '(') {
          hide(i, i + 2);
          i = code(i + 2, text[i + 1] === '{' ? '}' : ')');
          continue;
        }
      }
      // Markup marks at the start of a line: heading `=`, list `-`, numbered `+`, term `/`.
      if ((i === 0 || text[i - 1] === '\n') && /^[ \t]*(=+|[-+/])[ \t]/.test(text.slice(i, i + 12))) {
        const mark = /^[ \t]*(=+|[-+/])/.exec(text.slice(i))!;
        hide(i, i + mark[0].length);
        i += mark[0].length;
        continue;
      }
      if (ch === '*' || ch === '_' || ch === '`' || ch === '~') hide(i, i + 1);
      i++;
    }
    return i;
  };
  markup(0, '');
  return out.join('');
}

export type SourceWord = { text: string; file: string; line: number; column: number };
const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;
export const normalWord = (word: string) => word.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/’/g, "'");

/** Printed words of each Typst file, with the line and column (1-based) where each starts. */
export function sourceWords(files: { name: string; content: string }[]): SourceWord[] {
  const words: SourceWord[] = [];
  for (const file of files) {
    if (!/\.typ$/i.test(file.name)) continue;
    const masked = maskTypst(file.content);
    let line = 1,
      lineStart = 0,
      scanned = 0;
    for (const m of masked.matchAll(WORD)) {
      const at = m.index!;
      for (let i = scanned; i < at; i++)
        if (masked[i] === '\n') {
          line++;
          lineStart = i + 1;
        }
      scanned = at;
      words.push({ text: normalWord(m[0]), file: file.name, line, column: at - lineStart + 1 });
    }
  }
  return words;
}

export type OutlineItem = { level: number; title: string; line: number };
/** Headings of a Typst file: `= Title` lines and `#heading[...]` calls, outside comments and raw blocks. */
export function typstOutline(content: string): OutlineItem[] {
  const clean = content
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/```[\s\S]*?```/g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)));
  const items: OutlineItem[] = [];
  clean.split('\n').forEach((text, i) => {
    const markup = /^\s*(=+)\s+(.+?)\s*$/.exec(text);
    const call = /#heading\s*(?:\(([^)]*)\))?\s*\[([^\]]*)\]/.exec(text);
    const title = (raw: string) =>
      raw
        .replace(/<[\w:.-]+>\s*$/, '')
        .replace(/#[A-Za-z_][\w.-]*(\([^)]*\))?/g, '')
        .replace(/[[\]*_]/g, '')
        .trim() || '(untitled)';
    if (markup) items.push({ level: markup[1]!.length, title: title(markup[2]!), line: i + 1 });
    else if (call) {
      const level = Number(/level\s*:\s*(\d)/.exec(call[1] ?? '')?.[1] ?? 1);
      items.push({ level, title: title(call[2]!), line: i + 1 });
    }
  });
  const top = Math.min(...items.map((o) => o.level), 9);
  return items.map((o) => ({ ...o, level: o.level - top }));
}

/** Files a Typst file includes (`#include "path"`), resolved against its folder. */
function includes(file: string, content: string) {
  const folder = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
  return [...content.replace(/\/\/[^\n]*/g, '').matchAll(/#include\s+"([^"]+)"/g)].map((m) => {
    const parts = (m[1]!.startsWith('/') ? m[1]!.slice(1) : folder + m[1]).split('/');
    const out: string[] = [];
    for (const part of parts) {
      if (part === '..') out.pop();
      else if (part && part !== '.') out.push(part);
    }
    return out.join('/');
  });
}

const countWords = (text: string) => text.match(WORD)?.length ?? 0;

/**
 * A word count of a Typst document in the same shape as texcount's: words in running text, in headings and in
 * captions, the number of headings and figures, and inline and display math. Follows `#include` from the main file.
 */
export function typstWordCount(files: { name: string; content: string }[], mainFile: string): WordCount | null {
  const byName = new Map(files.filter((f) => /\.typ$/i.test(f.name)).map((f) => [f.name, f.content]));
  if (!byName.has(mainFile)) return null;
  const seen = new Set<string>(),
    order: string[] = [];
  const visit = (name: string) => {
    if (seen.has(name) || !byName.has(name)) return;
    seen.add(name);
    order.push(name);
    for (const child of includes(name, byName.get(name)!)) visit(child);
  };
  visit(mainFile);
  const count: WordCount = {
    total: 0,
    text: 0,
    headers: 0,
    captions: 0,
    headerCount: 0,
    floats: 0,
    mathInline: 0,
    mathDisplay: 0,
    files: order.length,
  };
  for (const name of order) {
    const source = byName
      .get(name)!
      .replace(/\/\*[\s\S]*?\*\//g, blank)
      .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)));
    for (const m of source.matchAll(/(?<!\\)\$((?:\\\$|[^$])*)\$/g)) {
      if (/^\s[\s\S]*\s$/.test(m[1]!)) count.mathDisplay++;
      else count.mathInline++;
    }
    count.floats += source.match(/#figure\s*\(/g)?.length ?? 0;
    // Captions are counted on their own and taken out of the running text.
    let rest = source;
    for (const m of source.matchAll(/caption\s*:\s*\[((?:[^[\]]|\[[^[\]]*\])*)\]/g)) {
      count.captions += countWords(maskTypst(m[1]!));
      rest = rest.replace(m[0], blank(m[0]));
    }
    const headings = typstOutline(rest);
    for (const item of headings) {
      count.headerCount++;
      count.headers += countWords(item.title === '(untitled)' ? '' : item.title);
    }
    const headingLines = new Set(headings.map((h) => h.line));
    const body = maskTypst(rest)
      .split('\n')
      .filter((_, i) => !headingLines.has(i + 1))
      .join('\n');
    count.text += countWords(body);
  }
  count.total = count.text + count.headers + count.captions;
  return count;
}
