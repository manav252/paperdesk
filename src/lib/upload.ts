// Turning dropped or picked files into project files: folders keep their structure, and SVG images, which
// LaTeX can't include, get a PNG copy made in the browser.

export type Incoming = { file: File; path: string };

/** Use stable, TeX-friendly image names so includegraphics paths never contain spaces. */
export function safeImageName(name: string): string {
  const parts = name.split('/').filter(Boolean);
  const filename = parts.pop() ?? name;
  const safePart = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();
  const dot = filename.lastIndexOf('.');
  const ext = dot > 0 ? filename.slice(dot).toLowerCase() : '';
  const stem = safePart(dot > 0 ? filename.slice(0, dot) : filename);
  return [...parts.map(part => safePart(part) || 'images'), `${stem || 'image'}${ext}`].join('/');
}

/** Files from a drop, walking into dropped folders so "figures/plot.png" keeps its folder. */
export async function filesFromDrop(data: DataTransfer): Promise<Incoming[]> {
  const entries = Array.from(data.items ?? []).map(item => item.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
  if (!entries.length) return Array.from(data.files).map(file => ({ file, path: file.name }));
  const out: Incoming[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      out.push({ file, path: prefix + entry.name });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns results in batches until it returns an empty list.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const entry of entries) await walk(entry, '');
  return out;
}

export const isSvg = (name: string) => /\.svg$/i.test(name);

/** Size of an SVG from its width/height attributes or viewBox, for drawings that don't report a natural size. */
export function svgSize(text: string): { w: number; h: number } {
  const root = /<svg\b[^>]*>/i.exec(text)?.[0] ?? '';
  const num = (attr: string) => { const m = new RegExp(`\\b${attr}\\s*=\\s*["']\\s*([\\d.]+)`, 'i').exec(root); return m ? Number(m[1]) : 0; };
  const box = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(root);
  const w = num('width') || (box ? Number(box[1]) : 0) || 800;
  const h = num('height') || (box ? Number(box[2]) : 0) || 600;
  return { w, h };
}

/** Rasterises an SVG to PNG (base64) at up to 2400 px on the long side, so it can be used with \includegraphics. */
export async function svgToPngBase64(file: File): Promise<string> {
  const text = await file.text();
  const { w, h } = svgSize(text);
  const scale = Math.min(4, 2400 / Math.max(w, h));
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('The SVG could not be converted.');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  } finally { URL.revokeObjectURL(url); }
}
