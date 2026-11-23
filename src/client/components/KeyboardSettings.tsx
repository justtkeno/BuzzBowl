import { useEffect, useState } from 'react';
import { KEY_ACTIONS, keyLabel, resetKeyBindings, setKeyBinding, useKeyBindings, type KeyAction } from '../keys';

/** Settings → Keyboard shortcuts: every key the game listens to, and a way to change the main ones. */
export function KeyboardSettings() {
  const keys = useKeyBindings();
  const [waiting, setWaiting] = useState<KeyAction | null>(null);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);

  // While waiting for a key, catch it before anything else does (Esc would close the panel, Space would buzz).
  useEffect(() => {
    if (!waiting) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.code === 'Escape') { setWaiting(null); setNote(null); return; }
      if (/^(Shift|Control|Alt|Meta)/.test(e.code)) return; // wait for the real key
      const r = setKeyBinding(waiting, e.code);
      const label = KEY_ACTIONS.find((a) => a.id === waiting)!.label;
      if (!r.ok) { setNote({ text: r.error, bad: true }); return; }
      setWaiting(null);
      setNote({ text: r.swapped ? `${label} is now ${keyLabel(e.code)}. ${KEY_ACTIONS.find((a) => a.id === r.swapped)!.label} took its old key.` : `${label} is now ${keyLabel(e.code)}.` });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [waiting]);

  const changed = KEY_ACTIONS.some((a) => keys[a.id] !== a.def);
  return (
    <div className="as-body keys-body">
      <p className="muted small as-note">For playing on a computer. Saved on this device. Keys don’t work while you’re typing in a box.</p>
      <ul className="key-list">
        {KEY_ACTIONS.map((a) => (
          <li key={a.id}>
            <span className="key-what"><b>{a.label}</b><small>{a.hint}</small></span>
            <button type="button" className={`btn small key-btn ${waiting === a.id ? 'waiting' : ''}`} aria-label={`${a.label}: ${keyLabel(keys[a.id])}. Change`}
              onClick={() => { setWaiting(waiting === a.id ? null : a.id); setNote(null); }}>
              {waiting === a.id ? 'Press a key…' : <kbd>{keyLabel(keys[a.id])}</kbd>}
            </button>
          </li>
        ))}
        <li className="fixed"><span className="key-what"><b>Vote on a topic</b><small>Picks the 1st, 2nd or 3rd choice</small></span><span className="key-fixed"><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd></span></li>
        <li className="fixed"><span className="key-what"><b>Submit an answer</b><small>In the answer box</small></span><span className="key-fixed"><kbd>Enter</kbd></span></li>
        <li className="fixed"><span className="key-what"><b>Close a panel</b><small>Settings, review, menus</small></span><span className="key-fixed"><kbd>Esc</kbd></span></li>
      </ul>
      {waiting && <p className="small muted" role="status">Press the new key for {KEY_ACTIONS.find((a) => a.id === waiting)!.label.toLowerCase()}, or Esc to cancel.</p>}
      {note && <p className={`small ${note.bad ? 'error' : 'muted'}`} role="status">{note.text}</p>}
      <div className="row end">
        <button type="button" className="btn ghost small" disabled={!changed} onClick={() => { resetKeyBindings(); setWaiting(null); setNote({ text: 'Back to the default keys.' }); }}>Reset to defaults</button>
      </div>
    </div>
  );
}
