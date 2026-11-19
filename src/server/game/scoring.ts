import type { BuzzKind, CategoryStats, PlayerStats, Ruling, Settings } from '../../shared/types';

export interface ParsedTossup {
  words: string[];
  /** Number of words before the (*) power marker, or null when there is none. */
  powerIndex: number | null;
}

export function parseTossupText(text: string): ParsedTossup {
  const words: string[] = [];
  let powerIndex: number | null = null;
  for (const token of text.trim().split(/\s+/)) {
    if (!token) continue;
    if (token === '(*)') { powerIndex ??= words.length; continue; }
    if (token.includes('(*)')) {
      const word = token.replace('(*)', '');
      if (token.startsWith('(*)')) { powerIndex ??= words.length; if (word) words.push(word); }
      else { if (word) words.push(word); powerIndex ??= words.length; }
      continue;
    }
    words.push(token);
  }
  return { words, powerIndex };
}

type ScoreSettings = Pick<Settings, 'powers' | 'negs' | 'powerValue' | 'tenValue' | 'negValue'>;

/**
 * Score a tossup buzz. `revealed` is how many words had been read when the player buzzed.
 * A buzz is in power while the (*) has not been passed (revealed <= powerIndex);
 * a wrong answer is a neg only if the question was not finished.
 */
export function scoreTossup(
  correct: boolean,
  revealed: number,
  totalWords: number,
  powerIndex: number | null,
  s: ScoreSettings,
): { points: number; kind: BuzzKind } {
  if (correct) {
    if (s.powers && powerIndex !== null && revealed <= powerIndex) return { points: s.powerValue, kind: 'power' };
    return { points: s.tenValue, kind: 'ten' };
  }
  if (s.negs && revealed < totalWords) return { points: s.negValue, kind: 'neg' };
  return { points: 0, kind: 'zero' };
}

export interface HeardEntry {
  num: number;
  category: string;
  playerIds: string[];
}

export interface Adjustment {
  playerId: string;
  teamId: string;
  delta: number;
  /** Tossup number when the adjustment was made. */
  num?: number;
}

const emptyCat = (): CategoryStats => ({ heard: 0, points: 0, powers: 0, tens: 0, negs: 0 });

export function emptyStats(): PlayerStats {
  return { points: 0, powers: 0, tens: 0, negs: 0, buzzes: 0, heard: 0, avgCorrectDepth: null, categories: {} };
}

/** Derive every player's stats from the rulings log, so host overrides stay consistent. */
export function computePlayerStats(
  playerIds: string[],
  rulings: Ruling[],
  adjustments: Adjustment[],
  heard: HeardEntry[],
): Record<string, PlayerStats> {
  const out: Record<string, PlayerStats> = {};
  const depths: Record<string, number[]> = {};
  for (const id of playerIds) { out[id] = emptyStats(); depths[id] = []; }
  const cat = (st: PlayerStats, c: string) => (st.categories[c] ??= emptyCat());

  for (const h of heard) {
    for (const id of h.playerIds) {
      const st = out[id];
      if (!st) continue;
      st.heard++;
      cat(st, h.category).heard++;
    }
  }
  for (const r of rulings) {
    if (r.type !== 'tossup') continue;
    const st = out[r.playerId];
    if (!st) continue;
    const c = cat(st, r.category);
    st.buzzes++;
    st.points += r.points;
    c.points += r.points;
    if (r.kind === 'power') { st.powers++; c.powers++; }
    if (r.kind === 'ten') { st.tens++; c.tens++; }
    if (r.kind === 'neg') { st.negs++; c.negs++; }
    if (r.correct && r.totalWords) depths[r.playerId].push(Math.min(1, (r.wordIndex ?? 0) / r.totalWords));
  }
  for (const a of adjustments) if (out[a.playerId]) out[a.playerId].points += a.delta;
  for (const id of playerIds) {
    const d = depths[id];
    out[id].avgCorrectDepth = d.length ? d.reduce((x, y) => x + y, 0) / d.length : null;
  }
  return out;
}

export function computeTeamTotals(teamId: string, rulings: Ruling[], adjustments: Adjustment[]) {
  let points = 0;
  let bonusPoints = 0;
  let bonusPartsCorrect = 0;
  const bonuses = new Set<number>();
  for (const r of rulings) {
    if (r.teamId !== teamId) continue;
    points += r.points;
    if (r.type === 'bonus') {
      bonusPoints += r.points;
      bonuses.add(r.num);
      if (r.correct) bonusPartsCorrect++;
    }
  }
  for (const a of adjustments) if (a.teamId === teamId) points += a.delta;
  return { points, bonusPoints, bonusesHeard: bonuses.size, bonusPartsCorrect };
}
