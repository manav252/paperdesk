/**
 * A PDF position in SyncTeX's units: PostScript points (1/72 in) from the TOP-left corner of the page.
 * pdf.js user space starts at the bottom-left instead, so callers must flip y with the page height.
 * `width`/`height` describe the matched box (its top edge is `y - height`), when SyncTeX reports one.
 */
export type PdfSyncPosition = { page: number; x: number; y: number; width?: number; height?: number };
export type SourceSyncPosition = { file: string; line: number; column: number };

/** Converts a pdf.js user-space point (origin bottom-left) on a page with box `view` = [x0, y0, x1, y1] to SyncTeX's top-left origin. */
export function toSyncTexPoint(view: readonly number[], x: number, y: number) {
  return { x: x - view[0]!, y: view[3]! - y };
}

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
  if (page === null || page < 1 || x === null || y === null) return null;
  // h/v/W/H give the whole box (v is its baseline); fall back to the reference point alone.
  const h = number(result, 'h'),
    v = number(result, 'v'),
    width = number(result, 'W'),
    height = number(result, 'H');
  if (h !== null && v !== null && width !== null && height !== null && width > 0 && height > 0)
    return { page, x: h, y: v, width, height };
  return { page, x, y };
}

export function parseInverseSync(output: string, sourceRoot = '/work'): SourceSyncPosition | null {
  const result = block(output);
  const raw = result.match(/(?:^|\n)Input:(.+)/)?.[1]?.trim();
  const line = number(result, 'Line');
  const column = number(result, 'Column') ?? 1;
  const prefix = `${sourceRoot.replace(/\/+$/, '')}/`;
  if (!raw?.startsWith(prefix) || line === null || line < 1) return null;
  const parts = raw
    .slice(prefix.length)
    .split('/')
    .filter((part) => part && part !== '.');
  if (!parts.length || parts.some((part) => part === '..')) return null;
  return { file: parts.join('/'), line, column: Math.max(1, column) };
}
