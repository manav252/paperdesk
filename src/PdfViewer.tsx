import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';

export type Zoom = number | 'fit' | 'page';
type Size = { w: number; h: number };
type Loaded = { pdf: any; sizes: Size[] };
const GAP = 16, PAD = 20;

let pdfjsLoad: Promise<any> | null = null;
function loadPdfjs() {
  pdfjsLoad ??= import('pdfjs-dist').then(pdfjs => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
    return pdfjs;
  });
  return pdfjsLoad;
}

/**
 * Continuous PDF preview: every page is laid out at its final size, pages near the viewport are rendered first,
 * and a recompile redraws pages in place so the scroll position and the old image stay until the new one is ready.
 * Double-click a page to jump to the matching source line (SyncTeX).
 */
export function PdfViewer({ url, data, zoom, nav, syncPoint, onLoaded, onScale, onPageChange, onSourceJump }: {
  url: string; data?: Uint8Array | null; zoom: Zoom; nav: { page: number; n: number };
  syncPoint: { page: number; x: number; y: number } | null;
  onLoaded: (pages: number) => void; onScale: (pct: number) => void; onPageChange: (page: number) => void;
  onSourceJump: (page: number, x: number, y: number) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const cb = useRef({ onLoaded, onScale, onPageChange, onSourceJump });
  cb.current = { onLoaded, onScale, onPageChange, onSourceJump };
  const [doc, setDoc] = useState<Loaded | null>(null);
  const docRef = useRef<Loaded | null>(null);
  docRef.current = doc;
  const [err, setErr] = useState('');
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [visible, setVisible] = useState<Set<number>>(new Set([0, 1]));

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    let raf = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => setBox({ w: el.clientWidth, h: el.clientHeight })); });
    ro.observe(el);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, []);

  // Load the new document while the old one stays on screen; swap only once its page sizes are known.
  useEffect(() => {
    let cancelled = false, task: any = null;
    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        task = pdfjs.getDocument(data ? { data: data.slice() } : url); // slice: pdf.js takes ownership of the buffer
        const pdf = await task.promise;
        const sizes = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1).then((p: any) => { const v = p.getViewport({ scale: 1 }); return { w: v.width, h: v.height }; })));
        if (cancelled) { pdf.destroy(); return; }
        setErr('');
        // The old document stays alive briefly for renders and clicks that started before the swap.
        setDoc(prev => { if (prev) window.setTimeout(() => prev.pdf.destroy(), 5000); return { pdf, sizes }; });
        cb.current.onLoaded(pdf.numPages);
      } catch (e: any) {
        if (cancelled) return;
        setErr(e?.status === 404 || /Missing PDF|404/.test(String(e?.message)) ? 'No compiled PDF was found. Recompile the project to generate it.' : e instanceof Error ? `Couldn’t display the PDF: ${e.message}` : 'Couldn’t display the PDF.');
      }
    })();
    return () => { cancelled = true; task?.destroy?.().catch?.(() => undefined); };
  }, [url, data]);
  useEffect(() => () => { setDoc(prev => { prev?.pdf.destroy(); return null; }); }, []);

  const widest = doc ? Math.max(...doc.sizes.map(s => s.w)) : 612;
  const first = doc?.sizes[0] ?? { w: 612, h: 792 };
  const scale = zoom === 'fit' ? Math.max(0.3, (box.w - PAD * 2) / widest)
    : zoom === 'page' ? Math.max(0.2, Math.min((box.w - PAD * 2) / first.w, (box.h - PAD * 2) / first.h))
      : zoom / 100;
  useEffect(() => { if (box.w) cb.current.onScale(Math.round(scale * 100)); }, [scale, box.w]);

  // Track which pages are near the viewport (render those) and which page the reader is on.
  useEffect(() => {
    const root = boxRef.current;
    if (!root || !doc) return;
    const io = new IntersectionObserver(entries => {
      setVisible(prev => {
        const next = new Set(prev);
        for (const e of entries) { const i = Number((e.target as HTMLElement).dataset.index); if (e.isIntersecting) next.add(i); else next.delete(i); }
        return next;
      });
    }, { root, rootMargin: '100% 0px' });
    pageRefs.current.slice(0, doc.sizes.length).forEach(el => el && io.observe(el));
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const mark = root.scrollTop + root.clientHeight / 3;
        let current = 1;
        pageRefs.current.slice(0, doc.sizes.length).forEach((el, i) => { if (el && el.offsetTop <= mark) current = i + 1; });
        cb.current.onPageChange(current);
      });
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => { io.disconnect(); root.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf); };
  }, [doc, scale]);

  // Page buttons and SyncTeX scroll to a page; the scroll position is otherwise left alone across recompiles.
  useLayoutEffect(() => {
    const el = pageRefs.current[nav.page - 1], root = boxRef.current;
    if (nav.n && el && root) root.scrollTop = el.offsetTop - PAD;
  }, [nav.n]);
  useLayoutEffect(() => {
    if (!syncPoint || !doc) return;
    const el = pageRefs.current[syncPoint.page - 1], root = boxRef.current, size = doc.sizes[syncPoint.page - 1];
    if (!el || !root || !size) return;
    root.scrollTop = Math.max(0, el.offsetTop + (size.h - syncPoint.y) * scale - root.clientHeight / 2);
  }, [syncPoint, doc]);

  const jump = async (index: number, event: React.MouseEvent<HTMLDivElement>) => {
    const current = docRef.current;
    if (!current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const at = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    // A recompile can swap the document mid-click; then retry once with the newest one.
    for (const docNow of [current, docRef.current]) {
      if (!docNow) continue;
      try {
        const page = await docNow.pdf.getPage(index + 1);
        const [x, y] = page.getViewport({ scale }).convertToPdfPoint(at.x, at.y);
        cb.current.onSourceJump(index + 1, x, y);
        return;
      } catch { /* destroyed by a newer compile; try the current document */ }
    }
  };

  if (err && !doc) return <div className="pdf-scroll" ref={boxRef}><div className="pdf-error" role="alert"><AlertCircle size={18} /><span>{err}</span></div></div>;
  return <div className="pdf-scroll" ref={boxRef}>
    {!doc && <div className="pane-loading overlay">Rendering PDF…</div>}
    {err && <div className="pdf-error" role="alert"><AlertCircle size={18} /><span>{err}</span></div>}
    <div className="pdf-pages" style={{ gap: GAP }}>
      {doc?.sizes.map((s, i) => <div key={i} data-index={i} ref={el => { pageRefs.current[i] = el; }} className="pdf-page" style={{ width: Math.floor(s.w * scale), height: Math.floor(s.h * scale) }}
        title="Double-click to jump to the source" onDoubleClick={e => void jump(i, e)}>
        <PdfPage pdf={doc.pdf} index={i} scale={scale} active={visible.has(i)} />
        {syncPoint?.page === i + 1 && <span className="sync-marker" style={{ left: syncPoint.x * scale - 6, top: (s.h - syncPoint.y) * scale - 6 }} aria-hidden />}
      </div>)}
    </div>
  </div>;
}

/** One page. Renders off screen and then copies the result in, so a recompile replaces the image without a blank frame. */
function PdfPage({ pdf, index, scale, active }: { pdf: any; index: number; scale: number; active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawn = useRef<{ pdf: any; scale: number } | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!active || (drawn.current?.pdf === pdf && drawn.current?.scale === scale)) return;
    let task: any = null, cancelled = false;
    (async () => {
      try {
        const page = await pdf.getPage(index + 1);
        if (cancelled) return;
        const dpr = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale });
        const off = document.createElement('canvas');
        off.width = Math.floor(viewport.width * dpr); off.height = Math.floor(viewport.height * dpr);
        task = page.render({ canvasContext: off.getContext('2d')!, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
        await task.promise;
        const canvas = canvasRef.current;
        if (cancelled || !canvas) return;
        canvas.width = off.width; canvas.height = off.height;
        canvas.getContext('2d')!.drawImage(off, 0, 0);
        drawn.current = { pdf, scale };
        setReady(true);
      } catch (e: any) { if (e?.name !== 'RenderingCancelledException' && !cancelled) console.warn('PDF page render failed', e); }
    })();
    return () => { cancelled = true; task?.cancel?.(); };
  }, [pdf, scale, active, index]);
  return <canvas ref={canvasRef} aria-label={`PDF page ${index + 1}`} className={ready ? '' : 'is-loading'} />;
}
