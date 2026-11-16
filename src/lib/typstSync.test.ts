import { describe, expect, it } from 'vitest';
import { sourceWords } from './typstSource';
import { bestMatch, pdfToSource, sourceToPdf, wordAt, wordsFromItems, type PlacedItem } from './typstSync';

// A page laid out as lines of text items, 12 pt apart, each word 30 pt wide (the item width spreads over its letters).
function page(lines: string[]): PlacedItem[] {
  return lines.map((text, i) => ({ text, x: 72, y: 100 + i * 14, width: text.length * 5, height: 10, eol: true }));
}

describe('PDF words', () => {
  it('splits text items into words with boxes and joins words hyphenated across lines', () => {
    const words = wordsFromItems(2, page(['The exam-', 'ple is here.']));
    expect(words.map((w) => w.text)).toEqual(['the', 'example', 'is', 'here']);
    expect(words[1]).toMatchObject({ page: 2, x: 72 + 4 * 5, y: 100, height: 10 });
    expect(words[2]).toMatchObject({ x: 72 + 4 * 5, y: 114 });
  });
  it('finds the word under a point, or nothing far from any text', () => {
    const words = wordsFromItems(1, page(['alpha beta gamma']));
    expect(words[wordAt(words, 1, 72 + 7 * 5, 95)]!.text).toBe('beta');
    expect(wordAt(words, 1, 500, 500)).toBe(-1);
    expect(wordAt(words, 2, 80, 95)).toBe(-1);
  });
});

describe('matching words between the PDF and the source', () => {
  it('uses the neighbouring words to choose among repeated words', () => {
    const haystack = 'the cat sat on the mat while the dog ran'.split(' ');
    expect(bestMatch(['while', 'the', 'dog'], 1, haystack)).toBe(7);
    expect(bestMatch(['on', 'the', 'mat'], 1, haystack)).toBe(4);
    // A common word with no agreeing neighbours is not guessed.
    expect(bestMatch(['xyz', 'the', 'qqq'], 1, haystack)).toBe(-1);
    expect(bestMatch(['cat'], 0, haystack)).toBe(1);
  });

  const files = [
    {
      name: 'main.typ',
      content: '= Report\n\n#include "intro.typ"\n\nThe results were good.\nThe results were mixed.',
    },
    { name: 'intro.typ', content: '== Intro\nThe results were promising at first.' },
  ];
  const pdf = wordsFromItems(
    1,
    page([
      '1 Report',
      '1.1 Intro',
      'The results were promising at first.',
      'The results were good.',
      'The results were mixed.',
    ]),
  );

  it('goes from a clicked PDF word to its file and line', () => {
    const source = sourceWords(files);
    // "results" on the PDF's last line is the one in "were mixed".
    expect(pdfToSource(pdf, source, 1, 72 + 6 * 5, 100 + 4 * 14 - 3)).toMatchObject({ file: 'main.typ', line: 6 });
    expect(pdfToSource(pdf, source, 1, 72 + 6 * 5, 100 + 2 * 14 - 3)).toMatchObject({ file: 'intro.typ', line: 2 });
    // A heading number is not in the source; its heading is.
    expect(pdfToSource(pdf, source, 1, 73, 97)).toMatchObject({ file: 'main.typ', line: 1 });
    // Away from any text there is nothing to find.
    expect(pdfToSource(pdf, source, 1, 400, 400)).toBeNull();
  });

  it('goes from a cursor position to the printed word', () => {
    const source = sourceWords(files);
    expect(sourceToPdf(source, pdf, 'main.typ', 5, 5)).toMatchObject({ page: 1, y: 100 + 3 * 14 });
    expect(sourceToPdf(source, pdf, 'intro.typ', 2, 20)).toMatchObject({ page: 1, y: 100 + 2 * 14 });
    // On a code-only line, the next printed word is used.
    expect(sourceToPdf(source, pdf, 'main.typ', 3, 1)).toMatchObject({ y: 100 + 3 * 14 });
    expect(sourceToPdf(source, pdf, 'other.typ', 1, 1)).toBeNull();
  });
});
