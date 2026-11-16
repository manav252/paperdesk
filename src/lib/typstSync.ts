/**
 * Jumping between a Typst source and its PDF. The Typst compiler writes no SyncTeX data, so both directions match
 * words: the clicked word (or the word at the cursor) together with the words around it is looked up on the other
 * side, and the occurrence whose neighbours agree best wins.
 */
import { normalWord, type SourceWord } from './typstSource';

/** A word in the PDF, in points from the top-left of its page; `y` is the baseline, as in SyncTeX positions. */
export type PdfWord = { page: number; text: string; x: number; y: number; width: number; height: number };
/** A text item of a page, already in top-left page coordinates. */
export type PlacedItem = { text: string; x: number; y: number; width: number; height: number; eol?: boolean };

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;

/**
 * Splits a page's text items into words with an estimated box each. A word hyphenated at the end of a line
 * ("exam-" / "ple") is joined back into one word placed where it starts.
 */
export function wordsFromItems(page: number, items: PlacedItem[]): PdfWord[] {
  const words: PdfWord[] = [];
  let carry: PdfWord | null = null;
  items.forEach((item) => {
    const perChar = item.text.length ? item.width / item.text.length : 0;
    const matches = [...item.text.matchAll(WORD)];
    matches.forEach((m, k) => {
      const box: PdfWord = {
        page,
        text: normalWord(m[0]),
        x: item.x + m.index! * perChar,
        y: item.y,
        width: Math.max(1, m[0].length * perChar),
        height: item.height,
      };
      if (carry && k === 0) {
        carry.text += box.text;
        carry = null;
        return;
      }
      carry = null;
      words.push(box);
      // A last word followed by a hyphen at the end of the line continues on the next line.
      const after = item.text.slice(m.index! + m[0].length);
      if (k === matches.length - 1 && /^[-‐]\s*$/.test(after) && (item.eol || after.length > 0)) carry = box;
    });
    if (!matches.length && !/^[-‐\s]*$/.test(item.text)) carry = null;
  });
  return words;
}

const CONTEXT = 8;
/**
 * The index in `haystack` that best matches `needle[at]` given the words around it, or -1. Each word of the
 * context that also appears near the same distance from the candidate adds to its score, closer words counting
 * more. With several candidates, a match needs some agreeing context, so a common word alone is not enough.
 */
export function bestMatch(needle: string[], at: number, haystack: string[]) {
  const target = needle[at];
  if (!target) return -1;
  let best = -1,
    bestScore = -1,
    candidates = 0;
  for (let i = 0; i < haystack.length; i++) {
    if (haystack[i] !== target) continue;
    candidates++;
    let score = 0;
    for (let k = -CONTEXT; k <= CONTEXT; k++) {
      if (!k) continue;
      const word = needle[at + k];
      if (!word) continue;
      for (let d = -2; d <= 2; d++)
        if (haystack[i + k + d] === word) {
          score += 1 / (1 + Math.abs(k) * 0.15 + Math.abs(d) * 0.5);
          break;
        }
    }
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (candidates > 1 && bestScore < 1) return -1;
  return best;
}

/** Tries the word itself first, then its nearest neighbours, so a word printed differently still finds a place. */
function locate(needle: string[], at: number, haystack: string[]) {
  for (let step = 0; step <= 4; step++)
    for (const i of step ? [at + step, at - step] : [at]) {
      if (i < 0 || i >= needle.length) continue;
      const found = bestMatch(needle, i, haystack);
      if (found >= 0) return { found, shift: i - at };
    }
  return null;
}

/** The PDF word under a point of a page, or the nearest one on that page within a short distance. */
export function wordAt(words: PdfWord[], page: number, x: number, y: number) {
  let best = -1,
    bestDistance = Infinity;
  words.forEach((w, i) => {
    if (w.page !== page) return;
    const dx = x < w.x ? w.x - x : x > w.x + w.width ? x - w.x - w.width : 0;
    const dy = y < w.y - w.height ? w.y - w.height - y : y > w.y + w.height * 0.3 ? y - w.y - w.height * 0.3 : 0;
    const distance = Math.hypot(dx, dy * 1.5);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  });
  return bestDistance <= 24 ? best : -1;
}

/** The source line of the PDF word at a point, or null when the text there is not in the source (for example a page number). */
export function pdfToSource(words: PdfWord[], source: SourceWord[], page: number, x: number, y: number) {
  const index = wordAt(words, page, x, y);
  if (index < 0) return null;
  const from = Math.max(0, index - CONTEXT);
  const needle = words.slice(from, index + CONTEXT + 1).map((w) => w.text);
  const hit = locate(
    needle,
    index - from,
    source.map((w) => w.text),
  );
  if (!hit) return null;
  const word = source[Math.min(source.length - 1, Math.max(0, hit.found - hit.shift))]!;
  return { file: word.file, line: word.line, column: word.column };
}

/** Where the source word at (or just after) a cursor position is printed, or null. */
export function sourceToPdf(source: SourceWord[], words: PdfWord[], file: string, line: number, column: number) {
  let index = source.findIndex(
    (w) => w.file === file && (w.line > line || (w.line === line && w.column + w.text.length >= column)),
  );
  if (index < 0 || source[index]!.file !== file) {
    // Past the last word of the file: use the last one before the cursor.
    for (let i = source.length - 1; i >= 0; i--)
      if (source[i]!.file === file && (source[i]!.line < line || source[i]!.line === line)) {
        index = i;
        break;
      }
  }
  if (index < 0 || source[index]!.file !== file) return null;
  const from = Math.max(0, index - CONTEXT);
  const needle = source.slice(from, index + CONTEXT + 1).map((w) => w.text);
  const hit = locate(
    needle,
    index - from,
    words.map((w) => w.text),
  );
  if (!hit) return null;
  const word = words[Math.min(words.length - 1, Math.max(0, hit.found - hit.shift))]!;
  return { page: word.page, x: word.x, y: word.y, width: word.width, height: word.height };
}
