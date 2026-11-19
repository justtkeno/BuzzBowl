// Account and profile types shared by the server and the client. Plain JSON.

import type { CategoryStats, Mode } from './types';

export const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
export const PASSWORD_MIN = 8;
export const BIO_MAX = 200;

/** The logged-in user, as they see themselves. */
export interface Me {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  createdAt: number;
  /** Last room settings used as host, synced across devices. */
  settings: Record<string, unknown> | null;
}

/** One finished game, from one account's point of view. */
export interface GameRecord {
  at: number;
  room: string;
  mode: Mode;
  /** Number of competing sides (teams, or players in free-for-all), bots included. */
  sides: number;
  /** 1 = first place. Ties share a rank. */
  rank: number;
  /** Side names in finishing order with their scores, for the recent-games list. */
  standings: { name: string; points: number; you: boolean }[];
  /** True when the game stopped because everyone left, not because the host ended it. */
  abandoned?: boolean;
  tossups: number;
  points: number;
  powers: number;
  tens: number;
  negs: number;
  buzzes: number;
  heard: number;
  /** Sum of buzz depth (0..1) over correct buzzes, so averages combine across games. */
  correctDepthSum: number;
  bestStreak: number;
  bonusPoints: number;
  bonusesHeard: number;
  categories: Record<string, CategoryStats>;
}

export interface SubjectStats extends CategoryStats {
  category: string;
  /** Points per tossup heard in this subject. */
  ppth: number;
  /** Fraction of tossups heard that this player converted. */
  conversion: number;
}

export interface ProfileTotals {
  games: number;
  /** Games with at least two sides, where winning means something. */
  competitive: number;
  wins: number;
  podiums: number;
  points: number;
  powers: number;
  tens: number;
  negs: number;
  buzzes: number;
  heard: number;
  bonusPoints: number;
  bonusesHeard: number;
  avgCorrectDepth: number | null;
  bestGame: number;
  bestStreak: number;
}

export interface PublicProfile {
  username: string;
  displayName: string;
  bio: string;
  createdAt: number;
  totals: ProfileTotals;
  /** Subjects sorted best first. Only subjects with enough tossups heard get ranked. */
  subjects: SubjectStats[];
  bestSubject: string | null;
  recent: GameRecord[];
}

/** Need this many tossups heard in a subject before it can be "best subject". */
export const BEST_SUBJECT_MIN_HEARD = 10;

/** Fold a list of games into profile totals and subject rankings. */
export function summarize(games: GameRecord[]): Pick<PublicProfile, 'totals' | 'subjects' | 'bestSubject'> {
  const t: ProfileTotals = {
    games: games.length, competitive: 0, wins: 0, podiums: 0, points: 0, powers: 0, tens: 0, negs: 0, buzzes: 0, heard: 0,
    bonusPoints: 0, bonusesHeard: 0, avgCorrectDepth: null, bestGame: 0, bestStreak: 0,
  };
  let depthSum = 0;
  const cats: Record<string, CategoryStats> = {};
  for (const g of games) {
    if (g.sides >= 2) {
      t.competitive++;
      if (g.rank === 1) t.wins++;
      if (g.rank <= 3 && g.sides >= 3) t.podiums++;
    }
    t.points += g.points; t.powers += g.powers; t.tens += g.tens; t.negs += g.negs;
    t.buzzes += g.buzzes; t.heard += g.heard; t.bonusPoints += g.bonusPoints; t.bonusesHeard += g.bonusesHeard;
    depthSum += g.correctDepthSum;
    t.bestGame = Math.max(t.bestGame, g.points);
    t.bestStreak = Math.max(t.bestStreak, g.bestStreak);
    for (const [name, c] of Object.entries(g.categories ?? {})) {
      const into = (cats[name] ??= { heard: 0, points: 0, powers: 0, tens: 0, negs: 0 });
      into.heard += c.heard; into.points += c.points; into.powers += c.powers; into.tens += c.tens; into.negs += c.negs;
    }
  }
  const correct = t.powers + t.tens;
  t.avgCorrectDepth = correct ? depthSum / correct : null;
  const subjects: SubjectStats[] = Object.entries(cats)
    .filter(([, c]) => c.heard > 0)
    .map(([category, c]) => ({ category, ...c, ppth: c.points / c.heard, conversion: (c.powers + c.tens) / c.heard }))
    .sort((a, b) => {
      const ar = a.heard >= BEST_SUBJECT_MIN_HEARD ? 1 : 0;
      const br = b.heard >= BEST_SUBJECT_MIN_HEARD ? 1 : 0;
      return br - ar || b.ppth - a.ppth || b.heard - a.heard;
    });
  const top = subjects[0];
  const bestSubject = top && top.heard >= BEST_SUBJECT_MIN_HEARD && top.points > 0 ? top.category : null;
  return { totals: t, subjects, bestSubject };
}
