import { useEffect, useState } from 'react';
import type { BuzzMarker, PublicState } from '../../shared/types';
import { call, serverNow } from '../socket';

/** Re-render on an interval while `active` (for countdowns). */
export function useNow(active: boolean, ms = 100) {
  const [now, setNow] = useState(serverNow());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(serverNow()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return active ? now : serverNow();
}

export function roles(s: PublicState) {
  const me = s.you;
  const isHost = !!me && me === s.hostId;
  const isReader = !!me && me === s.readerId;
  const readerOnline = !!s.readerId && !!s.players.find((p) => p.id === s.readerId)?.online;
  const myTeam = s.players.find((p) => p.id === me)?.teamId ?? null;
  return {
    me, isHost, isReader, readerOnline, myTeam,
    isController: isHost || isReader,
    canDirect: readerOnline ? isHost || isReader : true,
  };
}

/** Fire an action; surface errors as a toast. */
export function act(event: string, ...args: unknown[]) {
  call(event, ...args).catch((e) => toast(e.message));
}

export function toast(msg: string) {
  window.dispatchEvent(new CustomEvent('qb-toast', { detail: msg }));
}

export const resultLabel: Record<BuzzMarker['result'], string> = {
  power: '15', ten: '10', neg: '−5', zero: '0', pending: '…', prompt: '?',
};

export const fmtPct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);

/** A stable, readable color per player (or team) id, for buzz flashes, pins and graph lines. */
const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6'];
export function colorFor(id: string, order?: string[]) {
  const i = order ? order.indexOf(id) : -1;
  if (i >= 0) return PALETTE[i % PALETTE.length];
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** Short haptic tap on phones that support it. */
export function vibrate(pattern: number | number[]) {
  try { navigator.vibrate?.(pattern); } catch { /* not supported */ }
}

export const isTouch = () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
