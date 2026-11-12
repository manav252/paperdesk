/** A text item of a PDF page as pdf.js reports it (`eol`: the line ends after this item). */
export type PdfTextItem = { text: string; eol?: boolean };
/** Part of a match inside one text item, as character offsets into that item's text. */
export type HitSegment = { item: number; start: number; end: number };
export type PdfMatch = { page: number; segments: HitSegment[] };

/**
 * Finds `query` in the text of every page, ignoring case and treating any run of spaces (or a line end) as a
 * space, so phrases that wrap onto the next line or span several text items are found. Pages are 1-based.
 */
export function findInPdf(pages: PdfTextItem[][], query: string): PdfMatch[] {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const pattern = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'gi');
  const matches: PdfMatch[] = [];
  pages.forEach((items, pageIndex) => {
    // Join the items, remembering where each one starts; a line end becomes a space.
    let text = '';
    const starts: number[] = [];
    items.forEach((item) => {
      starts.push(text.length);
      text += item.text;
      if (item.eol && !/\s$/.test(item.text)) text += ' ';
    });
    for (const m of text.matchAll(pattern)) {
      if (!m[0]) continue;
      const from = m.index!,
        to = from + m[0].length;
      const segments: HitSegment[] = [];
      items.forEach((item, i) => {
        const a = Math.max(from, starts[i]!),
          b = Math.min(to, starts[i]! + item.text.length);
        if (a < b) segments.push({ item: i, start: a - starts[i]!, end: b - starts[i]! });
      });
      if (segments.length) matches.push({ page: pageIndex + 1, segments });
    }
  });
  return matches;
}
