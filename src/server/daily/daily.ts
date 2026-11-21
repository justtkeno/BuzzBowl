// The daily challenge: every day the server picks 10 tossups once and stores them, so everyone plays
// the same set. Results are worked out by the room from real buzzes and stored one per player per day.

import type { DailyEntry, DailyStatus, Filters } from '../../shared/types';
import type { DailyProfile } from '../../shared/accounts';
import type { DailyOutcome } from '../rooms/room';
import { CATALOG_TOSSUPS } from '../questions/catalog';
import { SAMPLE_TOSSUPS } from '../questions/sample';
import type { QuestionProvider, Tossup } from '../questions/types';
import type { DailyRow, DailyStore } from './store';

export const DAILY_SIZE = 10;
/** Days roll over at midnight US Eastern time. */
const ZONE = 'America/New_York';
/** Challenge #1. */
const LAUNCH = '2026-11-19';
/** A spread of categories so each day feels like a mini packet. */
const CATEGORY_PLAN = ['Literature', 'History', 'Science', 'Fine Arts', 'Geography', 'Religion', 'Mythology', 'Social Science', 'Philosophy', 'Science'];
/** Easy and regular high school: friendly, still pyramidal. */
const DIFFICULTIES = [2, 3];

export function dayKey(at = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}
export function dailyNumber(day: string): number {
  const ms = Date.parse(`${day}T00:00:00Z`) - Date.parse(`${LAUNCH}T00:00:00Z`);
  return Math.max(1, Math.round(ms / 86_400_000) + 1);
}
/** Seconds until the next day starts in ZONE. */
export function secondsUntilNextDay(now = new Date()): number {
  const today = dayKey(now);
  let lo = now.getTime(), hi = lo + 26 * 3600_000;
  while (hi - lo > 200) { const mid = (lo + hi) / 2; if (dayKey(new Date(mid)) === today) lo = mid; else hi = mid; }
  return Math.round((hi - now.getTime()) / 1000);
}

/** Same order for everyone on a given day (used when QBReader is unreachable). */
function seededShuffle<T>(xs: T[], seed: string): T[] {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const toEntry = (r: DailyRow, rank: number): DailyEntry => ({
  rank, name: r.name, username: r.username, points: r.points, powers: r.powers, tens: r.tens, negs: r.negs, marks: r.marks, depth: r.depth,
});

export class Daily {
  private building = new Map<string, Promise<Tossup[]>>();
  /** playerKey → code of their in-progress daily room, so a reload resumes it. */
  readonly active = new Map<string, string>();

  /** Storage is loaded before anything reads or writes it. */
  readonly ready: Promise<void>;

  constructor(private store: DailyStore, private qbreader: QuestionProvider) {
    this.ready = store.init().catch((e) => console.error('Daily challenge storage failed to start:', e));
  }

  today() { return dayKey(); }

  /** Today's tossups: from the store, or picked now (once, even if many people ask at the same moment). */
  set(day = this.today()): Promise<Tossup[]> {
    let p = this.building.get(day);
    if (!p) {
      p = (async () => { await this.ready; return (await this.store.getSet(day)) ?? this.store.putSet(day, await this.pick(day)); })();
      p.catch(() => this.building.delete(day));
      this.building.set(day, p);
      for (const k of this.building.keys()) if (k < day) this.building.delete(k);
    }
    return p;
  }

  private async pick(day: string): Promise<Tossup[]> {
    const seen = new Set<string>();
    const out: Tossup[] = [];
    const tryFetch = async (filters: Filters) => {
      try {
        const q = await this.qbreader.nextTossup(filters, seen);
        if (q && !seen.has(q.id)) { seen.add(q.id); out.push(q); return true; }
      } catch { /* fall through */ }
      return false;
    };
    for (const category of CATEGORY_PLAN) {
      if (out.length >= DAILY_SIZE) break;
      if (!(await tryFetch({ categories: [category], subcategories: [], difficulties: DIFFICULTIES }))) {
        if (!(await tryFetch({ categories: [], subcategories: [], difficulties: DIFFICULTIES }))) break; // QBReader is down
      }
    }
    if (out.length < DAILY_SIZE) {
      for (const t of seededShuffle([...SAMPLE_TOSSUPS, ...CATALOG_TOSSUPS], day)) {
        if (out.length >= DAILY_SIZE) break;
        if (!seen.has(t.id)) { seen.add(t.id); out.push(t); }
      }
    }
    return out;
  }

  async result(day: string, playerKey: string) { await this.ready; return this.store.result(day, playerKey); }

  async status(playerKey: string | null, day = this.today()): Promise<DailyStatus> {
    await this.ready;
    const [set, rows, players, mine] = await Promise.all([
      this.set(day), this.store.top(day, 25), this.store.count(day), playerKey ? this.store.result(day, playerKey) : null,
    ]);
    return {
      day, number: dailyNumber(day), total: set.length, players,
      leaderboard: rows.map((r, i) => toEntry(r, i + 1)),
      me: mine ? toEntry(mine, await this.store.rankOf(mine)) : null,
      nextIn: secondsUntilNextDay(),
    };
  }

  /** A player's daily challenge record for their profile, or null if they've never played. */
  async profile(playerKey: string): Promise<DailyProfile | null> {
    await this.ready;
    const h = await this.store.history(playerKey);
    if (!h.length) return null;
    const today = this.today();
    // Only finished days count as wins; today's leader can still be passed.
    const over = h.filter((x) => x.row.day < today);
    const days = new Set(h.map((x) => x.row.day));
    let streak = 0;
    for (let d = days.has(today) ? today : prevDay(today); days.has(d); d = prevDay(d)) streak++;
    let longestStreak = 0, run = 0, last = '';
    for (const d of [...days].sort()) { run = last && prevDay(d) === last ? run + 1 : 1; longestStreak = Math.max(longestStreak, run); last = d; }
    const points = h.map((x) => x.row.points);
    return {
      played: h.length,
      wins: over.filter((x) => x.rank === 1 && x.players >= 2).length,
      podiums: over.filter((x) => x.rank <= 3 && x.players >= 3).length,
      bestRank: Math.min(...h.map((x) => x.rank)),
      bestScore: Math.max(...points),
      avgPoints: points.reduce((a, b) => a + b, 0) / points.length,
      streak, longestStreak,
      leadingToday: h[0].row.day === today && h[0].rank === 1 && h[0].players >= 2,
      perfect: h.filter((x) => /^[PT]+$/.test(x.row.marks)).length,
      recent: h.slice(0, 7).map((x) => ({ day: x.row.day, number: dailyNumber(x.row.day), points: x.row.points, rank: x.rank, players: x.players, marks: x.row.marks })),
    };
  }

  async record(o: DailyOutcome, username?: string) {
    this.active.delete(o.playerKey);
    await this.ready;
    await this.store.addResult({
      day: o.day, playerKey: o.playerKey, name: username ?? o.name, username, points: o.points, powers: o.powers, tens: o.tens,
      negs: o.negs, marks: o.marks, depth: o.depth, createdAt: Date.now(),
    });
  }
}

const prevDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** Accounts play as themselves; guests are identified by a random key their browser keeps. */
export function playerKeyFor(accountId: string | undefined, guestKey: unknown): string | null {
  if (accountId) return `a:${accountId}`;
  const k = String(guestKey ?? '');
  return /^[a-z0-9]{12,40}$/i.test(k) ? `g:${k}` : null;
}
