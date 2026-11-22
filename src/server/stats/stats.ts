import { createHash } from 'node:crypto';
import type { GameSummary, StatsDay, StatsView } from '../../shared/stats';
import { dayKey } from '../daily/daily';
import type { StatsStore } from './store';

/** "2026-11-22" minus n days, in the same YYYY-MM-DD form. */
export function daysBefore(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** How a game reads in the "popular modes" list. */
export function modeLabel(g: GameSummary): string {
  if (g.kind === 'daily') return 'Daily challenge';
  if (g.kind === 'survival') return 'Survival';
  if (g.source === 'lightning') return 'Lightning round';
  if (g.source === 'upload') return 'Uploaded packet';
  if (g.party) return 'Party';
  if (g.reader) return g.mode === 'teams' ? 'Teams with a reader' : 'Free-for-all with a reader';
  if (g.players <= 1) return g.bots ? 'Solo with bots' : 'Solo practice';
  return g.mode === 'teams' ? 'Teams' : 'Free-for-all';
}

/**
 * Counts for the site owner. Visitors are distinct devices (or accounts) that opened the home screen each day,
 * stored only as a salted hash, so no names or ids are kept.
 */
export class Stats {
  ready: Promise<void>;
  constructor(private store: StatsStore, private salt = 'trivio-stats') {
    this.ready = store.init().catch((e) => console.error('Stats store unavailable:', e));
  }

  async recordGame(g: GameSummary) {
    await this.ready;
    await this.store.addGame(g).catch((e) => console.error('Could not record game stats:', e));
  }

  /** Count a device (or account) once per day. `key` is the player key the daily challenge already uses. */
  async visit(key: string | null, at = new Date()) {
    if (!key) return;
    await this.ready;
    const device = createHash('sha256').update(`${this.salt}:${key}`).digest('base64url').slice(0, 16);
    await this.store.addVisit(dayKey(at), device).catch((e) => console.error('Could not record a visit:', e));
  }

  async view(now = new Date(), days = 14): Promise<StatsView> {
    await this.ready;
    const today = dayKey(now);
    const from30 = daysBefore(today, 29);
    const [games, visitors, totals, unique7, unique30] = await Promise.all([
      this.store.games(from30), this.store.visitors(from30), this.store.totals(),
      this.store.uniqueVisitors(daysBefore(today, 6)), this.store.uniqueVisitors(from30),
    ]);
    const dayStats = (day: string): StatsDay => {
      const g = games.filter((x) => x.day === day);
      return { day, visitors: visitors[day] ?? 0, games: g.length, players: g.reduce((n, x) => n + x.players, 0) };
    };
    const span = (n: number, unique: number) => ({ g: games.filter((x) => x.day >= daysBefore(today, n - 1)), visitors: unique });
    const w = span(7, unique7), m = span(30, unique30);
    const counts = new Map<string, number>();
    for (const g of m.g) counts.set(modeLabel(g), (counts.get(modeLabel(g)) ?? 0) + 1);
    const players30 = m.g.reduce((n, x) => n + x.players, 0);
    return {
      days: Array.from({ length: days }, (_, i) => dayStats(daysBefore(today, days - 1 - i))),
      today: dayStats(today),
      last7: { visitors: w.visitors, games: w.g.length, players: w.g.reduce((n, x) => n + x.players, 0) },
      last30: {
        visitors: m.visitors, games: m.g.length, players: players30,
        finished: m.g.filter((x) => !x.abandoned).length, abandoned: m.g.filter((x) => x.abandoned).length,
        avgPlayers: m.g.length ? Math.round((players30 / m.g.length) * 10) / 10 : 0,
        withBots: m.g.filter((x) => x.bots > 0).length,
      },
      modes: [...counts].map(([label, n]) => ({ label, games: n })).sort((a, b) => b.games - a.games),
      allTime: totals,
    };
  }

  flush() { this.store.flush(); }
}
