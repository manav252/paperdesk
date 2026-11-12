import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { toSyncTexPoint } from './lib/synctex';
import { ownerHeaders } from './lib/api';
import { findInPdf, type HitSegment, type PdfMatch, type PdfTextItem } from './lib/pdfSearch';

export type Zoom = number | 'fit' | 'page';
type Size = { w: number; h: number };
type Loaded = { pdf: any; sizes: Size[] };
const GAP = 16,
  PAD = 20;

let pdfjsLoad: Promise<any> | null = null;
export function loadPdfjs() {
  pdfjsLoad ??= import('pdfjs-dist').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
    return pdfjs;
  });
  return pdfjsLoad;
}

/**
 * Continuous PDF preview: every page is laid out at its final size, pages near the viewport are rendered first,
 * and a recompile redraws pages in place so the scroll position and the old image stay until the new one is ready.
 * Click or select text on a page to jump to the matching source line (SyncTeX).
 */
export function PdfViewer({
  url,
  data,
  zoom,
  nav,
  syncPoint,
  searchOpen = false,
  onSearchClose,
  onLoaded,
  onScale,
  onPageChange,
  onSourceJump,
  onRenderTime,
}: {
  url: string;
  data?: Uint8Array | null;
  zoom: Zoom;
  nav: { page: number; n: number };
  syncPoint: { page: number; x: number; y: number; width?: number; height?: number; n?: number } | null;
  onLoaded: (pages: number) => void;
  onScale: (pct: number) => void;
  onPageChange: (page: number) => void;
  onSourceJump: (page: number, x: number, y: number) => void;
  onRenderTime?: (ms: number) => void;
  searchOpen?: boolean;
  onSearchClose?: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const cb = useRef({ onLoaded, onScale, onPageChange, onSourceJump, onRenderTime });
  cb.current = { onLoaded, onScale, onPageChange, onSourceJump, onRenderTime };
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
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  // Load the new document while the old one stays on screen; swap only once its page sizes are known.
  useEffect(() => {
    let cancelled = false,
      task: any = null;
    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        task = pdfjs.getDocument(data ? { data: data.slice() } : { url, httpHeaders: ownerHeaders() }); // slice: pdf.js takes ownership of the buffer
        const pdf = await task.promise;
        const sizes = await Promise.all(
          Array.from({ length: pdf.numPages }, (_, i) =>
            pdf.getPage(i + 1).then((p: any) => {
              const v = p.getViewport({ scale: 1 });
              return { w: v.width, h: v.height };
            }),
          ),
        );
        if (cancelled) {
          pdf.destroy();
          return;
        }
        setErr('');
        // The old document stays alive briefly for renders and clicks that started before the swap.
        setDoc((prev) => {
          if (prev) window.setTimeout(() => prev.pdf.destroy(), 5000);
          return { pdf, sizes };
        });
        cb.current.onLoaded(pdf.numPages);
      } catch (e: any) {
        if (cancelled) return;
        setErr(
          e?.status === 404 || /Missing PDF|404/.test(String(e?.message))
            ? 'No compiled PDF was found. Recompile the project to generate it.'
            : e instanceof Error
              ? `Couldn’t display the PDF: ${e.message}`
              : 'Couldn’t display the PDF.',
        );
      }
    })();
    return () => {
      cancelled = true;
      task?.destroy?.().catch?.(() => undefined);
    };
  }, [url, data]);
  useEffect(
    () => () => {
      setDoc((prev) => {
        prev?.pdf.destroy();
        return null;
      });
    },
    [],
  );

  const widest = doc ? Math.max(...doc.sizes.map((s) => s.w)) : 612;
  const first = doc?.sizes[0] ?? { w: 612, h: 792 };
  const scale =
    zoom === 'fit'
      ? Math.max(0.3, (box.w - PAD * 2) / widest)
      : zoom === 'page'
        ? Math.max(0.2, Math.min((box.w - PAD * 2) / first.w, (box.h - PAD * 2) / first.h))
        : zoom / 100;
  useEffect(() => {
    if (box.w) cb.current.onScale(Math.round(scale * 100));
  }, [scale, box.w]);

  // Track which pages are near the viewport (render those) and which page the reader is on.
  useEffect(() => {
    const root = boxRef.current;
    if (!root || !doc) return;
    const io = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const i = Number((e.target as HTMLElement).dataset.index);
            if (e.isIntersecting) next.add(i);
            else next.delete(i);
          }
          return next;
        });
      },
      { root, rootMargin: '100% 0px' },
    );
    pageRefs.current.slice(0, doc.sizes.length).forEach((el) => el && io.observe(el));
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const mark = root.scrollTop + root.clientHeight / 3;
        let current = 1;
        pageRefs.current.slice(0, doc.sizes.length).forEach((el, i) => {
          if (el && el.offsetTop <= mark) current = i + 1;
        });
        cb.current.onPageChange(current);
      });
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => {
      io.disconnect();
      root.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, [doc, scale]);

  // Page buttons and SyncTeX scroll to a page; the scroll position is otherwise left alone across recompiles.
  useLayoutEffect(() => {
    const el = pageRefs.current[nav.page - 1],
      root = boxRef.current;
    if (nav.n && el && root) root.scrollTop = el.offsetTop - PAD;
  }, [nav.n]);
  useLayoutEffect(() => {
    if (!syncPoint || !doc) return;
    const el = pageRefs.current[syncPoint.page - 1],
      root = boxRef.current,
      size = doc.sizes[syncPoint.page - 1];
    if (!el || !root || !size) return;
    // SyncTeX measures y down from the top of the page, like the page box here.
    root.scrollTop = Math.max(
      0,
      el.offsetTop + (syncPoint.y - (syncPoint.height ?? 0) / 2) * scale - root.clientHeight / 2,
    );
  }, [syncPoint, doc]);

  // Search: match the text of every page; highlights are drawn in the text layers.
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<PdfMatch[]>([]);
  const [current, setCurrent] = useState(0);
  const [searching, setSearching] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (searchOpen) searchInput.current?.select();
    else {
      setQuery('');
      setMatches([]);
    }
  }, [searchOpen]);
  useEffect(() => {
    if (!doc || !searchOpen || !query.trim()) {
      setMatches([]);
      return;
    }
    let live = true;
    setSearching(true);
    const timer = window.setTimeout(
      () =>
        void pageTexts(doc.pdf).then(
          (pages) => {
            if (!live) return;
            const found = findInPdf(pages, query);
            setMatches(found);
            setCurrent((c) => Math.min(c, Math.max(0, found.length - 1)));
            setSearching(false);
          },
          () => {
            if (live) setSearching(false);
          },
        ),
      150,
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [doc, query, searchOpen]);
  useEffect(() => {
    setCurrent(0);
  }, [query]);
  // Keep the current match in view.
  useEffect(() => {
    const root = boxRef.current;
    if (!root || !matches.length) return;
    const raf = requestAnimationFrame(() => {
      const hit = root.querySelector('.pdf-search-hit.current');
      const page = pageRefs.current[(matches[current]?.page ?? 1) - 1];
      if (hit) {
        const r = hit.getBoundingClientRect(),
          box = root.getBoundingClientRect();
        if (r.top < box.top + 40 || r.bottom > box.bottom - 20)
          root.scrollTop += r.top - box.top - root.clientHeight / 2;
      } else if (page) root.scrollTop = page.offsetTop - PAD;
    });
    return () => cancelAnimationFrame(raf);
  }, [matches, current, scale]);
  const step = (by: number) => {
    if (matches.length) setCurrent((c) => (c + by + matches.length) % matches.length);
  };
  const hitsFor = (page: number) =>
    matches.flatMap((m, i) => (m.page === page ? m.segments.map((seg) => ({ ...seg, current: i === current })) : []));

  const jump = async (index: number, event: React.MouseEvent<HTMLDivElement>) => {
    const current = docRef.current;
    if (!current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const selection = window.getSelection();
    const selected =
      selection && !selection.isCollapsed && selection.rangeCount
        ? selection.getRangeAt(0).getBoundingClientRect()
        : null;
    const clientX = selected?.width ? selected.left + selected.width / 2 : event.clientX;
    const clientY = selected?.height ? selected.top + selected.height / 2 : event.clientY;
    const at = { x: clientX - rect.left, y: clientY - rect.top };
    // A recompile can swap the document mid-click; then retry once with the newest one.
    for (const docNow of [current, docRef.current]) {
      if (!docNow) continue;
      try {
        const page = await docNow.pdf.getPage(index + 1);
        // pdf.js gives PDF user space (origin bottom-left, y up); SyncTeX wants points from the top-left of the page.
        const [px, py] = page.getViewport({ scale }).convertToPdfPoint(at.x, at.y);
        const point = toSyncTexPoint(page.view, px, py);
        cb.current.onSourceJump(index + 1, point.x, point.y);
        return;
      } catch {
        /* destroyed by a newer compile; try the current document */
      }
    }
  };

  if (err && !doc)
    return (
      <div className="pdf-scroll" ref={boxRef}>
        <div className="pdf-error" role="alert">
          <AlertCircle size={18} />
          <span>{err}</span>
        </div>
      </div>
    );
  return (
    <div className="pdf-viewer">
      {searchOpen && (
        <div className="pdf-search" role="search">
          <Search size={14} aria-hidden />
          <input
            ref={searchInput}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the PDF"
            aria-label="Search the PDF"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                step(e.shiftKey ? -1 : 1);
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                onSearchClose?.();
              }
            }}
          />
          <span className="pdf-search-count" aria-live="polite">
            {!query.trim()
              ? ''
              : searching && !matches.length
                ? '…'
                : matches.length
                  ? `${current + 1} of ${matches.length}`
                  : 'No results'}
          </span>
          <button
            className="icon-btn sm"
            aria-label="Previous match"
            title="Previous match (Shift+Enter)"
            disabled={!matches.length}
            onClick={() => step(-1)}
          >
            <ChevronUp size={14} />
          </button>
          <button
            className="icon-btn sm"
            aria-label="Next match"
            title="Next match (Enter)"
            disabled={!matches.length}
            onClick={() => step(1)}
          >
            <ChevronDown size={14} />
          </button>
          <button className="icon-btn sm" aria-label="Close PDF search" title="Close (Esc)" onClick={onSearchClose}>
            <X size={14} />
          </button>
        </div>
      )}
      <div className="pdf-scroll" ref={boxRef}>
        {!doc && <div className="pane-loading overlay">Rendering PDF…</div>}
        {err && (
          <div className="pdf-error" role="alert">
            <AlertCircle size={18} />
            <span>{err}</span>
          </div>
        )}
        <div className="pdf-pages" style={{ gap: GAP }}>
          {doc?.sizes.map((s, i) => (
            <div
              key={i}
              data-index={i}
              ref={(el) => {
                pageRefs.current[i] = el;
              }}
              className="pdf-page"
              style={{ width: Math.floor(s.w * scale), height: Math.floor(s.h * scale) }}
              title="Click or select text to jump to the source"
              onClick={(e) => {
                if (!window.getSelection()?.toString()) void jump(i, e);
              }}
              onMouseUp={(e) => {
                if (window.getSelection()?.toString()) void jump(i, e);
              }}
            >
              <PdfPage
                pdf={doc.pdf}
                index={i}
                scale={scale}
                active={visible.has(i)}
                onRenderTime={cb.current.onRenderTime}
                hits={hitsFor(i + 1)}
              />
              {syncPoint?.page === i + 1 &&
                (syncPoint.width && syncPoint.height ? (
                  <span
                    key={syncPoint.n}
                    className="sync-highlight"
                    data-testid="sync-highlight"
                    style={{
                      left: syncPoint.x * scale - 2,
                      top: (syncPoint.y - syncPoint.height) * scale - 2,
                      width: syncPoint.width * scale + 4,
                      height: syncPoint.height * scale + 4,
                    }}
                    aria-hidden
                  />
                ) : (
                  <span
                    className="sync-marker"
                    data-testid="sync-highlight"
                    style={{ left: syncPoint.x * scale - 6, top: syncPoint.y * scale - 6 }}
                    aria-hidden
                  />
                ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Text items of every page, read once per document. */
const textCache = new WeakMap<object, Promise<PdfTextItem[][]>>();
function pageTexts(pdf: any) {
  let pages = textCache.get(pdf);
  if (!pages) {
    pages = Promise.all(
      Array.from({ length: pdf.numPages }, (_, i) =>
        pdf
          .getPage(i + 1)
          .then((page: any) => page.getTextContent())
          .then((content: any) =>
            content.items
              .filter((item: any) => typeof item.str === 'string' && item.str)
              .map((item: any) => ({ text: item.str, eol: !!item.hasEOL })),
          ),
      ),
    );
    textCache.set(pdf, pages);
  }
  return pages;
}

/** One page. Renders off screen and then copies the result in, so a recompile replaces the image without a blank frame. */
function PdfPage({
  pdf,
  index,
  scale,
  active,
  onRenderTime,
  hits,
}: {
  pdf: any;
  index: number;
  scale: number;
  active: boolean;
  onRenderTime?: (ms: number) => void;
  hits: (HitSegment & { current: boolean })[];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawn = useRef<{ pdf: any; scale: number } | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!active || (drawn.current?.pdf === pdf && drawn.current?.scale === scale)) return;
    let task: any = null,
      cancelled = false;
    (async () => {
      try {
        const page = await pdf.getPage(index + 1);
        if (cancelled) return;
        const renderStarted = performance.now();
        const dpr = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale });
        const off = document.createElement('canvas');
        off.width = Math.floor(viewport.width * dpr);
        off.height = Math.floor(viewport.height * dpr);
        task = page.render({
          canvasContext: off.getContext('2d')!,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        await task.promise;
        onRenderTime?.(Math.round(performance.now() - renderStarted));
        const canvas = canvasRef.current;
        if (cancelled || !canvas) return;
        canvas.width = off.width;
        canvas.height = off.height;
        canvas.getContext('2d')!.drawImage(off, 0, 0);
        drawn.current = { pdf, scale };
        setReady(true);
      } catch (e: any) {
        if (e?.name !== 'RenderingCancelledException' && !cancelled) console.warn('PDF page render failed', e);
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel?.();
    };
  }, [pdf, scale, active, index, onRenderTime]);
  return (
    <>
      <canvas ref={canvasRef} aria-label={`PDF page ${index + 1}`} className={ready ? '' : 'is-loading'} />
      <PdfTextLayer pdf={pdf} index={index} scale={scale} hits={hits} />
    </>
  );
}

function PdfTextLayer({
  pdf,
  index,
  scale,
  hits,
}: {
  pdf: any;
  index: number;
  scale: number;
  hits: (HitSegment & { current: boolean })[];
}) {
  const [items, setItems] = useState<
    { text: string; left: number; top: number; width: number; height: number; angle: number }[]
  >([]);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const page = await pdf.getPage(index + 1);
        const viewport = page.getViewport({ scale });
        const content = await page.getTextContent();
        if (!live) return;
        setItems(
          content.items
            .filter((item: any) => typeof item.str === 'string' && item.str)
            .map((item: any) => {
              const tx =
                (window as any).pdfjsLib?.Util?.transform?.(viewport.transform, item.transform) ??
                multiply(viewport.transform, item.transform);
              const height = Math.hypot(tx[2], tx[3]);
              return {
                text: item.str,
                left: tx[4],
                top: tx[5] - height,
                width: Math.max(1, item.width * scale),
                height,
                angle: Math.atan2(tx[1], tx[0]),
              };
            }),
        );
      } catch {
        if (live) setItems([]);
      }
    })();
    return () => {
      live = false;
    };
  }, [pdf, index, scale]);
  return (
    <div className="pdf-text-layer" aria-label={`Selectable text on PDF page ${index + 1}`}>
      {items.map((item, i) => (
        <span
          key={i}
          style={{
            left: item.left,
            top: item.top,
            width: item.width,
            height: item.height,
            fontSize: item.height,
            transform: `rotate(${item.angle}rad)`,
          }}
        >
          {item.text}
        </span>
      ))}
      {hits.map((hit, i) => {
        const item = items[hit.item];
        if (!item) return null;
        // Characters are spread evenly over the item's width, which is close enough for a highlight.
        const per = item.width / Math.max(1, item.text.length);
        return (
          <mark
            key={`h${i}`}
            className={`pdf-search-hit${hit.current ? ' current' : ''}`}
            aria-hidden
            style={{
              left: item.left + hit.start * per,
              top: item.top,
              width: Math.max(2, (hit.end - hit.start) * per),
              height: item.height,
              transform: `rotate(${item.angle}rad)`,
            }}
          />
        );
      })}
    </div>
  );
}

function multiply(a: number[], b: number[]) {
  return [
    a[0]! * b[0]! + a[2]! * b[1]!,
    a[1]! * b[0]! + a[3]! * b[1]!,
    a[0]! * b[2]! + a[2]! * b[3]!,
    a[1]! * b[2]! + a[3]! * b[3]!,
    a[0]! * b[4]! + a[2]! * b[5]! + a[4]!,
    a[1]! * b[4]! + a[3]! * b[5]! + a[5]!,
  ];
}
