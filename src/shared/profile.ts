// Profile extras shared by the server and the client: who can see a profile, the stats a player can pin,
// and badges. Badges are worked out from saved games and daily results, so they cover games played
// before badges existed.

import type { GameRecord, PublicProfile } from './accounts';

export type Visibility = 'public' | 'friends' | 'private';
export const VISIBILITIES: Visibility[] = ['public', 'friends', 'private'];
export const VISIBILITY_LABEL: Record<Visibility, string> = { public: 'Everyone', friends: 'Friends only', private: 'Only me' };

/** How many stats a player can pin to the top of their profile. */
export const PIN_MAX = 3;

const pct = (x: number) => `${Math.round(x * 100)}%`;
const fixed = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '–');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export interface StatValue { value: string; sub?: string }

/** Stats a player can pin. `get` returns null when the stat doesn't apply yet (shown as a dash). */
export const PIN_STATS: { id: string; label: string; get: (p: PublicProfile) => StatValue | null }[] = [
  { id: 'games', label: 'Games', get: (p) => ({ value: String(p.totals.games), sub: `${plural(p.totals.heard, 'tossup')} heard` }) },
  { id: 'wins', label: 'Wins', get: (p) => (p.totals.competitive ? { value: String(p.totals.wins), sub: `${pct(p.totals.wins / p.totals.competitive)} of games vs. others` } : null) },
  { id: 'ppg', label: 'Points / game', get: (p) => (p.totals.games ? { value: fixed(p.totals.points / p.totals.games), sub: `${p.totals.points} total` } : null) },
  { id: 'ppth', label: 'Points / tossup', get: (p) => (p.totals.heard ? { value: fixed(p.totals.points / p.totals.heard, 2), sub: 'PPTH' } : null) },
  { id: 'powers', label: 'Powers', get: (p) => ({ value: String(p.totals.powers), sub: `${plural(p.totals.tens, 'ten')} · ${plural(p.totals.negs, 'neg')}` }) },
  { id: 'accuracy', label: 'Buzz accuracy', get: (p) => (p.totals.buzzes ? { value: pct((p.totals.powers + p.totals.tens) / p.totals.buzzes), sub: `${p.totals.buzzes} buzzes` } : null) },
  { id: 'depth', label: 'Buzz depth', get: (p) => (p.totals.avgCorrectDepth != null ? { value: pct(p.totals.avgCorrectDepth), sub: 'into the question, on gets' } : null) },
  { id: 'bestGame', label: 'Best game', get: (p) => (p.totals.games ? { value: String(p.totals.bestGame), sub: 'points in one game' } : null) },
  { id: 'streak', label: 'Longest streak', get: (p) => (p.totals.games ? { value: String(p.totals.bestStreak), sub: 'correct in a row' } : null) },
  { id: 'ppb', label: 'Bonus PPB', get: (p) => (p.totals.bonusesHeard ? { value: fixed(p.totals.bonusPoints / p.totals.bonusesHeard), sub: `${p.totals.bonusesHeard} bonuses` } : null) },
  { id: 'bestSubject', label: 'Best subject', get: (p) => (p.bestSubject ? { value: p.bestSubject, sub: `${fixed(p.subjects[0].ppth, 2)} points per tossup` } : null) },
  { id: 'dailyWins', label: 'Daily 1st places', get: (p) => (p.daily ? { value: String(p.daily.wins), sub: p.daily.leadingToday ? 'and leading today' : plural(p.daily.played, 'daily') + ' played' } : null) },
  { id: 'dailyPodiums', label: 'Daily top 3s', get: (p) => (p.daily ? { value: String(p.daily.podiums), sub: 'finishes in the top 3' } : null) },
  { id: 'dailyPlayed', label: 'Dailies played', get: (p) => (p.daily ? { value: String(p.daily.played), sub: `avg ${fixed(p.daily.avgPoints)} points` } : null) },
  { id: 'dailyBest', label: 'Best daily', get: (p) => (p.daily ? { value: String(p.daily.bestScore), sub: `best finish #${p.daily.bestRank}` } : null) },
  { id: 'dailyStreak', label: 'Daily streak', get: (p) => (p.daily ? { value: String(p.daily.streak), sub: `best ${p.daily.longestStreak} days in a row` } : null) },
  { id: 'survivalBest', label: 'Best survival run', get: (p) => (p.survival ? { value: String(p.survival.best.correct), sub: `right · #${p.survival.rank} all time` } : null) },
  { id: 'badges', label: 'Badges', get: (p) => ({ value: String(p.badges?.filter((b) => b.earned).length ?? 0), sub: `of ${BADGES.length}` }) },
];
const PIN_IDS = new Set(PIN_STATS.map((s) => s.id));

/** Keep only known stat ids, once each, at most PIN_MAX. */
export function cleanPinned(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(String).filter((id) => PIN_IDS.has(id)))].slice(0, PIN_MAX);
}

// ---------- badges ----------

export interface BadgeState {
  id: string;
  earned: boolean;
  /** Progress toward a counting badge. */
  have?: number;
  need?: number;
}

/** What badges are judged from. */
export interface BadgeInput {
  games: GameRecord[];
  p: Pick<PublicProfile, 'totals' | 'subjects' | 'daily'>;
  /** Unlocked by a site admin. */
  granted?: string[];
}

interface BadgeDef {
  id: string;
  name: string;
  icon: string;
  desc: string;
  /** A count to reach (progress is shown), or a yes/no check. */
  count?: (x: BadgeInput) => number;
  need?: number;
  check?: (x: BadgeInput) => boolean;
}

const correctIn = (g: GameRecord) => g.powers + g.tens;

export const BADGES: BadgeDef[] = [
  { id: 'debut', name: 'Debut', icon: '🎬', desc: 'Finish a game', count: (x) => x.p.totals.games, need: 1 },
  { id: 'regular', name: 'Regular', icon: '📅', desc: 'Play 25 games', count: (x) => x.p.totals.games, need: 25 },
  { id: 'veteran', name: 'Veteran', icon: '🎖️', desc: 'Play 100 games', count: (x) => x.p.totals.games, need: 100 },
  { id: 'firstPower', name: 'First power', icon: '⚡', desc: 'Get a power', count: (x) => x.p.totals.powers, need: 1 },
  { id: 'powerHungry', name: 'Power hungry', icon: '🔋', desc: 'Get 50 powers', count: (x) => x.p.totals.powers, need: 50 },
  { id: 'powerPlant', name: 'Power plant', icon: '🏭', desc: 'Get 250 powers', count: (x) => x.p.totals.powers, need: 250 },
  { id: 'firstWin', name: 'First win', icon: '🥇', desc: 'Win a game against someone', count: (x) => x.p.totals.wins, need: 1 },
  { id: 'contender', name: 'Contender', icon: '🏅', desc: 'Win 10 games', count: (x) => x.p.totals.wins, need: 10 },
  { id: 'champion', name: 'Champion', icon: '🏆', desc: 'Win 50 games', count: (x) => x.p.totals.wins, need: 50 },
  { id: 'century', name: 'Century', icon: '💯', desc: 'Score 100 points in one game', check: (x) => x.p.totals.bestGame >= 100 },
  { id: 'onFire', name: 'On fire', icon: '🔥', desc: '5 tossups in a row', count: (x) => x.p.totals.bestStreak, need: 5 },
  { id: 'unstoppable', name: 'Unstoppable', icon: '☄️', desc: '10 tossups in a row', count: (x) => x.p.totals.bestStreak, need: 10 },
  { id: 'clean', name: 'Clean sheet', icon: '🧼', desc: 'Get 5+ tossups in a 10+ tossup game with no negs', check: (x) => x.games.some((g) => g.tossups >= 10 && correctIn(g) >= 5 && g.negs === 0) },
  { id: 'earlyBuzzer', name: 'Early buzzer', icon: '🐦', desc: 'Average under 40% of the question on 5+ gets in one game', check: (x) => x.games.some((g) => correctIn(g) >= 5 && g.correctDepthSum / correctIn(g) < 0.4) },
  { id: 'specialist', name: 'Specialist', icon: '🔬', desc: 'Get 25 tossups in one subject', count: (x) => Math.max(0, ...x.p.subjects.map((s) => s.powers + s.tens)), need: 25 },
  { id: 'allRounder', name: 'All-rounder', icon: '🌐', desc: 'Get a tossup in 8 different subjects', count: (x) => x.p.subjects.filter((s) => s.powers + s.tens > 0).length, need: 8 },
  { id: 'dailyDebut', name: 'Daily devotee', icon: '☀️', desc: 'Play a daily challenge', count: (x) => x.p.daily?.played ?? 0, need: 1 },
  { id: 'dailyPodium', name: 'Podium', icon: '🥉', desc: 'Finish a daily in the top 3', count: (x) => x.p.daily?.podiums ?? 0, need: 1 },
  { id: 'dailyWin', name: 'Daily champion', icon: '👑', desc: 'Finish a daily in 1st place', count: (x) => x.p.daily?.wins ?? 0, need: 1 },
  { id: 'dailyDynasty', name: 'Dynasty', icon: '🏰', desc: 'Finish 5 dailies in 1st place', count: (x) => x.p.daily?.wins ?? 0, need: 5 },
  { id: 'dailyWeek', name: 'Week streak', icon: '📆', desc: 'Play the daily 7 days in a row', count: (x) => x.p.daily?.longestStreak ?? 0, need: 7 },
  { id: 'dailyMonth', name: 'Month streak', icon: '🗓️', desc: 'Play the daily 30 days in a row', count: (x) => x.p.daily?.longestStreak ?? 0, need: 30 },
  { id: 'dailyPerfect', name: 'Perfect day', icon: '✨', desc: 'Get every tossup in a daily', count: (x) => x.p.daily?.perfect ?? 0, need: 1 },
];
export const BADGE_BY_ID = new Map(BADGES.map((b) => [b.id, b]));

export function badgesFor(x: BadgeInput): BadgeState[] {
  const granted = new Set(x.granted ?? []);
  return BADGES.map((b) => {
    if (granted.has(b.id)) return { id: b.id, earned: true, ...(b.check ? {} : { have: b.need ?? 1, need: b.need ?? 1 }) };
    if (b.check) return { id: b.id, earned: b.check(x) };
    const have = b.count!(x);
    const need = b.need ?? 1;
    return { id: b.id, earned: have >= need, have: Math.min(have, need), need };
  });
}

// ---------- badge rewards: profile colors and avatar frames ----------
// Cosmetic only. Each one but the defaults is unlocked by a badge (earned, or granted by a site admin).
// The server checks the badge when a player picks one, and shows the default once the badge is gone.

export interface Reward {
  id: string;
  name: string;
  /** The badge that unlocks it. Missing: always available (the default). */
  badge?: string;
}

/** An accent color: `light` for the light theme, `dark` for the dark theme (each reads well with that theme's accent ink). */
export interface ProfileColor extends Reward { light: string; dark: string }

export const DEFAULT_COLOR = 'orange';
export const DEFAULT_FRAME = 'none';

/** Easier badges first, the hardest last. */
export const PROFILE_COLORS: ProfileColor[] = [
  { id: 'orange', name: 'Ember', light: '#d9480f', dark: '#ea7a4b' },
  { id: 'slate', name: 'Slate', light: '#495057', dark: '#adb5bd', badge: 'dailyDebut' },
  { id: 'blue', name: 'Lake', light: '#1971c2', dark: '#4dabf7', badge: 'debut' },
  { id: 'teal', name: 'Lagoon', light: '#0c8599', dark: '#3bc9db', badge: 'firstPower' },
  { id: 'rose', name: 'Rose', light: '#c2255c', dark: '#f783ac', badge: 'onFire' },
  { id: 'pine', name: 'Pine', light: '#087f5b', dark: '#38d9a9', badge: 'dailyWeek' },
  { id: 'violet', name: 'Violet', light: '#6741d9', dark: '#9775fa', badge: 'powerHungry' },
  { id: 'gold', name: 'Gold', light: '#9a6700', dark: '#fcc419', badge: 'dailyWin' },
];

/** Rings and marks around the avatar, drawn in the player's color (`.frame-*` in accounts.css). */
export const AVATAR_FRAMES: Reward[] = [
  { id: 'none', name: 'No frame' },
  { id: 'ring', name: 'Ring', badge: 'firstWin' },
  { id: 'dashed', name: 'Dashed ring', badge: 'regular' },
  { id: 'double', name: 'Double ring', badge: 'contender' },
  { id: 'flame', name: 'Flame', badge: 'unstoppable' },
  { id: 'star', name: 'Star', badge: 'dailyPerfect' },
  { id: 'halo', name: 'Halo', badge: 'champion' },
];

const COLOR_BY_ID = new Map(PROFILE_COLORS.map((c) => [c.id, c]));
const FRAME_BY_ID = new Map(AVATAR_FRAMES.map((f) => [f.id, f]));
export const colorById = (id: string | null | undefined): ProfileColor => COLOR_BY_ID.get(id ?? '') ?? COLOR_BY_ID.get(DEFAULT_COLOR)!;
export const frameById = (id: string | null | undefined): Reward => FRAME_BY_ID.get(id ?? '') ?? FRAME_BY_ID.get(DEFAULT_FRAME)!;
export const isColor = (id: unknown): id is string => typeof id === 'string' && COLOR_BY_ID.has(id);
export const isFrame = (id: unknown): id is string => typeof id === 'string' && FRAME_BY_ID.has(id);

/** Ids of the badges a player has. */
export const earnedIds = (badges: BadgeState[]) => new Set(badges.filter((b) => b.earned).map((b) => b.id));

/** True when the reward is free or its badge is among `earned`. */
export const isUnlocked = (r: Reward, earned: Set<string>) => !r.badge || earned.has(r.badge);

/** What to show: the stored color and frame if known (and, given `earned`, still unlocked), else the defaults. */
export function lookFor(stored: { color?: string | null; frame?: string | null }, earned?: Set<string>): { color: string; frame: string } {
  const c = colorById(stored.color);
  const f = frameById(stored.frame);
  return {
    color: !earned || isUnlocked(c, earned) ? c.id : DEFAULT_COLOR,
    frame: !earned || isUnlocked(f, earned) ? f.id : DEFAULT_FRAME,
  };
}

// ---------- titles ----------
// A short title shown with a player's name. Special and custom titles are given by a site admin; every earned
// badge also unlocks its name as a title. A player equips one (or none). Keys: 'special:<id>', 'custom:<text>',
// 'badge:<badge id>'. The server checks a title is still theirs before showing it.

export const SPECIAL_TITLES = [
  { id: 'developer', name: 'Developer' },
  { id: 'early-tester', name: 'Early Tester' },
  { id: 'vip', name: 'VIP' },
  { id: 'moderator', name: 'Moderator' },
  { id: 'supporter', name: 'Supporter' },
] as const;
const SPECIAL_BY_ID = new Map<string, string>(SPECIAL_TITLES.map((t) => [t.id, t.name]));
export const TITLE_MAX = 24;
/** Most titles an admin can give one player. */
export const GRANTED_TITLES_MAX = 20;

export interface TitleOption { key: string; name: string; from: 'special' | 'custom' | 'badge' }

/** A custom title as typed by an admin: one line, no control characters, at most TITLE_MAX characters. */
export function cleanCustomTitle(s: unknown): string {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
}

/** The granted-title list an admin sent, kept to known special titles and tidy custom ones. */
export function cleanGrantedTitles(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const raw of list) {
    const k = String(raw ?? '');
    let key: string | null = null;
    if (k.startsWith('special:') && SPECIAL_BY_ID.has(k.slice(8))) key = k;
    else if (k.startsWith('custom:')) { const t = cleanCustomTitle(k.slice(7)); if (t) key = `custom:${t}`; }
    if (key && !out.includes(key)) out.push(key);
  }
  return out.slice(0, GRANTED_TITLES_MAX);
}

/** Every title a player can equip: the ones an admin gave them, then one per earned badge. */
export function titleOptions(granted: string[] | undefined, earned: Set<string>): TitleOption[] {
  const out: TitleOption[] = [];
  for (const k of cleanGrantedTitles(granted ?? [])) {
    if (k.startsWith('special:')) out.push({ key: k, name: SPECIAL_BY_ID.get(k.slice(8))!, from: 'special' });
    else out.push({ key: k, name: k.slice(7), from: 'custom' });
  }
  for (const b of BADGES) if (earned.has(b.id)) out.push({ key: `badge:${b.id}`, name: b.name, from: 'badge' });
  return out;
}

/** The equipped title's text, or null when nothing is equipped or it's no longer theirs. */
export function titleName(key: string | null | undefined, granted: string[] | undefined, earned: Set<string>): string | null {
  if (!key) return null;
  return titleOptions(granted, earned).find((o) => o.key === key)?.name ?? null;
}
