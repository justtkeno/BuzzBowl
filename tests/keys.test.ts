import { beforeEach, describe, expect, it, vi } from 'vitest';
import { keyBindings, keyLabel, resetKeyBindings, setKeyBinding } from '../src/client/keys';

beforeEach(() => {
  const mem = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) });
  vi.stubGlobal('window', { dispatchEvent: () => true });
});

describe('keyboard shortcuts', () => {
  it('starts with the defaults', () => {
    expect(keyBindings()).toMatchObject({ buzz: 'Space', next: 'KeyN', nextWord: 'ArrowRight', accept: 'KeyA', prompt: 'KeyP', reject: 'KeyR' });
  });

  it('rebinds a key and keeps it', () => {
    expect(setKeyBinding('next', 'KeyJ')).toEqual({ ok: true });
    expect(keyBindings().next).toBe('KeyJ');
  });

  it('swaps instead of letting two actions share a key', () => {
    expect(setKeyBinding('next', 'Space')).toEqual({ ok: true, swapped: 'buzz' });
    const b = keyBindings();
    expect(b.next).toBe('Space');
    expect(b.buzz).toBe('KeyN');
  });

  it('refuses reserved and modifier keys', () => {
    for (const code of ['Escape', 'Enter', 'Tab', 'Digit2', 'Numpad3', 'ShiftLeft', 'ControlRight']) {
      expect(setKeyBinding('buzz', code).ok).toBe(false);
    }
    expect(keyBindings().buzz).toBe('Space');
  });

  it('resets to the defaults', () => {
    setKeyBinding('buzz', 'KeyB');
    resetKeyBindings();
    expect(keyBindings().buzz).toBe('Space');
  });

  it('ignores junk in storage', () => {
    localStorage.setItem('qb:keys', '{not json');
    expect(keyBindings().next).toBe('KeyN');
  });

  it('labels keys the way people say them', () => {
    expect(keyLabel('KeyN')).toBe('N');
    expect(keyLabel('Space')).toBe('Space');
    expect(keyLabel('ArrowRight')).toBe('→');
    expect(keyLabel('Digit7')).toBe('7');
    expect(keyLabel('Slash')).toBe('/');
  });
});
