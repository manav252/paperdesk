/** Totals reported by `texcount -inc -total -sum` for a document and the files it includes. */
export type WordCount = {
  total: number; text: number; headers: number; captions: number;
  headerCount: number; floats: number; mathInline: number; mathDisplay: number; files: number;
};

const FIELDS: [keyof WordCount, string][] = [
  ['total', 'Sum count'], ['text', 'Words in text'], ['headers', 'Words in headers'],
  ['captions', 'Words outside text (captions, etc.)'], ['headerCount', 'Number of headers'],
  ['floats', 'Number of floats/tables/figures'], ['mathInline', 'Number of math inlines'],
  ['mathDisplay', 'Number of math displayed'], ['files', 'Files'],
];

/** Parses texcount's summary; returns null when the output has no word totals (for example, an error). */
export function parseTexcount(output: string): WordCount | null {
  const result = {} as WordCount;
  for (const [key, label] of FIELDS) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = output.match(new RegExp(`^${escaped}:\\s*(\\d+)`, 'm'));
    result[key] = match ? Number(match[1]) : 0;
  }
  return /^Words in text:\s*\d+/m.test(output) ? result : null;
}
