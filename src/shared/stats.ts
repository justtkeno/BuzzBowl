// Owner stats: one small summary per finished game, plus anonymous daily visitor counts.

/** What kind of game it was, for the "popular modes" list. */
export type GameKind = 'room' | 'daily' | 'survival';

export interface GameSummary {
  at: number;
  /** US Eastern date (YYYY-MM-DD), the same day boundary as the daily challenge. */
  day: string;
  kind: GameKind;
  mode: 'ffa' | 'teams';
  /** Free-for-all with topic voting. */
  party: boolean;
  source: string;
  /** Human players who played (heard a tossup or buzzed). */
  players: number;
  bots: number;
  reader: boolean;
  tossups: number;
  bonuses: number;
  bounty: boolean;
  /** Set game length, 0 for none. */
  length: number;
  /** Left before the end (cleaned up or closed after at least 3 tossups). */
  abandoned: boolean;
}

export interface StatsDay { day: string; visitors: number; games: number; players: number }

export interface StatsView {
  /** Oldest first, one entry per day, including days with nothing. */
  days: StatsDay[];
  today: StatsDay;
  last7: { visitors: number; games: number; players: number };
  last30: { visitors: number; games: number; players: number; finished: number; abandoned: number; avgPlayers: number; withBots: number };
  /** Last 30 days, most played first. */
  modes: { label: string; games: number }[];
  allTime: { games: number; since: string | null };
}
