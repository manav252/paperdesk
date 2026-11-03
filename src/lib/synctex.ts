export type PdfSyncPosition = { page: number; x: number; y: number };
export type SourceSyncPosition = { file: string; line: number; column: number };

const block = (output: string) => output.match(/SyncTeX result begin\s*([\s\S]*?)\s*SyncTeX result end/)?.[1] ?? '';
const number = (text: string, key: string) => {
  const value = Number(text.match(new RegExp(`(?:^|\\n)${key}:(-?\\d+(?:\\.\\d+)?)`))?.[1]);
  return Number.isFinite(value) ? value : null;
};

export function parseForwardSync(output: string): PdfSyncPosition | null {
  const result = block(output);
  const page = number(result, 'Page');
  const x = number(result, 'x');
  const y = number(result, 'y');
  return page !== null && page >= 1 && x !== null && y !== null ? { page, x, y } : null;
}

export function parseInverseSync(output: string): SourceSyncPosition | null {
  const result = block(output);
  const raw = result.match(/(?:^|\n)Input:(.+)/)?.[1]?.trim();
  const line = number(result, 'Line');
  const column = number(result, 'Column') ?? 1;
  if (!raw?.startsWith('/work/') || line === null || line < 1) return null;
  const parts = raw.slice('/work/'.length).split('/').filter(part => part && part !== '.');
  if (!parts.length || parts.some(part => part === '..')) return null;
  return { file: parts.join('/'), line, column: Math.max(1, column) };
}
