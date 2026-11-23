import { useEffect, useRef, useState } from 'react';
import { uploadAvatar } from '../account';
import { Icon } from './Icon';

/** Size of the saved picture, in pixels (square). */
const OUT = 256;
/** Size of the framing view on screen. */
const VIEW = 240;

/**
 * "Choose photo": opens the phone's photo library (or camera, or files), then a small framing step:
 * drag to move, slider or pinch to zoom. Saves a 256 px square JPEG, made here so the upload stays small.
 */
export function PhotoPicker({ onSaved, label = 'Choose photo' }: { onSaved: () => void; label?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const pick = (f: File | undefined) => {
    setErr(null);
    if (!f) return;
    if (!f.type.startsWith('image/') && !/\.(heic|heif)$/i.test(f.name)) return setErr('Pick a photo.');
    const url = URL.createObjectURL(f);
    const im = new Image();
    im.onload = () => setImg(im);
    im.onerror = () => { URL.revokeObjectURL(url); setErr('That photo can’t be opened here. Try another one, or a screenshot of it.'); };
    im.src = url;
  };
  const close = () => { if (img) URL.revokeObjectURL(img.src); setImg(null); if (input.current) input.current.value = ''; };

  return (
    <>
      <button type="button" className="btn small" onClick={() => input.current?.click()}>{label}</button>
      <input ref={input} type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files?.[0])} />
      {err && <span className="error small">{err}</span>}
      {img && <Framer img={img} onClose={close} onSaved={() => { close(); onSaved(); }} />}
    </>
  );
}

function Framer({ img, onClose, onSaved }: { img: HTMLImageElement; onClose: () => void; onSaved: () => void }) {
  // The photo covers the view at zoom 1; x/y move its center, in view pixels.
  const base = VIEW / Math.min(img.naturalWidth, img.naturalHeight);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; zoom: number } | null>(null);

  const scale = base * zoom;
  const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
  /** Keep the photo covering the whole circle. */
  const clamp = (p: { x: number; y: number }, z = zoom) => {
    const s = base * z;
    const mx = Math.max(0, (img.naturalWidth * s - VIEW) / 2), my = Math.max(0, (img.naturalHeight * s - VIEW) / 2);
    return { x: Math.max(-mx, Math.min(mx, p.x)), y: Math.max(-my, Math.min(my, p.y)) };
  };
  const zoomTo = (z: number) => { const nz = Math.max(1, Math.min(4, z)); setZoom(nz); setPos((p) => clamp(p, nz)); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const down = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom };
    }
  };
  const move = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      zoomTo(pinch.current.zoom * Math.hypot(a.x - b.x, a.y - b.y) / pinch.current.d);
    } else if (pointers.current.size === 1) {
      setPos((p) => clamp({ x: p.x + e.clientX - prev.x, y: p.y + e.clientY - prev.y }));
    }
  };
  const up = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const c = document.createElement('canvas');
      c.width = c.height = OUT;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, OUT, OUT);
      ctx.imageSmoothingQuality = 'high';
      const k = OUT / VIEW;
      ctx.drawImage(img, (VIEW / 2 + pos.x - w / 2) * k, (VIEW / 2 + pos.y - h / 2) * k, w * k, h * k);
      const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/jpeg', 0.86));
      if (!blob) throw new Error('Could not make the picture. Try another photo.');
      await uploadAvatar(blob);
      onSaved();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal photo-modal" role="dialog" aria-label="Frame your picture">
        <div className="row between">
          <h2>Frame your picture</h2>
          <button type="button" className="btn ghost icon close-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </div>
        <div className="photo-view" style={{ width: VIEW, height: VIEW }}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
          onWheel={(e) => zoomTo(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08))}>
          <img src={img.src} alt="" draggable={false}
            style={{ width: w, height: h, transform: `translate(${VIEW / 2 + pos.x - w / 2}px, ${VIEW / 2 + pos.y - h / 2}px)` }} />
        </div>
        <label className="photo-zoom">
          <span className="muted small">Zoom</span>
          <input type="range" min={1} max={4} step={0.01} value={zoom} onChange={(e) => zoomTo(Number(e.target.value))} aria-label="Zoom" />
        </label>
        <p className="muted small">Drag to move. Everyone can see your picture, so keep it friendly.</p>
        {err && <p className="error small">{err}</p>}
        <div className="row gap">
          <button type="button" className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Use this picture'}</button>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
