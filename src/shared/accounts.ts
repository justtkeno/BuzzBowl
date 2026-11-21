// Account and profile types shared by the server and the client. Plain JSON.

import type { CategoryStats, Mode } from './types';
import type { BadgeState, Visibility } from './profile';

export const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
export const PASSWORD_MIN = 8;
export const BIO_MAX = 200;

/** Badge rewards a player picked: ids from PROFILE_COLORS and AVATAR_FRAMES (the defaults when not picked or no longer unlocked). */
export interface Look {
  color: string;
  frame: string;
}

/** The logged-in user, as they see themselves. */
export interface Me extends Look {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  createdAt: number;
  /** Site admin (the creator): can take the host seat in any room and moderate accounts. */
  admin: boolean;
  /** Admins only: true when the server pins admins to account ids (ADMIN_ACCOUNT_IDS), false when it goes by username. */
  adminLocked?: boolean;
  /** Last room settings used as host, synced across devices. */
  settings: Record<string, unknown> | null;
  /** Who can see their stats, badges and games. */
  visibility: Visibility;
  /** Stat ids pinned to the top of their profile (see PIN_STATS). */
  pinned: string[];
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
  /** The daily challenge's number when this game was that day's challenge. */
  daily?: number;
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

export interface PublicProfile extends Look {
  username: string;
  displayName: string;
  bio: string;
  createdAt: number;
  /** Shows the creator badge. */
  admin: boolean;
  totals: ProfileTotals;
  /** Subjects sorted best first. Only subjects with enough tossups heard get ranked. */
  subjects: SubjectStats[];
  bestSubject: string | null;
  recent: GameRecord[];
  /** Daily challenge record, once they've played one while logged in. */
  daily?: DailyProfile;
  /** Stat ids they pinned to the top. */
  pinned: string[];
  badges: BadgeState[];
  /** Only sent to the owner (and admins), who see the full profile whatever the setting. */
  visibility?: Visibility;
  /** Admins only: a site admin unlocked badges for this account. */
  badgesUnlocked?: boolean;
}

/** What others see of a profile that isn't open to them (the color and frame are cosmetic, so they still show). */
export interface LockedProfile extends Look {
  username: string;
  displayName: string;
  createdAt: number;
  admin: boolean;
  locked: Exclude<Visibility, 'public'>;
}

export type ProfileView = PublicProfile | LockedProfile;
export const isLocked = (p: ProfileView): p is LockedProfile => 'locked' in p;

/** One finished daily challenge on a profile. */
export interface DailyDay { day: string; number: number; points: number; rank: number; players: number; marks: string }

export interface DailyProfile {
  played: number;
  /** Finished #1 on a day that's over, with at least one other player. */
  wins: number;
  /** Finished in the top 3 on a day that's over, with at least three players. */
  podiums: number;
  bestRank: number;
  bestScore: number;
  avgPoints: number;
  /** Days in a row played, up to today (or yesterday, if today isn't played yet). */
  streak: number;
  longestStreak: number;
  /** Currently #1 on today's leaderboard (it can still change until midnight Eastern). */
  leadingToday: boolean;
  /** Dailies where every tossup was answered correctly. */
  perfect: number;
  recent: DailyDay[];
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

// ---------- friends ----------

/** Friends plus pending requests (both ways) per account. */
export const FRIENDS_MAX = 200;

/** Where a friend is right now. Daily-challenge rooms are never shown, so nobody can join or watch one. */
export type FriendStatus = 'offline' | 'online' | 'room' | 'daily';

export interface FriendRoom {
  code: string;
  /** lobby: not started yet; playing: a game is running; over: on the results screen. */
  phase: 'lobby' | 'playing' | 'over';
  mode: Mode;
  /** People connected in the room (bots not counted). */
  players: number;
}

export interface Friend extends Look {
  username: string;
  displayName: string;
  admin: boolean;
  status: FriendStatus;
  room?: FriendRoom;
}

export interface FriendRequest extends Look {
  username: string;
  displayName: string;
  admin: boolean;
  at: number;
}

export interface FriendsList {
  friends: Friend[];
  /** Requests waiting on you. */
  incoming: FriendRequest[];
  /** Requests you sent that haven't been accepted. */
  outgoing: FriendRequest[];
}
