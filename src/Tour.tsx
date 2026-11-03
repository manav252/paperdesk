import { useEffect, useLayoutEffect, useState } from 'react';
import { X } from 'lucide-react';

export const TOUR_KEY = 'paperdesk-tour-done';
export type TourStep = { id: string; target: string; title: string; body: string };

export const TOUR_STEPS: TourStep[] = [
  { id: 'files', target: '.file-sidebar', title: 'Your project files', body: 'Every file in the project lives here: your .tex documents, the .bib file with your references, and images. Click a file to open it.' },
  { id: 'editor', target: '.editor-main', title: 'Write LaTeX here', body: 'This is the source of your document. Commands start with a backslash, like \\section{Introduction}. The toolbar above inserts common snippets.' },
  { id: 'compile', target: '.compile-main', title: 'Recompile to see your PDF', body: 'LaTeX turns your source into a PDF. Press Recompile (or Ctrl/⌘+Enter) whenever you want to see your changes.' },
  { id: 'pdf', target: '.pdf-workspace', title: 'Your PDF', body: 'The finished document appears here. Use the controls at the bottom to change page and zoom.' },
  { id: 'logs', target: '.logs-btn', title: 'Logs explain problems', body: 'If something goes wrong, Logs lists each error with the file and line. Click an error to jump to it, or ask for a plain-language explanation.' },
  { id: 'assistant', target: '.assistant-toggle', title: 'Ask the assistant', body: 'Stuck? The assistant answers LaTeX questions, explains errors and suggests fixes. It never changes your files until you click.' },
];

type Rect = { top: number; left: number; width: number; height: number };
const PAD = 6, CARD_W = 320, GAP = 12;

/** Measures the step's target and keeps the spotlight on it while the layout settles or the window resizes. */
function useTargetRect(selector: string) {
  const [rect, setRect] = useState<Rect | null>(null);
  useLayoutEffect(() => {
    let frame = 0;
    const measure = () => {
      const el = document.querySelector(selector);
      const r = el?.getBoundingClientRect();
      setRect(r && r.width && r.height ? { top: r.top, left: r.left, width: r.width, height: r.height } : null);
    };
    // Panels may still be opening for this step, so keep measuring for a moment.
    let n = 0;
    const loop = () => { measure(); if (++n < 20) frame = requestAnimationFrame(loop); };
    loop();
    window.addEventListener('resize', measure);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', measure); };
  }, [selector]);
  return rect;
}

function cardPosition(rect: Rect | null) {
  const vw = window.innerWidth, vh = window.innerHeight, w = Math.min(CARD_W, vw - 32);
  if (!rect) return { top: vh / 2 - 100, left: (vw - w) / 2, width: w };
  const clampX = (x: number) => Math.max(16, Math.min(vw - w - 16, x));
  const clampY = (y: number) => Math.max(16, Math.min(vh - 220, y));
  if (rect.left + rect.width + GAP + w <= vw - 16 && rect.width < vw * 0.5) return { top: clampY(rect.top), left: rect.left + rect.width + GAP + PAD, width: w };
  if (rect.left - GAP - w >= 16 && rect.width < vw * 0.5) return { top: clampY(rect.top), left: rect.left - GAP - PAD - w, width: w };
  if (rect.top + rect.height + 220 <= vh) return { top: rect.top + rect.height + GAP + PAD, left: clampX(rect.left), width: w };
  if (rect.top - 220 >= 0) return { top: rect.top - GAP - PAD - 200, left: clampX(rect.left), width: w };
  return { top: clampY(rect.top + 24), left: clampX(rect.left + 24), width: w };
}

/** Dims everything except the target with four panels, plus an outline around the target. */
function Spotlight({ rect }: { rect: Rect }) {
  const top = Math.max(0, rect.top - PAD), left = Math.max(0, rect.left - PAD);
  const bottom = rect.top + rect.height + PAD, right = rect.left + rect.width + PAD;
  return <>
    <div className="tour-dim" style={{ top: 0, left: 0, right: 0, height: top }} />
    <div className="tour-dim" style={{ top: bottom, left: 0, right: 0, bottom: 0 }} />
    <div className="tour-dim" style={{ top, left: 0, width: left, height: bottom - top }} />
    <div className="tour-dim" style={{ top, left: right, right: 0, height: bottom - top }} />
    <div className="tour-spotlight" style={{ top, left, width: right - left, height: bottom - top }} />
  </>;
}

export function Tour({ onStep, onClose }: { onStep: (step: TourStep) => void; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const step = TOUR_STEPS[index];
  const last = index === TOUR_STEPS.length - 1;
  useEffect(() => { onStep(step); }, [step]);
  const rect = useTargetRect(step.target);
  const card = cardPosition(rect);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); onClose(); }
      if (e.key === 'ArrowRight') setIndex(i => Math.min(TOUR_STEPS.length - 1, i + 1));
      if (e.key === 'ArrowLeft') setIndex(i => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);

  return <div className="tour-layer">
    {rect ? <Spotlight rect={rect} /> : <div className="tour-dim" />}
    <div className="tour-card" role="dialog" aria-modal="true" aria-label="Getting started tour" style={card}>
      <div className="tour-card-head"><span className="tour-count">{index + 1} of {TOUR_STEPS.length}</span><button className="icon-btn sm" aria-label="Close tour" title="Close tour" onClick={onClose}><X size={14} /></button></div>
      <h3>{step.title}</h3>
      <p>{step.body}</p>
      <div className="tour-actions">
        <button className="btn btn-ghost btn-sm" onClick={onClose}>Skip tour</button>
        <span className="toolbar-spacer" />
        {index > 0 && <button className="btn btn-secondary btn-sm" onClick={() => setIndex(index - 1)}>Back</button>}
        <button className="btn btn-primary btn-sm" autoFocus onClick={() => (last ? onClose() : setIndex(index + 1))}>{last ? 'Finish' : 'Next'}</button>
      </div>
    </div>
  </div>;
}
