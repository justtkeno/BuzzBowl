// Types shared by the server and the client. Everything here is plain JSON.

export type Mode = 'ffa' | 'teams';
export type SourceKind = 'qbreader' | 'sample' | 'upload';

export interface Filters {
  categories: string[];
  subcategories: string[];
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
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'ffa',
  wpm: 250,
  answerSeconds: 7,
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
  filters: { categories: [], subcategories: [], difficulties: [] },
  showTextToPlayers: false,
  readerRules: true,
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
}

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
  buzzes: BuzzMarker[];
  /** Whether this viewer is allowed to see the words as they are read. */
  textVisible: boolean;
  paused: boolean;
  /** Server epoch ms when the post-question buzz window closes. */
  deadline?: number;
  lockedTeamIds: string[];
  /** Team that will play a bonus when the reader moves on (set once the tossup ends). */
  bonusTeamId: string | null;
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
}

export interface PublicState {
  code: string;
  you: string | null;
  hostId: string | null;
  readerId: string | null;
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
  tossupsRead: number;
  uploadedCount: { tossups: number; bonuses: number } | null;
  message: string | null;
}

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
  'Pop Culture': [],
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
