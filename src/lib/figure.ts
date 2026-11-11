/** Pure helpers for adding figures: names, the figure block, and the graphicx package. */
import { safeImageName } from './upload';

export const FIGURE_FOLDER = 'figures/';
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 3000;
const FIGURE_EXT = /\.(png|jpe?g|pdf|svg|eps|heic|heif|webp|gif|bmp)$/i;
const FIGURE_MIME = /^image\/|^application\/(pdf|postscript)$/;

/** Whether a pasted or dropped file can become a figure. */
export const isFigureFile = (file: { name: string; type: string }) => FIGURE_EXT.test(file.name) || FIGURE_MIME.test(file.type);
/** Formats LaTeX can't include, which are converted to PNG. */
export const needsPng = (name: string, type = '') => /\.(heic|heif|webp|gif|bmp)$/i.test(name) || /^image\/(heic|heif|webp|gif|bmp)$/.test(type);

/** A safe, unused path in figures/ for an incoming file; clipboard images get a dated name. */
export function figurePath(name: string, type: string, used: Set<string>, now = new Date()) {
  const fromMime = /^image\/(\w+)/.exec(type)?.[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') ?? (type === 'application/pdf' ? 'pdf' : 'png');
  const base = name.split('/').pop() ?? '';
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const generic = !base || /^image\.\w+$/i.test(base);
  let safe = safeImageName(generic ? `pasted-${stamp}.${fromMime}` : /\.\w+$/.test(base) ? base : `${base}.${fromMime}`);
  if (needsPng(safe, type)) safe = safe.replace(/\.\w+$/, '.png');
  const dot = safe.lastIndexOf('.'), stem = safe.slice(0, dot), ext = safe.slice(dot);
  let path = `${FIGURE_FOLDER}${safe}`;
  for (let n = 2; used.has(path) || used.has(path.replace(/\.svg$/i, '.png')); n++) path = `${FIGURE_FOLDER}${stem}-${n}${ext}`;
  used.add(path);
  return path;
}

export const figureLabel = (path: string) => `fig:${(path.split('/').pop() ?? 'figure').replace(/\.[^.]+$/, '')}`;

/** A figure environment for one image. `caption` is what goes between the caption braces. */
export const figureBlock = (path: string, caption = '') =>
  `\\begin{figure}[ht]\n  \\centering\n  \\includegraphics[width=\\linewidth]{${path}}\n  \\caption{${caption}}\n  \\label{${figureLabel(path)}}\n\\end{figure}\n`;

/** The blocks as an editor snippet: the cursor lands in the first caption. */
export const figureSnippet = (paths: string[]) => paths.map((path, i) => figureBlock(path, i === 0 ? '\u0000' : '').replace(/[\\$}]/g, c => `\\${c}`).replace('\u0000', '$0')).join('\n');

const uncommented = (source: string) => source.replace(/(^|[^\\])%.*$/gm, '$1');
/** graphicx is loaded directly, or by a class that brings it (beamer). */
export const hasGraphicx = (source: string) => { const text = uncommented(source); return /\\usepackage\s*(\[[^\]]*\])?\s*\{[^}]*\bgraphicx\b[^}]*\}/.test(text) || /\\documentclass\s*(\[[^\]]*\])?\s*\{beamer\}/.test(text); };
/** Where \usepackage{graphicx} goes (the line after \documentclass, or the top of a file without one) and its text. */
export function graphicxInsertion(source: string) {
  const match = /\\documentclass\s*(\[[^\]]*\])?\s*\{[^}]*\}[^\n]*\n?/.exec(source);
  if (!match) return { offset: 0, text: '\\usepackage{graphicx}\n' };
  return { offset: match.index + match[0].length, text: `${match[0].endsWith('\n') ? '' : '\n'}\\usepackage{graphicx}\n` };
}
export function addGraphicx(source: string) {
  const { offset, text } = graphicxInsertion(source);
  return `${source.slice(0, offset)}${text}${source.slice(offset)}`;
}

/** Whether an offset in a .tex file is inside the document body (files without \begin{document} are all body). */
export function inDocumentBody(source: string, offset: number) {
  const begin = source.indexOf('\\begin{document}');
  if (begin < 0) return true;
  const end = source.lastIndexOf('\\end{document}');
  return offset >= begin + '\\begin{document}'.length && (end < 0 || offset <= end);
}

/** Puts figure blocks just before \end{document} (or at the end of a file without one). */
export function appendToBody(source: string, blocks: string) {
  const end = source.lastIndexOf('\\end{document}');
  return end < 0 ? `${source.trimEnd()}\n\n${blocks}` : `${source.slice(0, end).trimEnd()}\n\n${blocks}\n${source.slice(end)}`;
}
