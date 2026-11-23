// Leaderboards over saved games and daily results. Each board is worked out from the stores' per-account
// totals for the period, kept for a minute, and only lists accounts whose profile is public.

import { DEFAULT_COLOR, DEFAULT_FRAME } from '../../shared/profile';
import { BOARD_SIZE, type BoardEntry, type BoardKind, type BoardPeriod, type BoardView } from '../../shared/leaderboards';
import type { GameTotal } from '../accounts/store';
import type { DailyTotal } from '../daily/store';
import { dayKey } from '../daily/daily';
import { weekStart } from '../survival/survival';

export interface Person { username: string; displayName: string; public: boolean }
export interface Look { color: string; frame: string; pic?: string; title?: string }

export interface LeaderboardSources {
  gameTotals(fromAt: number | null): Promise<GameTotal[]>;
  dailyTotals(fromDay: string | null): Promise<DailyTotal[]>;
  people(ids: string[]): Promise<Map<string, Person>>;
  /** Avatar color, frame and equipped title, as their profile shows them. */
  looks(ids: string[]): Promise<Map<string, Look>>;
}

interface Row { userId: string; value: number; extra: number }
interface Ranked { rows: (Row & { rank: number })[]; hidden: Set<string>; from: string | null }

const CACHE_MS = 60_000;
const LOOK_MS = 5 * 60_000;

/** Midnight US Eastern at the start of `day`, as a timestamp. */
export function easternMidnight(day: string): number {
  for (const h of [4, 5]) {
    const t = Date.parse(`${day}T0${h}:00:00Z`);
    if (dayKey(new Date(t)) === day && dayKey(new Date(t - 1)) !== day) return t;
  }
  return Date.parse(`${day}T05:00:00Z`);
}

/** First day (US Eastern) a period covers: today, Monday, the 1st, or null for all time. */
export function periodStart(period: BoardPeriod, now = new Date()): string | null {
  const today = dayKey(now);
  if (period === 'day') return today;
  if (period === 'week') return weekStart(today);
  if (period === 'month') return `${today.slice(0, 8)}01`;
  return null;
}

/** Best first. Wins: fewer games breaks a tie. Correct: more powers. Daily: fewer days played. */
const ORDER: Record<BoardKind, (a: Row, b: Row) => number> = {
  wins: (a, b) => b.value - a.value || a.extra - b.extra,
  correct: (a, b) => b.value - a.value || b.extra - a.extra,
  daily: (a, b) => b.value - a.value || a.extra - b.extra,
};

export class Leaderboards {
  private cache = new Map<string, { at: number; v: Promise<Ranked> }>();
  private lookCache = new Map<string, { at: number; v: Look }>();

  constructor(private src: LeaderboardSources, private now = () => new Date()) {}

  /** A board as `viewerId` sees it (null for a guest). */
  async view(board: BoardKind, period: BoardPeriod, viewerId: string | null): Promise<BoardView> {
    const ranked = await this.ranked(board, period);
    const top = ranked.rows.slice(0, BOARD_SIZE);
    const mine = viewerId ? ranked.rows.find((r) => r.userId === viewerId) ?? null : null;
    const ids = [...new Set([...top.map((r) => r.userId), ...(mine ? [mine.userId] : [])])];
    const [people, looks] = await Promise.all([this.src.people(ids), this.looks(ids)]);
    const entry = (r: Row & { rank: number }): BoardEntry | null => {
      const p = people.get(r.userId);
      if (!p) return null;
      const l = looks.get(r.userId);
      return {
        rank: r.rank, username: p.username, displayName: p.displayName, color: l?.color ?? DEFAULT_COLOR, frame: l?.frame ?? DEFAULT_FRAME,
        ...(l?.pic ? { pic: l.pic } : {}), ...(l?.title ? { title: l.title } : {}), value: r.value, extra: r.extra,
      };
    };
    const view: BoardView = {
      board, period, from: ranked.from,
      entries: top.map(entry).filter((e): e is BoardEntry => !!e),
      players: ranked.rows.length,
      me: mine ? entry(mine) : null,
    };
    if (!view.me) view.meNote = !viewerId ? 'guest' : ranked.hidden.has(viewerId) ? 'private' : 'none';
    return view;
  }

  private ranked(board: BoardKind, period: BoardPeriod): Promise<Ranked> {
    const from = periodStart(period, this.now());
    const key = `${board}|${period}|${from}`;
    const hit = this.cache.get(key);
    if (hit && this.now().getTime() - hit.at < CACHE_MS) return hit.v;
    const v = this.compute(board, from);
    this.cache.set(key, { at: this.now().getTime(), v });
    v.catch(() => this.cache.delete(key));
    return v;
  }

  private async compute(board: BoardKind, from: string | null): Promise<Ranked> {
    let rows: Row[];
    if (board === 'daily') {
      rows = (await this.src.dailyTotals(from)).map((t) => ({ userId: t.playerKey.slice(2), value: t.points, extra: t.days }));
    } else {
      const totals = await this.src.gameTotals(from == null ? null : easternMidnight(from));
      rows = totals.map((t) => (board === 'wins' ? { userId: t.userId, value: t.wins, extra: t.versus } : { userId: t.userId, value: t.correct, extra: t.powers }));
    }
    rows = rows.filter((r) => r.value > 0);
    const people = await this.src.people(rows.map((r) => r.userId));
    const hidden = new Set(rows.filter((r) => people.get(r.userId)?.public === false).map((r) => r.userId));
    const order = ORDER[board];
    const shown = rows.filter((r) => people.get(r.userId)?.public).sort(order);
    let rank = 0;
    const out = shown.map((r, i) => {
      if (i === 0 || order(shown[i - 1], r) !== 0) rank = i + 1;
      return { ...r, rank };
    });
    return { rows: out, hidden, from };
  }

  private async looks(ids: string[]): Promise<Map<string, Look>> {
    const now = this.now().getTime();
    const out = new Map<string, Look>();
    const need = ids.filter((id) => {
      const c = this.lookCache.get(id);
      if (c && now - c.at < LOOK_MS) { out.set(id, c.v); return false; }
      return true;
    });
    if (need.length) {
      const fresh = await this.src.looks(need);
      for (const [id, v] of fresh) { out.set(id, v); this.lookCache.set(id, { at: now, v }); }
    }
    return out;
  }
}
