// Keyboard shortcuts for this device. Each action has one key (a KeyboardEvent.code, so it works the same on
// any keyboard layout's letters); players can change them in Settings → Keyboard shortcuts.
import { useEffect, useState } from 'react';

export const KEY_ACTIONS = [
  { id: 'buzz', label: 'Buzz', hint: 'For the reader, it pauses or resumes reading', def: 'Space' },
  { id: 'next', label: 'Next tossup', hint: 'Also Start now in a topic vote, and Skip for the host', def: 'KeyN' },
  { id: 'nextWord', label: 'Next word', hint: 'Host or reader, while a question is read', def: 'ArrowRight' },
  { id: 'accept', label: 'Accept answer', hint: 'The reader, when ruling', def: 'KeyA' },
  { id: 'prompt', label: 'Prompt', hint: 'The reader, when ruling', def: 'KeyP' },
  { id: 'reject', label: 'Reject answer', hint: 'The reader, when ruling', def: 'KeyR' },
] as const;
export type KeyAction = (typeof KEY_ACTIONS)[number]['id'];
export type KeyBindings = Record<KeyAction, string>;

/** Keys that keep their own job: closing panels, submitting answers, moving focus, and 1–9 for voting. */
const RESERVED = new Set(['Escape', 'Enter', 'NumpadEnter', 'Tab', ...Array.from({ length: 9 }, (_, i) => `Digit${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `Numpad${i + 1}`)]);
const MODIFIERS = /^(Shift|Control|Alt|Meta|CapsLock|OS|Fn)/;

const STORE = 'qb:keys';
const DEFAULTS = Object.fromEntries(KEY_ACTIONS.map((a) => [a.id, a.def])) as KeyBindings;

export function keyBindings(): KeyBindings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Partial<KeyBindings>;
    const out = { ...DEFAULTS };
    for (const a of KEY_ACTIONS) if (typeof saved[a.id] === 'string' && saved[a.id]) out[a.id] = saved[a.id]!;
    return out;
  } catch { return { ...DEFAULTS }; }
}

function save(b: KeyBindings) {
  try { localStorage.setItem(STORE, JSON.stringify(b)); } catch { /* private mode: lasts until reload */ }
  window.dispatchEvent(new Event('qb-keys'));
}

/** Give `action` the key `code`. A key another action used is swapped over, so no two actions share one. */
export function setKeyBinding(action: KeyAction, code: string): { ok: true; swapped?: KeyAction } | { ok: false; error: string } {
  if (RESERVED.has(code)) return { ok: false, error: `${keyLabel(code)} is kept for ${/Digit|Numpad[1-9]/.test(code) ? 'voting on topics' : code === 'Escape' ? 'closing panels' : code === 'Tab' ? 'moving between buttons' : 'submitting answers'}.` };
  if (MODIFIERS.test(code)) return { ok: false, error: 'Pick a key you can press on its own.' };
  const b = keyBindings();
  const other = (Object.keys(b) as KeyAction[]).find((k) => k !== action && b[k] === code);
  if (other) b[other] = b[action];
  b[action] = code;
  save(b);
  return other ? { ok: true, swapped: other } : { ok: true };
}

export function resetKeyBindings() { save({ ...DEFAULTS }); }

/** A key code as people say it: "N", "Space", "→". */
export function keyLabel(code: string): string {
  const m = code.match(/^Key([A-Z])$/) ?? code.match(/^Digit(\d)$/) ?? code.match(/^Numpad(\d)$/);
  if (m) return m[1];
  const named: Record<string, string> = {
    Space: 'Space', ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓', Backspace: 'Backspace', Backquote: '`',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  };
  return named[code] ?? code.replace(/^Numpad/, 'Num ');
}

/** The current bindings, updating when they change (in this tab or the settings panel). */
export function useKeyBindings(): KeyBindings {
  const [b, setB] = useState(keyBindings);
  useEffect(() => {
    const f = () => setB(keyBindings());
    window.addEventListener('qb-keys', f);
    window.addEventListener('storage', f);
    return () => { window.removeEventListener('qb-keys', f); window.removeEventListener('storage', f); };
  }, []);
  return b;
}
