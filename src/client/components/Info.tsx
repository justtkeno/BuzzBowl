import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GLOSSARY, type TermId } from '../glossary';

/**
 * A small ⓘ next to a term. Tap it for a short plain-English explanation; tap anywhere else (or Esc) to close.
 * The bubble is drawn on top of everything (portal), so it isn't cut off inside scrolling panels.
 */
export function Info({ term, className = '' }: { term: TermId; className?: string }) {
  const t = GLOSSARY[term];
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const place = () => {
      const r = btn.current!.getBoundingClientRect();
      const width = Math.min(280, window.innerWidth - 16);
      const left = Math.max(8, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 8));
      const h = tip.current?.offsetHeight ?? 120;
      const above = r.bottom + 8 + h > window.innerHeight && r.top - 8 - h > 0;
      setPos({ left, top: above ? r.top - 8 - h : r.bottom + 8, above });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (!btn.current?.contains(e.target as Node) && !tip.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', key, true); };
  }, [open]);

  return (
    <>
      <button ref={btn} type="button" className={`info-tip ${open ? 'on' : ''} ${className}`} aria-label={`What is “${t.title}”?`} aria-expanded={open}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(!open); }}>
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M8 7.2v3.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><circle cx="8" cy="4.9" r=".95" fill="currentColor" /></svg>
      </button>
      {open && createPortal(
        <div ref={tip} className="info-bubble" role="tooltip" style={pos ? { left: pos.left, top: pos.top, width: Math.min(280, window.innerWidth - 16) } : { visibility: 'hidden' }}
          onClick={(e) => e.stopPropagation()}>
          <b>{t.title}</b>
          <span>{t.text}</span>
        </div>,
        document.body,
      )}
    </>
  );
}
