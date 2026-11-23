// Levels: experience (XP) from every finished game saved to an account, and what each level unlocks.
// XP is worked out from saved games (so games played before levels existed count too), then kept as a running
// total on the account.

import type { GameRecord } from './accounts';

/** Tossups heard that count toward one game's XP (stops marathon games from running away). */
const HEARD_CAP = 60;
/** A win or podium pays in full from this many tossups heard; shorter games pay a share. */
const FULL_GAME = 20;

export interface XpPart { label: string; xp: number }

/** The XP one finished game is worth, in parts (for "how did I get this"). */
export function xpParts(g: GameRecord): XpPart[] {
  const heard = Math.max(0, Math.min(HEARD_CAP, g.heard ?? 0));
  const share = Math.min(1, heard / FULL_GAME);
  const parts: XpPart[] = [];
  const add = (label: string, xp: number) => { if (xp > 0) parts.push({ label, xp: Math.round(xp) }); };
  add('Tossups played', heard * 2);
  add('Powers', (g.powers ?? 0) * 6);
  add('Tens', (g.tens ?? 0) * 4);
  add('Bonuses', Math.floor((g.bonusPoints ?? 0) / 10));
  if (g.sides >= 2 && !g.abandoned) {
    if (g.rank === 1) add('Win', 25 * share);
    else if (g.rank <= 3 && g.sides >= 3) add('Top 3', 10 * share);
  }
  if (g.daily) add('Daily challenge', 30);
  return parts;
}

export const xpForGame = (g: GameRecord) => xpParts(g).reduce((n, p) => n + p.xp, 0);

export const MAX_LEVEL = 100;

/** XP needed to go from `level` to the next one: 100, then 25 more each level. */
export const xpToNext = (level: number) => 100 + 25 * (level - 1);

export interface LevelInfo {
  level: number;
  /** Total XP. */
  xp: number;
  /** XP into this level, and how much this level takes (0 at the max level). */
  into: number;
  need: number;
  title: string;
}

export function levelFor(xp: number): LevelInfo {
  let level = 1;
  let left = Math.max(0, Math.floor(xp));
  while (level < MAX_LEVEL && left >= xpToNext(level)) { left -= xpToNext(level); level++; }
  return { level, xp: Math.max(0, Math.floor(xp)), into: level < MAX_LEVEL ? left : 0, need: level < MAX_LEVEL ? xpToNext(level) : 0, title: titleFor(level) };
}

/** Total XP at the start of `level`. */
export function xpAtLevel(level: number) {
  let n = 0;
  for (let l = 1; l < Math.min(level, MAX_LEVEL); l++) n += xpToNext(l);
  return n;
}

/** Titles shown under the name, from the level they start at. */
export const LEVEL_TITLES: { level: number; title: string }[] = [
  { level: 1, title: 'Rookie' },
  { level: 5, title: 'Buzzer' },
  { level: 10, title: 'Scholar' },
  { level: 15, title: 'Ace' },
  { level: 20, title: 'Expert' },
  { level: 30, title: 'Master' },
  { level: 40, title: 'Grandmaster' },
  { level: 50, title: 'Legend' },
  { level: 75, title: 'Mythic' },
];

export function titleFor(level: number) {
  let t = LEVEL_TITLES[0].title;
  for (const x of LEVEL_TITLES) if (level >= x.level) t = x.title;
  return t;
}

/** Levels where something new opens up: a title, a profile color or an avatar frame (see PROFILE_COLORS / AVATAR_FRAMES). */
export const MILESTONES = [3, 5, 8, 10, 12, 15, 18, 20, 25, 30, 35, 40, 50, 75];

/** What reaching a level after `from` up to `to` unlocked, as short names ("Scholar title", "Mint color"). */
export function unlockedBetween(from: number, to: number, rewards: { name: string; level?: number; kind: string }[]): string[] {
  const out: string[] = [];
  for (const t of LEVEL_TITLES) if (t.level > from && t.level <= to) out.push(`${t.title} title`);
  for (const r of rewards) if (r.level && r.level > from && r.level <= to) out.push(`${r.name} ${r.kind}`);
  return out;
}
