import { useEffect, useState } from 'react';
import { TEXT_SIZE_LABEL, setTextSizeChoice, setThemeChoice } from '../App';
import { prefs } from '../socket';
import { Icon } from './Icon';

type Size = keyof typeof TEXT_SIZE_LABEL;
type Theme = 'auto' | 'light' | 'dark';
const THEMES: [Theme, string][] = [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']];

/** Question text size and theme for this device, with a sample line that shows the size as you pick. */
function DisplayOptions() {
  const [size, setSize] = useState<Size>(prefs.textSize());
  const [theme, setTheme] = useState<Theme>((prefs.theme() as Theme) ?? 'auto');
  return (
    <div className="display-options">
      <div className="display-group">
        <div className="display-label">Question text</div>
        <div className="seg display-seg" role="radiogroup" aria-label="Question text size">
          {(Object.keys(TEXT_SIZE_LABEL) as Size[]).map((k) => (
            <button key={k} role="radio" aria-checked={size === k} className={size === k ? 'on' : ''} onClick={() => { setTextSizeChoice(k); setSize(k); }}>
              <span className={`display-aa aa-${k}`} aria-hidden="true">Aa</span>{TEXT_SIZE_LABEL[k]}
            </button>
          ))}
        </div>
        <p className="qtext display-preview">This planet’s two small moons are named for the sons of a war god.</p>
      </div>
      <div className="display-group">
        <div className="display-label">Theme</div>
        <div className="seg display-seg" role="radiogroup" aria-label="Theme">
          {THEMES.map(([k, label]) => (
            <button key={k} role="radio" aria-checked={theme === k} className={theme === k ? 'on' : ''} onClick={() => { setThemeChoice(k); setTheme(k); }}>{label}</button>
          ))}
        </div>
        <p className="muted small display-note">Auto follows your phone or computer’s light or dark setting.</p>
      </div>
    </div>
  );
}

/** Computers: the Aa button in the top bar opens these options as a small pop-up. */
export function DisplayMenu() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <div className="menu-wrap hide-sm">
      <button className="btn ghost" onClick={() => setOpen(!open)} aria-expanded={open} title="Display: text size and theme" aria-label="Display: text size and theme">Aa</button>
      {open && (
        <>
          <div className="menu-back" onClick={() => setOpen(false)} />
          <div className="menu display-menu" role="dialog" aria-label="Display">
            <div className="display-head">Display</div>
            <DisplayOptions />
          </div>
        </>
      )}
    </div>
  );
}

/** Phones: the same options in a panel, opened from Display in the ⋯ menu. */
export function DisplayPanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal display-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Display">
        <div className="row between">
          <h2>Display</h2>
          <button className="btn ghost icon close-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </div>
        <DisplayOptions />
        <div className="row end"><button className="btn primary" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}
