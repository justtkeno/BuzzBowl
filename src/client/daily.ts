import { useCallback, useEffect, useState } from 'react';
import type { DailyEntry, DailyStatus } from '../shared/types';
import { call, socket } from './socket';

const KEY = 'qb:dailyKey';

/** A random id this browser keeps, so guests get one daily attempt each (accounts use their account). */
export function dailyKey(): string {
  try {
    let k = localStorage.getItem(KEY);
    if (!k || !/^[a-z0-9]{12,40}$/i.test(k)) {
      k = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
      localStorage.setItem(KEY, k);
    }
    return k;
  } catch {
    return 'nostorage' + Math.random().toString(36).slice(2, 14);
  }
}

export function useDailyStatus(enabled = true) {
  const [status, setStatus] = useState<DailyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    call<{ status: DailyStatus }>('daily:status', { key: dailyKey() }).then((r) => { setStatus(r.status); setError(null); }, (e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!enabled) return;
    if (socket.connected) refresh();
    socket.on('connect', refresh);
    return () => { socket.off('connect', refresh); };
  }, [enabled, refresh]);
  return { status, error, refresh };
}

const EMOJI: Record<string, string> = { P: '⚡', T: '🟩', N: '🟥', Z: '🟧', '-': '⬜' };
export const marksEmoji = (marks: string) => [...marks].map((m) => EMOJI[m] ?? '⬜').join('');
export const MARK_LABEL: Record<string, string> = { P: 'power', T: 'ten', N: 'neg', Z: 'wrong, no penalty', '-': 'no buzz' };

export function shareText(number: number, me: DailyEntry) {
  return `BuzzBowl Daily #${number} · ${me.points} pts\n${marksEmoji(me.marks)}\n${location.origin}/daily`;
}

export function untilText(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.max(1, Math.round((seconds % 3600) / 60));
  return h ? `${h}h ${m}m` : `${m}m`;
}
