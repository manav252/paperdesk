import { describe, expect, it } from 'vitest';
import { findInPdf } from './pdfSearch';

describe('PDF text search', () => {
  const pages = [
    [{ text: 'Results marker sentence' , eol: true }, { text: 'from the chapter file.' }],
    [{ text: 'The results ' }, { text: 'agree.' , eol: true }, { text: 'RESULTS again' }],
  ];

  it('finds every match, ignoring case, with 1-based pages', () => {
    expect(findInPdf(pages, 'results').map(m => m.page)).toEqual([1, 2, 2]);
    expect(findInPdf(pages, 'results')[0]!.segments).toEqual([{ item: 0, start: 0, end: 7 }]);
  });

  it('finds phrases across text items and line ends', () => {
    expect(findInPdf(pages, 'sentence from the')).toEqual([{ page: 1, segments: [{ item: 0, start: 15, end: 23 }, { item: 1, start: 0, end: 8 }] }]);
    expect(findInPdf(pages, 'results agree')).toHaveLength(1);
  });

  it('treats the query as text, not a pattern', () => {
    expect(findInPdf(pages, 'file.')).toHaveLength(1);
    expect(findInPdf(pages, '.*')).toEqual([]);
    expect(findInPdf(pages, '   ')).toEqual([]);
  });
});
