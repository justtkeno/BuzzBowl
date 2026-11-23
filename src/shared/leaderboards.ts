// Leaderboards: three boards (wins, correct answers, daily challenge), each for today, this week,
// this month or all time. Only signed-in players with public profiles are listed.

export const BOARDS = [
  { id: 'wins', label: 'Wins', title: 'Most wins', about: 'First place in a game against at least one other person (not just bots).' },
  { id: 'correct', label: 'Correct', title: 'Most correct answers', about: 'Tossups answered correctly in any game, solo practice included.' },
  { id: 'daily', label: 'Daily', title: 'Daily challenge', about: 'Points from Today’s challenge, added up over the days you played.' },
] as const;
export type BoardKind = (typeof BOARDS)[number]['id'];

export const PERIODS = [
  { id: 'day', label: 'Today' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'all', label: 'All time' },
] as const;
export type BoardPeriod = (typeof PERIODS)[number]['id'];

export const isBoard = (x: unknown): x is BoardKind => BOARDS.some((b) => b.id === x);
export const isPeriod = (x: unknown): x is BoardPeriod => PERIODS.some((p) => p.id === x);

export const BOARD_SIZE = 25;

export interface BoardEntry {
  /** Ties share a rank. */
  rank: number;
  username: string;
  displayName: string;
  color: string;
  frame: string;
  title?: string;
  /** Wins, correct answers, or daily points. */
  value: number;
  /** Wins: games against people. Correct: powers. Daily: days played. */
  extra: number;
}

export interface BoardView {
  board: BoardKind;
  period: BoardPeriod;
  /** First US Eastern day counted (YYYY-MM-DD), or null for all time. */
  from: string | null;
  entries: BoardEntry[];
  /** Everyone ranked on this board for this period. */
  players: number;
  /** The viewer's own row, also when they're below the top. */
  me: BoardEntry | null;
  /** Why the viewer has no row: not signed in, a private profile, or nothing counted yet. */
  meNote?: 'guest' | 'private' | 'none';
}
