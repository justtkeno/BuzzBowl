// Survival: an endless solo run of tossups that ends after three misses. The room works out each run
// from real buzzes; this keeps the leaderboards (all time and this week, best run per player).

import type { SurvivalBoard, SurvivalEntry, SurvivalStatus } from '../../shared/types';
import type { SurvivalProfile } from '../../shared/accounts';
import type { SurvivalOutcome } from '../rooms/room';
import { dayKey } from '../daily/daily';
import type { SurvivalRow, SurvivalStore } from './store';

export const BOARD_SIZE = 20;

/** The Monday (US Eastern) of the week `day` is in. Weekly boards start then. */
export function weekStart(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  const back = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - back * 86_400_000).toISOString().slice(0, 10);
}

const toEntry = (r: SurvivalRow, rank: number): SurvivalEntry => ({
  rank, name: r.name, username: r.username, correct: r.correct, tossups: r.tossups, points: r.points, powers: r.powers, at: r.createdAt,
});

export class Survival {
  /** playerKey → code of their run in progress, so a reload (or Play from the home page) goes back to it. */
  readonly active = new Map<string, string>();
  readonly ready: Promise<void>;

  constructor(private store: SurvivalStore) {
    this.ready = store.init().catch((e) => console.error('Survival storage failed to start:', e));
  }
  /** An account's new username, on its past runs. */
  async rename(playerKey: string, username: string) { await this.ready; await this.store.rename(playerKey, username); }


  private async board(playerKey: string | null, fromDay: string | null): Promise<SurvivalBoard> {
    const [rows, players, mine] = await Promise.all([
      this.store.top(fromDay, BOARD_SIZE), this.store.count(fromDay), playerKey ? this.store.best(playerKey, fromDay) : null,
    ]);
    return {
      entries: rows.map((r, i) => toEntry(r, i + 1)),
      players,
      me: mine ? toEntry(mine, await this.store.rankOf(mine, fromDay)) : null,
    };
  }

  async status(playerKey: string | null, running = false, now = new Date()): Promise<SurvivalStatus> {
    await this.ready;
    const from = weekStart(dayKey(now));
    const [allTime, week] = await Promise.all([this.board(playerKey, null), this.board(playerKey, from)]);
    return { allTime, week, weekStart: from, running };
  }

  /** A player's best run for their profile, or null if they've never finished one. */
  async profile(playerKey: string): Promise<SurvivalProfile | null> {
    await this.ready;
    const best = await this.store.best(playerKey, null);
    if (!best) return null;
    const [runs, rank, players] = await Promise.all([this.store.runs(playerKey), this.store.rankOf(best, null), this.store.count(null)]);
    return { runs, rank, players, best: { correct: best.correct, tossups: best.tossups, points: best.points, powers: best.powers, at: best.createdAt } };
  }

  async record(o: SurvivalOutcome, username?: string) {
    if (this.active.get(o.playerKey) === o.code) this.active.delete(o.playerKey);
    if (!o.tossups) return; // ended before the first tossup: nothing to rank
    await this.ready;
    const at = Date.now();
    await this.store.addRun({
      playerKey: o.playerKey, name: username ?? o.name, username, day: dayKey(new Date(at)), correct: o.correct, tossups: o.tossups,
      points: o.points, powers: o.powers, tens: o.tens, negs: o.negs, marks: o.marks, createdAt: at,
    });
  }
}
