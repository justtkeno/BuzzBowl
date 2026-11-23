// Types shared by the server and the client. Everything here is plain JSON.

export type Mode = 'ffa' | 'teams';
export type SourceKind = 'qbreader' | 'sample' | 'upload' | 'lightning';

/** Lightning round: with no reader, the whole prompt appears at once and players get at least this long to buzz. */
export const LIGHTNING_BUZZ_SECONDS = 8;

/** How long players can still buzz once a question is fully shown. */
export const buzzWindowSeconds = (s: { source: SourceKind; deadSeconds: number }) =>
  s.source === 'lightning' ? Math.max(LIGHTNING_BUZZ_SECONDS, s.deadSeconds) : s.deadSeconds;

export interface Filters {
  categories: string[];
  subcategories: string[];
  /** Standalone topics (ids from shared/topics.ts). Mixed with the categories above; missing means none. */
  topics?: string[];
  difficulties: number[];
  minYear?: number;
  maxYear?: number;
}

export interface Settings {
  mode: Mode;
  wpm: number;
  answerSeconds: number;
  bonusSeconds: number;
  /** Seconds players may still buzz after the last word is read. */
  deadSeconds: number;
  powers: boolean;
  negs: boolean;
  bonuses: boolean;
  powerValue: number;
  tenValue: number;
  negValue: number;
  bonusPartValue: number;
  source: SourceKind;
  filters: Filters;
  /** Only matters when someone holds the reader seat. */
  showTextToPlayers: boolean;
  /** When a reader is present, the reader rules on answers (auto-check is a suggestion). */
  readerRules: boolean;
  /** No reader: between tossups, players vote on the next tossup's category. */
  topicVote: boolean;
  /** Tossups in a game; the game ends after the last one (and its bonus). 0 = no limit. */
  gameLength: number;
  /** Now and then a tossup is a bounty: worth double for a correct answer (negs stay the same). Marked before it's read. */
  bounty: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'ffa',
  wpm: 200,
  answerSeconds: 10,
  bonusSeconds: 20,
  deadSeconds: 5,
  powers: true,
  negs: true,
  bonuses: false,
  powerValue: 15,
  tenValue: 10,
  negValue: -5,
  bonusPartValue: 10,
  source: 'qbreader',
  filters: { categories: [], subcategories: [], topics: [], difficulties: [] },
  showTextToPlayers: false,
  readerRules: true,
  topicVote: false,
  gameLength: 0,
  bounty: false,
};

export type Phase =
  | 'lobby'
  | 'loading'
  | 'reading' // words are being revealed (or the post-question buzz window is open)
  | 'buzz' // someone is answering
  | 'tossupEnd'
  | 'bonus'
  | 'gameOver';

export type BuzzKind = 'power' | 'ten' | 'neg' | 'zero';
export type Verdict = 'correct' | 'prompt' | 'incorrect';

/** The answer line as the checker understands it (readable forms), for "why was I wrong". */
export interface AnswerKey {
  accept: string[];
  prompt: string[];
  reject: string[];
  /** This viewer's wrong answers on the tossup. rejected: on the do-not-accept list; prompt: would only have been prompted; wrong: matched nothing. */
  misses: { given: string; why: 'rejected' | 'prompt' | 'wrong' }[];
}

export interface BuzzMarker {
  playerId: string;
  playerName: string;
  /** Number of words that had been revealed when the player buzzed. */
  wordIndex: number;
  result: BuzzKind | 'pending' | 'prompt';
  given: string;
  /** A misspelled answer that was accepted, and what it was read as. */
  correctedTo?: string;
}

export interface CategoryStats {
  heard: number;
  points: number;
  powers: number;
  tens: number;
  negs: number;
}

export interface PlayerStats {
  points: number;
  powers: number;
  tens: number;
  negs: number;
  buzzes: number;
  heard: number;
  /** Mean fraction (0..1) of the question read at correct buzzes, or null. */
  avgCorrectDepth: number | null;
  categories: Record<string, CategoryStats>;
}

export interface PublicPlayer {
  id: string;
  name: string;
  online: boolean;
  /** Team id in team mode, own id in free-for-all, null for the reader / unassigned. */
  teamId: string | null;
  stats: PlayerStats;
  /** Tossups in a row this player has converted (resets on any tossup they heard and didn't get). */
  streak: number;
  bestStreak: number;
  /** Set for computer players the host added. */
  bot?: BotSkill;
  /** Set when the player is logged in: their account username (shown as a verified badge). */
  username?: string;
  /** Logged in as a site admin (shown as a creator badge). */
  admin?: boolean;
  /** The host, reader or an admin muted this player in chat. */
  muted?: boolean;
}

export type BotSkill = 'easy' | 'medium' | 'hard' | 'expert';
export const BOT_SKILLS: Record<BotSkill, { label: string; blurb: string }> = {
  easy: { label: 'Easy', blurb: 'Buzzes late, misses a lot' },
  medium: { label: 'Medium', blurb: 'A solid high-schooler' },
  hard: { label: 'Hard', blurb: 'Strong player, early buzzes' },
  expert: { label: 'Expert', blurb: 'Powers often, rarely wrong' },
};

export interface PublicTeam {
  id: string;
  name: string;
  playerIds: string[];
  captainId: string | null;
  points: number;
  bonusPoints: number;
  bonusesHeard: number;
  bonusPartsCorrect: number;
}

export interface PublicTossup {
  num: number;
  category: string;
  subcategory: string;
  /** The picked topic this tossup came from, when the room plays topics. */
  topic?: { name: string; icon: string };
  difficulty?: number;
  setName?: string;
  year?: number;
  /** Revealed words (empty strings when text is hidden from this viewer). */
  revealed: string[];
  totalWords: number;
  /** Full text and answer: present for the reader always, for everyone once the tossup ends. */
  words?: string[];
  powerIndex?: number | null;
  answerHtml?: string;
  /** Once the tossup ends: the answer line, read the way the checker reads it, and why this viewer's misses missed. */
  answerKey?: AnswerKey;
  buzzes: BuzzMarker[];
  /** Whether this viewer is allowed to see the words as they are read. */
  textVisible: boolean;
  paused: boolean;
  /** Server epoch ms when the post-question buzz window closes. */
  deadline?: number;
  lockedTeamIds: string[];
  /** Team that will play a bonus when the reader moves on (set once the tossup ends). */
  bonusTeamId: string | null;
  /** A bounty tossup: a correct answer scores double. Known from the start, so players see it before reading. */
  bounty?: boolean;
}

export interface PublicBuzz {
  playerId: string;
  playerName: string;
  wordIndex: number;
  deadline: number | null;
  typing: string;
  prompts: number;
  /** Set when the reader must rule: the submitted answer and the auto-checker's suggestion. */
  awaitingRuling?: { given: string; suggestion: Verdict };
}

export interface PublicBonusPart {
  text: string;
  answerHtml?: string;
  given?: string;
  correct?: boolean;
  correctedTo?: string;
}

export interface PublicBonus {
  num: number;
  teamId: string;
  teamName: string;
  leadin: string;
  parts: PublicBonusPart[];
  current: number;
  deadline: number | null;
  typing: string;
  prompts: number;
  revealing: boolean;
  done: boolean;
  category: string;
  awaitingRuling?: { given: string; suggestion: Verdict };
  /** Reader only: all part texts and answers ahead of time. */
  readerParts?: { text: string; answerHtml: string }[];
}

export interface Ruling {
  id: string;
  type: 'tossup' | 'bonus';
  num: number;
  playerId: string;
  playerName: string;
  teamId: string;
  category: string;
  given: string;
  correct: boolean;
  overridden: boolean;
  points: number;
  kind?: BuzzKind;
  wordIndex?: number;
  totalWords?: number;
  powerIndex?: number | null;
  partIndex?: number;
  /** Set when auto-check accepted a misspelling: what the answer was read as. */
  correctedTo?: string;
  /** Bonus rulings: the tossup this bonus followed (for the score graph). */
  tossup?: number;
  /** A correct answer cancelled because an earlier buzz on the same tossup was ruled correct afterwards (protest or override). Holds that ruling's id; the points come back if it's reversed again. */
  voidedBy?: string;
  /** Scored on a bounty tossup: correct answers count double. */
  bounty?: boolean;
}

export interface Protest {
  id: string;
  rulingId: string;
  byId: string;
  byName: string;
  note: string;
  resolved: boolean;
}

export interface ReviewItem {
  num: number;
  category: string;
  subcategory: string;
  setName?: string;
  words: string[];
  powerIndex: number | null;
  answerHtml: string;
  buzzes: BuzzMarker[];
  /** The question's own id and source, so a player's report can name it. */
  ref?: { id: string; source: string };
  bounty?: boolean;
}

export interface PublicState {
  code: string;
  you: string | null;
  hostId: string | null;
  readerId: string | null;
  /** A reader whose connection dropped: their seat is kept until `until` (server ms). */
  heldReader: { id: string; name: string; until: number } | null;
  settings: Settings;
  phase: Phase;
  tossup: PublicTossup | null;
  buzz: PublicBuzz | null;
  bonus: PublicBonus | null;
  players: PublicPlayer[];
  teams: PublicTeam[];
  rulings: Ruling[];
  protests: Protest[];
  review: ReviewItem[];
  /** Review items (tossup numbers) this viewer already reported. */
  reported?: number[];
  tossupsRead: number;
  uploadedCount: { tossups: number; bonuses: number } | null;
  message: string | null;
  /** The host or reader paused the whole game (all timers frozen). */
  paused: boolean;
  /** Running totals after each tossup, keyed by team id (teams) or player id (free-for-all). Sent at game over. */
  history: ScorePoint[];
  /** End-of-game awards. Sent at game over. */
  highlights: Highlight[];
  /** Present in a daily-challenge room. */
  daily?: { day: string; number: number; total: number; done: boolean };
  /** Present in a survival room: lives left and the run so far (one mark per tossup, like the daily). */
  survival?: { lives: number; maxLives: number; tossups: number; correct: number; marks: string; done: boolean };
  /** Open between tossups when players vote on the next topic. */
  vote: PublicVote | null;
  /** The voted topic, which runs for several tossups: this is tossup `num` of `total`. */
  voteRun?: { name: string; num: number; total: number };
  /** Reader only: the next tossups in line, so they can skip any before they are read. */
  upcoming?: UpcomingTossup[];
  upcomingLoading?: boolean;
  /** Admin only: their own troll settings. Never sent to anyone else. */
  admin?: { peek: boolean; frozen: { id: string; always: boolean }[]; slowed: string[] };
  /** Admin only, while peeking: the answers of the question being read. */
  peek?: { tossup?: string; bonus?: string[] };
}

/** How long players have to vote on the next topic. */
export const VOTE_SECONDS = 10;

/** Players' vote on the next tossup's category. */
export interface PublicVote {
  options: string[];
  /** Votes per option. */
  counts: Record<string, number>;
  /** This viewer's pick, if they voted. */
  mine: string | null;
  /** Server epoch ms when the vote closes. */
  deadline: number;
  /** How many tossups the winning topic plays for. */
  runLength: number;
  /** Players who can vote, and how many have. */
  voters: number;
  voted: number;
}

/** One line of the daily-challenge leaderboard. */
export interface DailyEntry {
  rank: number;
  name: string;
  /** Account username when the player was signed in (links to their profile). */
  username?: string;
  points: number;
  powers: number;
  tens: number;
  negs: number;
  /** One mark per tossup: P power, T ten, N neg, Z wrong without a neg, - no buzz. */
  marks: string;
  depth: number | null;
}

export interface DailyStatus {
  day: string;
  /** Challenge number, counting up from #1 on launch day. */
  number: number;
  total: number;
  players: number;
  leaderboard: DailyEntry[];
  /** This player's result, once they've played today. */
  me: DailyEntry | null;
  /** Seconds until the next challenge. */
  nextIn: number;
}

/** Survival: tossups keep coming until you miss this many. */
export const SURVIVAL_LIVES = 3;

/** One player's best survival run on the leaderboard. */
export interface SurvivalEntry {
  rank: number;
  name: string;
  username?: string;
  /** Tossups answered correctly: the score. */
  correct: number;
  /** Tossups played in the run, misses included. */
  tossups: number;
  points: number;
  powers: number;
  /** When the run finished (epoch ms). */
  at: number;
}

export interface SurvivalBoard {
  entries: SurvivalEntry[];
  /** Players with a run on this board. */
  players: number;
  /** This player's best run on this board, with its rank. */
  me: SurvivalEntry | null;
}

export interface SurvivalStatus {
  allTime: SurvivalBoard;
  week: SurvivalBoard;
  /** Monday (US Eastern) the weekly board started. */
  weekStart: string;
  /** This player has a run in progress (Play resumes it). */
  running: boolean;
}

export interface UpcomingTossup {
  id: string;
  category: string;
  subcategory: string;
  difficulty?: number;
  setName?: string;
  year?: number;
  /** Full question text with the (*) power mark. */
  text: string;
  answerHtml: string;
}

export interface ScorePoint {
  num: number;
  totals: Record<string, number>;
}

export interface Highlight {
  icon: string;
  title: string;
  name: string;
  detail: string;
}

/** The viewer id the server uses for big-screen spectators. */
export const SPECTATOR = '*watch*';

export interface ChatMessage {
  id: string;
  at: number;
  playerId: string | null;
  playerName: string;
  text: string;
  scope: 'all' | 'team';
  system?: boolean;
}

export interface UploadedPacket {
  tossups: unknown[];
  bonuses: unknown[];
}

/** Category names as QBReader uses them. Edit here if QBReader renames one. */
export const CATEGORIES: Record<string, string[]> = {
  Literature: ['American Literature', 'British Literature', 'Classical Literature', 'European Literature', 'World Literature', 'Other Literature'],
  History: ['American History', 'Ancient History', 'European History', 'World History', 'Other History'],
  Science: ['Biology', 'Chemistry', 'Physics', 'Other Science'],
  'Fine Arts': ['Visual Fine Arts', 'Auditory Fine Arts', 'Other Fine Arts'],
  Religion: [],
  Mythology: [],
  Philosophy: [],
  'Social Science': [],
  'Current Events': [],
  Geography: [],
  'Other Academic': [],
  'Pop Culture': ['Movies', 'Music', 'Sports', 'Television', 'Video Games', 'Other Pop Culture'],
};

export const DIFFICULTIES: Record<number, string> = {
  1: 'Middle School',
  2: 'Easy High School',
  3: 'Regular High School',
  4: 'Hard High School',
  5: 'National High School',
  6: 'Easy College',
  7: 'Medium College',
  8: 'Regionals College',
  9: 'National College',
  10: 'Open',
};
