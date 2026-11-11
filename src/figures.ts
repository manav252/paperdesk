import { arrayBufferToBase64, type ProjectFile } from './lib/project';
import { figurePath, MAX_IMAGE_BYTES, MAX_IMAGE_SIDE, needsPng } from './lib/figure';
import { isSvg, svgToPngBase64 } from './lib/upload';

export type PreparedFigure = { files: ProjectFile[]; include: string; note?: string };
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function toCanvasBlob(source: Blob, type: 'image/png' | 'image/jpeg', maxSide: number | null) {
  const bitmap = await createImageBitmap(source);
  const scale = maxSide && Math.max(bitmap.width, bitmap.height) > maxSide ? maxSide / Math.max(bitmap.width, bitmap.height) : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, 0.92));
  if (!blob) throw new Error('The image could not be converted.');
  return { blob, resized: scale < 1, width: canvas.width, height: canvas.height };
}

/**
 * Turns a pasted or dropped image into project files in figures/: HEIC, WebP, GIF and BMP become PNG, SVG gets
 * a PNG copy LaTeX can include, and PNG/JPG larger than 3000 px are scaled down unless the original is kept.
 */
export async function prepareFigure(file: File, options: { keepOriginal: boolean; used: Set<string> }): Promise<PreparedFigure> {
  if (file.size > MAX_IMAGE_BYTES) throw new Error(`${file.name || 'This image'} is ${megabytes(file.size)}. Images can be at most ${megabytes(MAX_IMAGE_BYTES)}; compress or resize it and try again.`);
  const path = figurePath(file.name, file.type, options.used);
  const binary = async (blob: Blob): Promise<ProjectFile> => ({ name: path, content: arrayBufferToBase64(await blob.arrayBuffer()), encoding: 'base64' });

  if (isSvg(path)) {
    const png = path.replace(/\.svg$/i, '.png');
    options.used.add(png);
    return { files: [{ name: path, content: await file.text() }, { name: png, content: await svgToPngBase64(file), encoding: 'base64' }], include: png, note: `${png} is a PNG copy of the SVG, which LaTeX can’t include directly.` };
  }
  if (/\.(pdf|eps)$/i.test(path)) return { files: [await binary(file)], include: path };

  let source: Blob = file, converted = false;
  if (/\.hei[cf]$/i.test(file.name) || /^image\/hei[cf]$/.test(file.type)) {
    const { default: heic2any } = await import('heic2any');
    const out = await heic2any({ blob: file, toType: 'image/png' }).catch(() => { throw new Error(`${file.name} couldn’t be read as a HEIC photo. Export it as JPG or PNG and try again.`); });
    source = Array.isArray(out) ? out[0]! : out;
    converted = true;
  }
  const jpeg = /\.jpe?g$/i.test(path);
  const mustConvert = converted || needsPng(file.name, file.type);
  let probe: ImageBitmap;
  try { probe = await createImageBitmap(source); } catch { throw new Error(`${file.name || 'This image'} couldn’t be read. Save it as PNG, JPG or PDF and try again.`); }
  const tooLarge = Math.max(probe.width, probe.height) > MAX_IMAGE_SIDE;
  probe.close();
  if (!mustConvert && !(tooLarge && !options.keepOriginal)) return { files: [await binary(source)], include: path };
  const out = await toCanvasBlob(source, jpeg ? 'image/jpeg' : 'image/png', options.keepOriginal ? null : MAX_IMAGE_SIDE);
  const notes = [mustConvert && !/\.png$/i.test(file.name) ? `Converted to PNG` : '', out.resized ? `scaled down to ${out.width}×${out.height} px (turn on “Keep original image size” in Project settings to keep the original)` : ''].filter(Boolean);
  return { files: [await binary(out.blob)], include: path, note: notes.length ? `${path}: ${notes.join(', ')}.` : undefined };
}
