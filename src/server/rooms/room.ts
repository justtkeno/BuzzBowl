import {
  CATEGORIES, DEFAULT_SETTINGS, SPECTATOR, SURVIVAL_LIVES, VOTE_SECONDS, buzzWindowSeconds, pingQuality,
  type AnswerKey, type BotSkill, type BuzzKind, type BuzzMarker, type ChatMessage, type Highlight, type Phase, type PlayerStats, type Protest, type PublicState, type ReviewItem,
  type Filters, type Ruling, type ScorePoint, type Settings, type Verdict,
} from '../../shared/types';
import { checkAnswerDetailed, matchesAlt } from '../game/answerCheck';
import { parseAnswerLine, type AnswerLine } from '../game/answerLine';
import { computePlayerStats, computeTeamTotals, parseTossupText, scoreTossup, type Adjustment, type HeardEntry } from '../game/scoring';
import { normalize, stripHtml, safeAnswerHtml } from '../game/text';
import { LocalProvider, parseUpload, QBReaderProvider, TopicMix, shuffle } from '../questions/providers';
import { TOPIC_BY_ID, TOPIC_BY_NAME, cleanTopics, inTopic } from '../../shared/topics';
import { CATALOG_BONUSES, CATALOG_TOSSUPS } from '../questions/catalog';
import { LIGHTNING } from '../questions/catalog/lightning';
import { SAMPLE_BONUSES, SAMPLE_TOSSUPS } from '../questions/sample';
import type { Bonus, QuestionProvider, Tossup } from '../questions/types';
import type { GameRecord } from '../../shared/accounts';
import { SurvivalProvider } from '../survival/questions';
import type { GameSummary } from '../../shared/stats';
import { dayKey } from '../daily/daily';

/** How the room talks to the outside world (Socket.IO in production, a fake in tests). */
export interface RoomIO {
  /** Send a per-viewer payload to every connected player of the room. */
  emitEach(event: string, payload: (viewerId: string) => unknown): void;
  /** Send the same payload to specific players. */
  emitTo(playerIds: string[], event: string, payload: unknown): void;
  /** A game finished: one record per logged-in player who played in it. */
  gameOver?(records: { accountId: string; game: GameRecord }[]): void;
  /** A game finished (or was abandoned after 3+ tossups): an anonymous summary for the owner's stats. */
  gameSummary?(summary: GameSummary): void;
  /** A player was kicked: stop sending them this room's updates. */
  remove?(playerId: string): void;
}

/** A logged-in player's account, attached when they join. */
export interface JoinAccount { id: string; username: string; admin?: boolean; title?: string; level?: number; pic?: string }

export class ActionError extends Error {}
const fail = (msg: string): never => { throw new ActionError(msg); };

/** How each setting reads in the chat note when the host changes it mid-match. */
/** The bounty dice. Tests swap `next` to make bounties predictable. */
export const bountyRandom = { next: () => Math.random() };

/** A bounty tossup doubles what a correct answer earns; negs and zeros stay as they are. */
const withBounty = (r: { points: number; kind: BuzzKind }, bounty: boolean) => (bounty && r.points > 0 ? { ...r, points: r.points * 2 } : r);

const SETTING_LABELS: [keyof Settings, string, string][] = [
  ['wpm', 'reading speed', ' wpm'],
  ['answerSeconds', 'answer time', ' s'],
  ['deadSeconds', 'buzz window after the question', ' s'],
  ['bonusSeconds', 'bonus time', ' s per part'],
  ['powers', 'powers', ''],
  ['negs', 'negs', ''],
  ['bonuses', 'bonuses', ''],
  ['powerValue', 'power value', ''],
  ['tenValue', 'tossup value', ''],
  ['negValue', 'neg value', ''],
  ['bonusPartValue', 'bonus part value', ''],
  ['showTextToPlayers', 'question text for players', ''],
  ['readerRules', 'reader rulings', ''],
  ['bounty', 'bounty tossups', ''],
];

export const TIMING = {
  /** A host or reader who drops gets their seat back if they reconnect within this long. */
  seatHoldMs: 3 * 60_000,
  /** After the first buzz arrives, wait this long for earlier (laggier) buzzes before awarding it. */
  graceMs: 120,
  /**
   * A client may claim it buzzed before a word only if that word went out at most this long ago. The window is
   * sized to the player's own measured connection (`lagAllowance`): an honest claim is never older than about one
   * round trip, so a fast connection can't claim the whole window to win close buzzes and extra powers.
   */
  maxLagMs: 1200,
  /** The smallest window, and the extra on top of 1.5 round trips (jitter, a word arriving mid-press). */
  lagFloorMs: 300,
  lagMarginMs: 200,
  /** Before the first ping is measured (pings run every 10 s). */
  lagUnknownMs: 600,
  promptSeconds: 5,
  partRevealMs: 3000,
  startDelayMs: 900,
  maxPrompts: 2,
  teamSize: 4,
  /** How many upcoming tossups the reader can preview. */
  lookahead: 3,
  /** How long players have to vote on the next topic. */
  voteMs: VOTE_SECONDS * 1000,
  voteOptions: 3,
  /** A voted topic plays for this many tossups (more in long games). */
  voteRunMin: 5,
  voteRunMax: 10,
};

interface Player {
  id: string; token: string; name: string; online: boolean; teamId: string | null; bot?: BotSkill; accountId?: string; username?: string; admin?: boolean; level?: number; pic?: string; ping?: number;
  /** The title they equipped on their account (shown with their name). */
  title?: string;
  /** The host, reader or an admin stopped this player from chatting. */
  muted?: boolean;
  /** Admin troll: buzzes are silently ignored, until unfrozen (`frozen`) or for one tossup number (`frozenFor`). */
  frozen?: boolean;
  frozenFor?: number;
  /** Admin troll: this admin sees the answer while the question is read. */
  peek?: boolean;
  /** Admin troll: their buzzes count as if they came SLOW_WORDS words later, so they lose close races. */
  slowed?: boolean;
}

/** How many words late a slowed player's buzz counts. */
const SLOW_WORDS = 2;
interface Team { id: string; name: string; playerIds: string[] }

interface LiveTossup {
  num: number;
  q: Tossup;
  words: string[];
  powerIndex: number | null;
  revealed: number;
  revealTimes: number[];
  locked: Set<string>;
  markers: BuzzMarker[];
  deadline?: number;
  paused: boolean;
  ended: boolean;
  bonusTeam: string | null;
  /** Where the question came from (a question report names it). Missing in rooms saved before reports. */
  source?: string;
  /** Bounty tossup: correct answers score double. */
  bounty?: boolean;
}

interface LiveBuzz {
  playerId: string;
  teamId: string;
  wordIndex: number;
  deadline: number | null;
  typing: string;
  prompts: number;
  awaiting?: { given: string; suggestion: Verdict };
  /** Asked to check their spelling of this answer (once per answer); cleared by the next prompt. */
  spelling?: string;
  spellingUsed?: boolean;
}

interface LiveBonus {
  num: number;
  /** The tossup this bonus followed. */
  tossup: number;
  teamId: string;
  q: Bonus;
  current: number;
  results: { given: string; correct: boolean; correctedTo?: string }[];
  deadline: number | null;
  typing: string;
  prompts: number;
  revealing: boolean;
  done: boolean;
  awaiting?: { given: string; suggestion: Verdict };
  spelling?: string;
  spellingUsed?: boolean;
}

/** Everything about a room. Plain data except the Sets, so it can move to Redis later. */
export interface RoomState {
  /** Set for a daily-challenge room: one player, fixed questions, fixed settings. */
  daily: DailyInfo | null;
  /** Set for a survival room: one player, tossups until three misses, fixed settings. */
  survival: SurvivalInfo | null;
  code: string;
  hostId: string | null;
  readerId: string | null;
  settings: Settings;
  phase: Phase;
  players: Player[];
  teams: Team[];
  tossup: LiveTossup | null;
  buzz: LiveBuzz | null;
  bonus: LiveBonus | null;
  rulings: Ruling[];
  adjustments: Adjustment[];
  heard: HeardEntry[];
  protests: Protest[];
  review: ReviewItem[];
  chat: ChatMessage[];
  seenTossups: Set<string>;
  seenBonuses: Set<string>;
  upload: { tossups: Tossup[]; bonuses: Bonus[] } | null;
  tossupNum: number;
  bonusNum: number;
  message: string | null;
  lastActive: number;
  /** Number of the last bounty tossup, so bounties stay spread out. */
  lastBounty?: number | null;
  /** Whole-game pause by the host or reader: every timer is frozen. */
  paused: boolean;
  pausedAt: number | null;
  /** Seats kept for a host or reader whose connection dropped, until they come back or time runs out. */
  seatHold?: { host?: { id: string; until: number }; reader?: { id: string; until: number } };
  /** This game's results were already saved to players' profiles. */
  recorded?: boolean;
  /**
   * Something in this game changed a score by hand or let players see answers early: a score adjustment,
   * a reversed ruling, a reader accepting an answer the checker rejected, or an uploaded packet.
   * Its results still go on profiles, but not on the leaderboards.
   */
  unranked?: boolean;
  /** Open topic vote between tossups (topicVote setting, no reader). */
  vote?: { options: string[]; votes: Record<string, string>; deadline: number } | null;
  /** The category players voted for; used by the next tossup only. */
  nextCategory?: string | null;
  /** The winning topic of the last vote, played for `total` tossups before the next vote. */
  voteRun?: { option: string; total: number; played: number } | null;
  /** Seat tokens and account ids that were banned from this room. */
  banned?: { tokens: string[]; accounts: string[] };
  /** Review items (tossup numbers) each player reported, so their Report buttons say "Reported". */
  reported?: Record<string, number[]>;
}

const rid =(n = 10) => Array.from({ length: n }, () => 'abcdefghijkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 32)]).join('');
const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/** Built-in questions: the original sample packet plus the Trivio catalog. Works offline. */
const sampleProvider = new LocalProvider([...SAMPLE_TOSSUPS, ...CATALOG_TOSSUPS], [...SAMPLE_BONUSES, ...CATALOG_BONUSES]);
/** Lightning round: short one-line prompts, no bonuses. */
const lightningProvider = new LocalProvider(LIGHTNING, []);

/** Parsed answer lines, kept per question so snapshots don't re-parse them. */
const parsedLines = new WeakMap<Tossup, AnswerLine>();
function answerKey(q: Tossup, misses: string[]): AnswerKey {
  let line = parsedLines.get(q);
  if (!line) { line = parseAnswerLine(q.answer); parsedLines.set(q, line); }
  const shown = (alts: AnswerLine['accept']) => [...new Set(alts.map((a) => a.display ?? a.full))];
  return {
    accept: shown(line.accept), prompt: shown(line.prompt), reject: shown(line.reject),
    misses: misses.map((given) => {
      const g = normalize(given);
      const why = line!.reject.some((a) => matchesAlt(g, a, true)) ? 'rejected' : line!.prompt.some((a) => matchesAlt(g, a)) ? 'prompt' : 'wrong';
      return { given, why };
    }),
  };
}

export interface RoomDeps {
  qbreader?: QuestionProvider;
}

export interface DailyInfo { day: string; number: number; total: number; playerKey: string; done: boolean }
/** One player's daily-challenge result, worked out by the server from their actual buzzes. */
export interface DailyOutcome {
  day: string; playerKey: string; playerId: string; name: string; accountId?: string;
  points: number; powers: number; tens: number; negs: number;
  /** One mark per tossup: P power, T ten, N neg, Z wrong without a neg, - no buzz. */
  marks: string;
  /** Average fraction of the question heard before correct buzzes (lower is earlier). */
  depth: number | null;
}

export interface SurvivalInfo {
  playerKey: string;
  lives: number;
  /** One mark per tossup played, like the daily: P power, T ten, N neg, Z wrong without a neg, - no buzz. */
  marks: string;
  startedAt: number;
  done: boolean;
}
/** One finished survival run, worked out by the server from the player's actual buzzes. */
export interface SurvivalOutcome {
  code: string; playerKey: string; playerId: string; name: string; accountId?: string;
  /** Tossups played, misses included. */
  tossups: number;
  correct: number; points: number; powers: number; tens: number; negs: number; marks: string;
}

/** Plays a fixed list of tossups in order (the daily set). */
class InOrderProvider implements QuestionProvider {
  constructor(private tossups: Tossup[]) {}
  async nextTossup(_f: unknown, seen: Set<string>) { return this.tossups.find((t) => !seen.has(t.id)) ?? null; }
  async nextBonus() { return null; }
}

export class Room {
  s: RoomState;
  /** Named timers. While the game is paused they stay here with no handle and resume on unpause. */
  private timers = new Map<string, { h: ReturnType<typeof setTimeout> | null; fn: () => void; due: number }>();
  private pending: { playerId: string; teamId: string; count: number; at: number }[] = [];
  private loadGen = 0;
  private qbreader: QuestionProvider;
  private uploadProvider: QuestionProvider | null = null;
  /** The next few tossups, fetched ahead so the reader can look through them and skip any. */
  private upcoming: Tossup[] = [];
  private fillingQueue = false;
  private queueGen = 0;
  /** After a restart, the old host keeps their seat this long before someone else can take it. */
  private hostReservedUntil = 0;

  constructor(code: string, private io: RoomIO, deps: RoomDeps = {}) {
    this.qbreader = deps.qbreader ?? new QBReaderProvider();
    this.s = {
      code, hostId: null, readerId: null, settings: structuredClone(DEFAULT_SETTINGS), phase: 'lobby',
      players: [], teams: [], tossup: null, buzz: null, bonus: null, rulings: [], adjustments: [], heard: [],
      protests: [], review: [], chat: [], seenTossups: new Set(), seenBonuses: new Set(), upload: null,
      tossupNum: 0, bonusNum: 0, message: null, lastActive: Date.now(), paused: false, pausedAt: null, daily: null, survival: null,
    };
  }

  // ---------- helpers ----------

  private player(id: string) { return this.s.players.find((p) => p.id === id); }
  private mustPlayer(id: string) { return this.player(id) ?? fail('You are not in this room.'); }
  private isController(id: string) {
    // A host who never came back after a restart hands over to whoever is here.
    if (id !== this.s.hostId && this.s.hostId && !this.player(this.s.hostId)?.online && Date.now() > this.hostReservedUntil && this.player(id)?.online) {
      this.s.hostId = id;
    }
    return id === this.s.hostId || id === this.s.readerId;
  }
  private readerOnline() { return !!this.s.readerId && !!this.player(this.s.readerId)?.online; }
  /** Lightning round with no reader: each prompt is shown all at once instead of word by word. */
  private instantReveal() { return this.s.settings.source === 'lightning' && !this.readerOnline(); }

  /** Who may advance / start / pause: the reader (and host) when there is a reader, otherwise anyone. */
  private canDirect(id: string) { return this.readerOnline() ? this.isController(id) : true; }

  teamOf(playerId: string): string | null {
    if (playerId === this.s.readerId) return null;
    if (this.s.settings.mode === 'ffa') return this.player(playerId) ? playerId : null;
    return this.player(playerId)?.teamId ?? null;
  }

  private teamName(teamId: string) {
    return this.s.settings.mode === 'ffa' ? this.player(teamId)?.name ?? '?' : this.s.teams.find((t) => t.id === teamId)?.name ?? '?';
  }

  private captainOf(teamId: string): string | null {
    if (this.s.settings.mode === 'ffa') return teamId;
    const team = this.s.teams.find((t) => t.id === teamId);
    if (!team) return null;
    return team.playerIds.find((id) => this.player(id)?.online) ?? team.playerIds[0] ?? null;
  }

  private teamMembers(teamId: string): string[] {
    if (this.s.settings.mode === 'ffa') return [teamId];
    return this.s.teams.find((t) => t.id === teamId)?.playerIds ?? [];
  }

  private activeTeams(): Set<string> {
    const out = new Set<string>();
    for (const p of this.s.players) {
      if (!p.online) continue;
      const t = this.teamOf(p.id);
      if (t) out.add(t);
    }
    return out;
  }

  private textVisibleTo(viewer: string) {
    return !this.readerOnline() || viewer === this.s.readerId || this.s.settings.showTextToPlayers;
  }

  /** The first of the room's picked topics this question belongs to, for the chip on the card. */
  private topicOf(q: Tossup): { topic?: { name: string; icon: string } } {
    const t = cleanTopics(this.s.settings.filters.topics).map((id) => TOPIC_BY_ID.get(id)!).find((x) => inTopic(q, x));
    return t ? { topic: { name: t.name, icon: t.icon } } : {};
  }

  /** Where questions come from, with the room's picked topics mixed in (see TopicMix). */
  private provider(): QuestionProvider {
    const src = this.s.settings.source;
    if (src === 'sample') return new TopicMix(sampleProvider, sampleProvider, false);
    if (src === 'lightning') return new TopicMix(lightningProvider, lightningProvider, false);
    if (src === 'upload') { const up = this.uploadProvider ?? sampleProvider; return new TopicMix(up, up, false); }
    // Topics QBReader doesn't have use the built-in questions.
    return new TopicMix(this.qbreader, sampleProvider, true);
  }

  private setTimer(name: string, ms: number, fn: () => void) {
    this.clearTimer(name);
    const entry = { h: null as ReturnType<typeof setTimeout> | null, fn, due: Date.now() + Math.max(0, ms) };
    this.timers.set(name, entry);
    if (!this.s.paused) this.arm(name, entry);
  }
  private arm(name: string, entry: { h: ReturnType<typeof setTimeout> | null; fn: () => void; due: number }) {
    entry.h = setTimeout(() => { this.timers.delete(name); entry.fn(); }, Math.max(0, entry.due - Date.now()));
  }
  private clearTimer(...names: string[]) {
    for (const n of names) { const t = this.timers.get(n); if (t?.h) clearTimeout(t.h); this.timers.delete(n); }
  }
  private notPaused() { if (this.s.paused) fail('The game is paused.'); }

  /** Host / reader: freeze or resume the whole game, including answer and bonus clocks. */
  pauseGame(by: string, paused: boolean) {
    if (!this.isController(by)) fail('Only the host or reader can pause the game.');
    if (this.s.daily && paused) fail('The daily challenge can’t be paused.');
    if (this.s.survival && paused) fail('Survival can’t be paused.');
    if (paused === this.s.paused) return;
    if (paused) {
      if (this.s.phase === 'lobby' || this.s.phase === 'gameOver') fail('Nothing to pause.');
      this.s.paused = true;
      this.s.pausedAt = Date.now();
      for (const t of this.timers.values()) if (t.h) { clearTimeout(t.h); t.h = null; }
      this.system(`${this.player(by)?.name ?? 'The host'} paused the game.`);
    } else {
      const shift = Date.now() - (this.s.pausedAt ?? Date.now());
      this.s.paused = false;
      this.s.pausedAt = null;
      for (const [name, t] of this.timers) { t.due += shift; this.arm(name, t); }
      const { tossup: t, buzz: b, bonus: bn } = this.s;
      if (t) { if (t.deadline) t.deadline += shift; t.revealTimes = t.revealTimes.map((x) => x + shift); }
      if (b?.deadline) b.deadline += shift;
      if (bn?.deadline) bn.deadline += shift;
      if (this.s.vote) this.s.vote.deadline += shift;
      this.system('Game resumed.');
    }
    this.broadcast();
  }
  dispose() { for (const n of [...this.timers.keys()]) this.clearTimer(n); }

  private wordMs(word: string) {
    const base = 60_000 / this.s.settings.wpm;
    return base * Math.min(1.8, Math.max(0.6, word.replace(/[^\p{L}\p{N}]/gu, '').length / 5));
  }

  private system(text: string) { this.postChat({ id: rid(), at: Date.now(), playerId: null, playerName: '', text, scope: 'all', system: true }); }
  private postChat(msg: ChatMessage, to?: string[]) {
    if (!to) {
      this.s.chat.push(msg);
      if (this.s.chat.length > 80) this.s.chat.shift();
      this.io.emitTo(this.s.players.filter((p) => p.online).map((p) => p.id), 'chat', msg);
    } else this.io.emitTo(to, 'chat', msg);
  }

  broadcast() {
    this.s.lastActive = Date.now();
    const shared = this.sharedSnapshot();
    this.io.emitEach('state', (viewer) => this.snapshot(viewer, shared));
  }

  // ---------- membership ----------

  join(name: string, token?: string, account?: JoinAccount): { playerId: string; token: string } {
    const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
    const ban = this.s.banned;
    if (ban && ((token && ban.tokens.includes(token)) || (account && ban.accounts.includes(account.id)))) fail('You were banned from this room.');
    let existing = token ? this.s.players.find((p) => p.token === token) : undefined;
    // A seat that belongs to a different account isn't yours, even with its token.
    if (existing?.accountId && account && existing.accountId !== account.id) existing = undefined;
    // Logged-in players get their seat back from any device.
    if (!existing && account) existing = this.s.players.find((p) => p.accountId === account.id);
    if (existing) {
      existing.online = true;
      if (clean) existing.name = clean;
      if (account && !existing.accountId) { existing.accountId = account.id; existing.username = account.username; }
      if (account && existing.accountId === account.id) { existing.level = account.level; existing.pic = account.pic; }
      // Admin powers need the admin to be logged in right now, not just a saved seat token.
      existing.admin = (account && existing.accountId === account.id && account.admin) || undefined;
      // The title follows the account (a newly equipped one shows on the next reconnect).
      if (account && existing.accountId === account.id) existing.title = account.title || undefined;
      const hostAway = !this.s.hostId || !this.player(this.s.hostId)?.online;
      if (hostAway && (existing.id === this.s.hostId || Date.now() > this.hostReservedUntil)) this.s.hostId = existing.id;
      this.restoreSeats(existing);
      this.broadcast();
      return { playerId: existing.id, token: existing.token };
    }
    if (!clean) fail('Pick a display name.');
    if (this.s.daily && this.s.players.length) fail('The daily challenge is played solo. Start your own from the home page.');
    if (this.s.survival && this.s.players.length) fail('Survival is played solo. Start your own run from the home page.');
    if (this.s.players.length >= 60) fail('This room is full.');
    const p: Player = {
      id: rid(), token: rid(24), name: clean, online: true, teamId: null,
      ...(account ? { accountId: account.id, username: account.username, ...(account.admin ? { admin: true } : {}), ...(account.title ? { title: account.title } : {}), ...(account.level ? { level: account.level } : {}), ...(account.pic ? { pic: account.pic } : {}) } : {}),
    };
    this.s.players.push(p);
    if (this.s.settings.mode === 'teams') this.autoAssign(p);
    if (!this.s.hostId || (!this.player(this.s.hostId)?.online && Date.now() > this.hostReservedUntil)) this.s.hostId = p.id;
    this.system(`${p.name} joined.`);
    this.broadcast();
    return { playerId: p.id, token: p.token };
  }

  /** A signed-in player's level changed (after a game was saved): show the new one. */
  /**
   * The server measured this player's round trip. Smoothed, and only broadcast when it moves between good, ok and bad,
   * so measuring doesn't flood the room with updates. Rulings never look at it; it only sizes how far back a buzz may claim (`lagAllowance`).
   */
  setPing(playerId: string, ms: number) {
    const p = this.player(playerId);
    if (!p || p.bot || !Number.isFinite(ms) || ms < 0) return;
    const before = p.ping;
    p.ping = before == null ? ms : before * 0.6 + ms * 0.4;
    if (before == null || pingQuality(before) !== pingQuality(p.ping)) this.broadcast();
  }

  setLevel(accountId: string, level: number) {
    const p = this.s.players.find((x) => x.accountId === accountId);
    if (!p || p.level === level) return;
    p.level = level;
    this.broadcast();
  }

  /** Give a reconnecting host or reader back the seat that was held for them. */
  private restoreSeats(p: Player) {
    const hold = this.s.seatHold;
    if (!hold) return;
    const now = Date.now();
    if (hold.host?.id === p.id) {
      if (now < hold.host.until) this.s.hostId = p.id;
      delete hold.host;
    }
    if (hold.reader?.id === p.id) {
      // Only if nobody else took the seat meanwhile, and not while this player is answering a tossup.
      if (now < hold.reader.until && !this.readerOnline() && this.s.buzz?.playerId !== p.id) {
        this.seatReader(p);
        this.system(`${p.name} is back in the reader's seat.`);
      }
      delete hold.reader;
    }
    if (!hold.host && !hold.reader) delete this.s.seatHold;
  }

  /** Put a player in the reader seat (off any team), sending the previous reader back to playing. */
  private seatReader(p: Player) {
    const old = this.s.readerId ? this.player(this.s.readerId) : undefined;
    if (old && old !== p && this.s.settings.mode === 'teams') this.autoAssign(old);
    this.removeFromTeam(p);
    this.s.readerId = p.id;
    if (this.s.seatHold?.reader) delete this.s.seatHold.reader;
    void this.fillQueue();
  }

  private mustAdmin(by: string) {
    const p = this.mustPlayer(by);
    if (!p.admin) fail('Only site admins can do that.');
    return p;
  }

  /** Admin: make any person in the room the host, at any time. */
  adminSetHost(by: string, target: string) {
    const admin = this.mustAdmin(by);
    const p = this.mustPlayer(target);
    if (p.bot) fail('Bots can\'t be the host.');
    if (this.s.hostId === p.id) return;
    this.s.hostId = p.id;
    if (this.s.seatHold?.host) delete this.s.seatHold.host;
    this.system(`${admin.name} (Trivio creator) made ${p.name} the host.`);
    this.broadcast();
  }

  /** Admin: seat anyone as reader, or free the seat (null), even mid-match. */
  adminSetReader(by: string, target: string | null) {
    const admin = this.mustAdmin(by);
    if (this.s.daily) fail('The daily challenge has no reader.');
    if (this.s.survival) fail('Survival has no reader.');
    if (target === null) {
      const old = this.s.readerId ? this.player(this.s.readerId) : undefined;
      if (!old) return;
      this.s.readerId = null;
      if (this.s.settings.mode === 'teams') this.autoAssign(old);
      this.system(`${admin.name} (Trivio creator) took ${old.name} out of the reader's seat.`);
      return this.broadcast();
    }
    const p = this.mustPlayer(target);
    if (p.bot) fail('Bots can\'t read.');
    if (this.s.readerId === p.id) return;
    if (this.s.buzz?.playerId === p.id) fail(`${p.name} is answering right now. Try again in a moment.`);
    if (this.s.phase === 'bonus' && this.s.bonus && !this.s.bonus.done && this.teamOf(p.id) === this.s.bonus.teamId) {
      fail(`${p.name}'s team is playing a bonus. Try again after it.`);
    }
    this.seatReader(p);
    this.system(`${admin.name} (Trivio creator) made ${p.name} the reader.`);
    this.broadcast();
  }

  /** A site admin takes the host seat in any room. */
  claimHost(by: string) {
    const p = this.mustPlayer(by);
    if (!p.admin) fail('Only site admins can take the host seat.');
    if (this.s.hostId === by) return;
    this.s.hostId = by;
    this.system(`${p.name} (Trivio creator) is now the host.`);
    this.broadcast();
  }

  // ---------- moderation: the host, the reader, or a site admin ----------

  private mustModerate(by: string, target: string) {
    const me = this.mustPlayer(by);
    if (!this.isController(by) && !me.admin) fail('Only the host or reader can do that.');
    if (this.s.daily) fail('Not available in the daily challenge.');
    if (this.s.survival) fail('Not available in survival.');
    const p = this.mustPlayer(target);
    if (p.id === by) fail('You can’t do that to yourself.');
    if (p.admin && !me.admin) fail('You can’t do that to the Trivio creator.');
    return { me, p };
  }

  /** Remove a player from the room. With `ban`, their seat and account can't come back. */
  kick(by: string, target: string, ban = false) {
    const { me, p } = this.mustModerate(by, target);
    if (p.bot) fail('Remove bots from the lobby instead.');
    if (this.s.buzz?.playerId === p.id) fail(`${p.name} is answering right now. Try again in a moment.`);
    if (ban) {
      const b = (this.s.banned ??= { tokens: [], accounts: [] });
      b.tokens.push(p.token);
      if (p.accountId) b.accounts.push(p.accountId);
    }
    this.io.emitTo([p.id], 'kicked', { banned: ban });
    this.io.remove?.(p.id);
    this.removePlayer(p);
    this.system(`${me.name} ${ban ? 'banned' : 'removed'} ${p.name}${ban ? ' from the room' : ''}.`);
    this.broadcast();
  }

  private removePlayer(p: Player) {
    const hadPending = this.pending.length > 0;
    this.pending = this.pending.filter((x) => x.playerId !== p.id);
    this.removeFromTeam(p);
    this.s.players = this.s.players.filter((x) => x !== p);
    if (this.s.seatHold?.host?.id === p.id) delete this.s.seatHold.host;
    if (this.s.seatHold?.reader?.id === p.id) delete this.s.seatHold.reader;
    if (this.s.hostId === p.id) this.s.hostId = this.s.players.find((x) => x.online && !x.bot)?.id ?? null;
    if (this.s.readerId === p.id) {
      this.s.readerId = null;
      if (this.s.buzz?.awaiting) this.applyTossupVerdict(this.s.buzz.awaiting.suggestion, this.s.buzz.awaiting.given);
      else if (this.s.bonus?.awaiting) this.applyBonusVerdict(this.s.bonus.awaiting.suggestion, this.s.bonus.awaiting.given);
    }
    // Their buzz was the only one waiting to be awarded: carry on reading.
    const t = this.s.tossup;
    if (hadPending && !this.pending.length && t && this.s.phase === 'reading' && !t.paused) {
      this.clearTimer('grace');
      if (t.revealed < t.words.length) this.setTimer('read', 300, () => this.readNext());
      else this.openDeadWindow();
    }
  }

  /** Stop or allow a player's chat messages. */
  mute(by: string, target: string, muted: boolean) {
    const { me, p } = this.mustModerate(by, target);
    if (!!p.muted === muted) return;
    p.muted = muted || undefined;
    this.system(`${me.name} ${muted ? 'muted' : 'unmuted'} ${p.name} in chat.`);
    this.broadcast();
  }

  /** Give a player (or their team) their buzz back on the current tossup. */
  allowRebuzz(by: string, target: string) {
    const { me, p } = this.mustModerate(by, target);
    const t = this.s.tossup;
    if (!t || t.ended || (this.s.phase !== 'reading' && this.s.phase !== 'buzz')) fail('No tossup is being read.');
    const teamId = this.teamOf(p.id) ?? fail(`${p.name} isn’t playing.`);
    if (!t!.locked.has(teamId!)) fail(`${p.name} hasn’t used their buzz yet.`);
    t!.locked.delete(teamId!);
    this.system(`${me.name} let ${this.s.settings.mode === 'teams' ? this.teamName(teamId!) : p.name} buzz again.`);
    this.broadcast();
  }

  // ---------- admin-only extras ----------

  /** Admin: see the answer while the question is read. Nobody else is told. */
  setPeek(by: string, on: boolean) {
    const me = this.mustAdmin(by);
    me.peek = on || undefined;
    if (on && this.s.phase !== 'lobby') this.s.unranked = true; // seeing answers early: off the leaderboards, quietly
    this.broadcast();
  }

  /** Admin: silently ignore someone's buzzes, for one tossup or until unfrozen. Nobody is told. */
  freeze(by: string, target: string, mode: 'tossup' | 'always' | 'off') {
    this.mustAdmin(by);
    const p = this.mustPlayer(target);
    if (p.id === by) fail('You can’t freeze yourself.');
    delete p.frozen;
    delete p.frozenFor;
    const t = this.s.tossup;
    const live = !!t && !t.ended && (this.s.phase === 'reading' || this.s.phase === 'buzz');
    if (mode === 'always') p.frozen = true;
    else if (mode === 'tossup') p.frozenFor = live ? this.s.tossupNum : this.s.tossupNum + 1;
    this.broadcast();
  }
  private isFrozen(p: Player) { return !!p.frozen || p.frozenFor === this.s.tossupNum; }

  /** Troll tools that act on players stay out of the daily challenge and survival, which must stay fair. */
  private noTrollHere() {
    if (this.s.daily || this.s.survival) fail('Not in the daily challenge or survival.');
  }

  /** Admin: someone's buzzes quietly count a couple of words late, so they lose close races. Nobody is told. */
  setSlowed(by: string, target: string, on: boolean) {
    this.mustAdmin(by);
    this.noTrollHere();
    const p = this.mustPlayer(target);
    if (p.id === by) fail('You can’t slow yourself.');
    p.slowed = on || undefined;
    this.broadcast();
  }

  /** Admin: a big message on one person's screen only. */
  whisper(by: string, target: string, text: string) {
    this.mustAdmin(by);
    this.noTrollHere();
    const p = this.mustPlayer(target);
    if (!p.online || p.bot) fail(`${p.name} isn’t here to see it.`);
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!clean) fail('Type a message first.');
    this.io.emitTo([p.id], 'announce', { text: clean, at: Date.now() });
  }

  /** Admin: shake one person's screen, or everyone's in the room (target null). */
  shake(by: string, target: string | null) {
    this.mustAdmin(by);
    this.noTrollHere();
    const ids = target ? [this.mustPlayer(target).id] : [...this.s.players.filter((p) => p.online && p.id !== by && !p.bot).map((p) => p.id), SPECTATOR];
    this.io.emitTo(ids, 'shake', { at: Date.now() });
  }

  /** Admin: buzz someone in right now, as if they'd pressed it. They have to answer. */
  forceBuzz(by: string, target: string) {
    this.mustAdmin(by);
    this.noTrollHere();
    const p = this.mustPlayer(target);
    if (p.bot) fail('Bots buzz on their own.');
    if (!p.online) fail(`${p.name} is offline.`);
    const t = this.s.tossup;
    if (!t || this.s.phase !== 'reading' || t.ended) fail('Wait until a question is being read.');
    const teamId = this.teamOf(p.id) ?? fail(`${p.name} isn’t playing.`);
    if (t!.locked.has(teamId!)) fail(`${p.name} already buzzed on this question.`);
    if (this.isFrozen(p)) fail(`Unfreeze ${p.name} first.`);
    this.buzz(p.id, t!.revealed);
  }

  /** Admin: change anyone's display name. It reads like they renamed themselves. */
  adminRename(by: string, target: string, name: string) {
    this.mustAdmin(by);
    this.renamePlayer(this.mustPlayer(target).id, name);
  }

  /** Admin: flash a big message on everyone's screen, with no name attached. */
  announce(by: string, text: string) {
    this.mustAdmin(by);
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!clean) fail('Type a message first.');
    this.io.emitTo([...this.s.players.filter((p) => p.online).map((p) => p.id), SPECTATOR], 'announce', { text: clean, at: Date.now() });
  }

  renamePlayer(playerId: string, name: string) {
    const p = this.mustPlayer(playerId);
    const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
    if (!clean) fail('Pick a display name.');
    if (clean === p.name) return;
    const old = p.name;
    p.name = clean;
    this.system(`${old} is now ${clean}.`);
    this.broadcast();
  }

  disconnect(playerId: string) {
    const p = this.player(playerId);
    if (!p) return;
    p.online = false;
    const until = Date.now() + TIMING.seatHoldMs;
    if (this.s.hostId === playerId) {
      this.s.hostId = this.s.players.find((x) => x.online && !x.bot)?.id ?? playerId;
      if (this.s.hostId !== playerId) (this.s.seatHold ??= {}).host = { id: playerId, until };
    }
    if (this.s.readerId === playerId) {
      // The app reads on its own meanwhile; the reader gets the seat back if they reconnect in time.
      this.s.readerId = null;
      (this.s.seatHold ??= {}).reader = { id: playerId, until };
      this.system(`${p.name} lost connection. Their reader seat is held for ${TIMING.seatHoldMs / 60_000} minutes.`);
      if (this.s.buzz?.awaiting) this.applyTossupVerdict(this.s.buzz.awaiting.suggestion, this.s.buzz.awaiting.given);
      else if (this.s.bonus?.awaiting) this.applyBonusVerdict(this.s.bonus.awaiting.suggestion, this.s.bonus.awaiting.given);
    }
    // If everyone left during a buzz, let the timers resolve things; nothing else to do here.
    this.broadcast();
  }

  /** Humans only: bots never keep an empty room alive. */
  connectedCount() { return this.s.players.filter((p) => p.online && !p.bot).length; }

  private autoAssign(p: Player) {
    if (p.id === this.s.readerId) return;
    this.ensureTeams();
    const open = [...this.s.teams].sort((a, b) => a.playerIds.length - b.playerIds.length).find((t) => t.playerIds.length < TIMING.teamSize);
    if (open) { open.playerIds.push(p.id); p.teamId = open.id; }
  }

  private ensureTeams() {
    if (this.s.teams.length < 2) {
      for (const name of ['Team A', 'Team B'].slice(this.s.teams.length)) this.s.teams.push({ id: rid(), name, playerIds: [] });
    }
  }

  private removeFromTeam(p: Player) {
    for (const t of this.s.teams) t.playerIds = t.playerIds.filter((id) => id !== p.id);
    p.teamId = null;
  }

  // ---------- settings, teams, reader ----------

  private questionsKey() { const s = this.s.settings; return JSON.stringify([s.source, s.filters]); }

  /** "QBReader: Science, History · difficulty 3, 4" for chat announcements. */
  private questionsLabel() {
    const s = this.s.settings, f = s.filters;
    const source = { qbreader: 'QBReader', sample: 'the built-in questions', upload: 'the uploaded packet', lightning: 'the lightning round' }[s.source] ?? s.source;
    const topics = cleanTopics(f.topics).map((id) => TOPIC_BY_ID.get(id)!.name);
    const cats = f.subcategories.length ? f.subcategories.join(', ') : f.categories.length ? f.categories.join(', ') : topics.length ? '' : 'all categories';
    const parts = [[cats, ...topics].filter(Boolean).join(', ')];
    if (s.source === 'lightning' && f.difficulties.length) parts.push(`difficulty ${[...f.difficulties].sort((a, b) => a - b).join(', ')}`);
    if (s.source === 'qbreader') {
      if (f.difficulties.length) parts.push(`difficulty ${[...f.difficulties].sort((a, b) => a - b).join(', ')}`);
      if (f.minYear || f.maxYear) parts.push(f.minYear && f.maxYear ? `${f.minYear}–${f.maxYear}` : f.minYear ? `${f.minYear} on` : `up to ${f.maxYear}`);
    }
    return `${source}: ${parts.join(' · ')}`;
  }

  private midGame() { return ['loading', 'reading', 'buzz', 'bonus'].includes(this.s.phase); }

  updateSettings(by: string, patch: Partial<Settings>) {
    if (!this.isController(by)) fail('Only the host or reader can change settings.');
    if (this.s.daily) fail('The daily challenge uses the same settings for everyone.');
    if (this.s.survival) fail('Survival uses the same settings for everyone.');
    const s = this.s.settings;
    const questionsKey = this.questionsKey();
    const before = { ...s };
    if (patch.mode && patch.mode !== s.mode) {
      if (this.midGame()) fail('Change the mode between questions.');
      s.mode = patch.mode === 'teams' ? 'teams' : 'ffa';
      s.bonuses = s.mode === 'teams';
      if (s.mode === 'teams') { this.ensureTeams(); for (const p of this.s.players) if (!p.teamId) this.autoAssign(p); }
    }
    if (patch.wpm !== undefined) s.wpm = clamp(patch.wpm, 80, 800, s.wpm);
    if (patch.answerSeconds !== undefined) s.answerSeconds = clamp(patch.answerSeconds, 2, 30, s.answerSeconds);
    if (patch.bonusSeconds !== undefined) s.bonusSeconds = clamp(patch.bonusSeconds, 5, 60, s.bonusSeconds);
    if (patch.deadSeconds !== undefined) s.deadSeconds = clamp(patch.deadSeconds, 1, 30, s.deadSeconds);
    if (patch.gameLength !== undefined) s.gameLength = clamp(patch.gameLength, 0, 500, s.gameLength);
    for (const k of ['powers', 'negs', 'bonuses', 'showTextToPlayers', 'readerRules', 'topicVote', 'bounty'] as const) {
      if (typeof patch[k] === 'boolean') s[k] = patch[k]!;
    }
    if (!s.topicVote && this.s.vote) this.cancelVote();
    if (!s.topicVote) this.s.voteRun = null;
    // Shortened to (or below) the tossups already played: no vote, the next step finishes the game.
    if (this.s.vote && this.lengthReached()) this.cancelVote();
    if (patch.powerValue !== undefined) s.powerValue = clamp(patch.powerValue, 0, 50, s.powerValue);
    if (patch.tenValue !== undefined) s.tenValue = clamp(patch.tenValue, 0, 50, s.tenValue);
    if (patch.negValue !== undefined) s.negValue = clamp(patch.negValue, -50, 0, s.negValue);
    if (patch.bonusPartValue !== undefined) s.bonusPartValue = clamp(patch.bonusPartValue, 0, 50, s.bonusPartValue);
    if (patch.source && ['qbreader', 'sample', 'upload', 'lightning'].includes(patch.source)) {
      if (patch.source === 'upload' && !this.uploadProvider) fail('Upload a packet first.');
      s.source = patch.source;
    }
    if (patch.filters) {
      const f = patch.filters;
      s.filters = {
        categories: Array.isArray(f.categories) ? f.categories.map(String).slice(0, 30) : s.filters.categories,
        subcategories: Array.isArray(f.subcategories) ? f.subcategories.map(String).slice(0, 60) : s.filters.subcategories,
        topics: Array.isArray(f.topics) ? cleanTopics(f.topics) : s.filters.topics ?? [],
        difficulties: Array.isArray(f.difficulties) ? f.difficulties.map(Number).filter((d) => d >= 0 && d <= 10) : s.filters.difficulties,
        minYear: f.minYear ? clamp(f.minYear, 1990, 2100, 0) || undefined : undefined,
        maxYear: f.maxYear ? clamp(f.maxYear, 1990, 2100, 0) || undefined : undefined,
      };
    }
    const questionsChanged = this.questionsKey() !== questionsKey;
    if (questionsChanged) {
      this.clearQueue();
      void this.fillQueue();
    }
    // Clocks already running pick up a new length right away.
    const { tossup: t, buzz: b, bonus: bn } = this.s;
    if (this.s.phase === 'reading' && t) this.retime('dead', (s.deadSeconds - before.deadSeconds) * 1000, t);
    if (this.s.phase === 'buzz' && b && !b.prompts) this.retime('answer', (s.answerSeconds - before.answerSeconds) * 1000, b);
    if (this.s.phase === 'bonus' && bn && !bn.prompts) this.retime('bonus', (s.bonusSeconds - before.bonusSeconds) * 1000, bn);
    if (this.s.phase !== 'lobby') {
      const changes = SETTING_LABELS.filter(([k]) => s[k] !== before[k]).map(([k, label, unit]) =>
        typeof s[k] === 'boolean' ? `${label} ${s[k] ? 'on' : 'off'}` : `${label} to ${s[k]}${unit}`);
      if (s.mode !== before.mode) changes.unshift(s.mode === 'teams' ? 'the format to teams' : 'the format to free-for-all');
      if (s.gameLength !== before.gameLength) changes.push(s.gameLength ? `the game length to ${s.gameLength} tossups` : 'the game length to no limit');
      if (questionsChanged) changes.push(`the questions to ${this.questionsLabel()}`);
      if (changes.length) {
        const tail = questionsChanged && this.midGame() ? ' They start with the next tossup.' : '';
        this.system(`${this.mustPlayer(by).name} changed ${changes.join(', ')}.${tail}`);
      }
    }
    this.broadcast();
  }

  /** Stretch or shrink a running clock (and the deadline players see) by `deltaMs`, leaving at least a second. */
  private retime(name: string, deltaMs: number, holder: { deadline?: number | null }) {
    const timer = this.timers.get(name);
    if (!timer || !deltaMs) return;
    const now = this.s.paused ? this.s.pausedAt ?? Date.now() : Date.now();
    const due = Math.max(now + 1000, timer.due + deltaMs);
    if (holder.deadline) holder.deadline += due - timer.due;
    timer.due = due;
    if (timer.h) { clearTimeout(timer.h); this.arm(name, timer); }
  }

  createTeam(by: string, name: string) {
    if (!this.isController(by)) fail('Only the host or reader can add teams.');
    if (this.s.teams.length >= 8) fail('That is enough teams.');
    this.s.teams.push({ id: rid(), name: String(name || `Team ${String.fromCharCode(65 + this.s.teams.length)}`).slice(0, 24), playerIds: [] });
    this.broadcast();
  }

  renameTeam(by: string, teamId: string, name: string) {
    const team = this.s.teams.find((t) => t.id === teamId) ?? fail('No such team.');
    if (!this.isController(by) && !team.playerIds.includes(by)) fail('Only team members, the host or the reader can rename a team.');
    const clean = String(name ?? '').trim().slice(0, 24);
    if (clean) team.name = clean;
    this.broadcast();
  }

  removeTeam(by: string, teamId: string) {
    if (!this.isController(by)) fail('Only the host or reader can remove teams.');
    if (this.midGame()) fail('Remove teams between questions.');
    const team = this.s.teams.find((t) => t.id === teamId) ?? fail('No such team.');
    if (this.s.teams.length <= 2) fail('Keep at least two teams.');
    this.s.teams = this.s.teams.filter((t) => t !== team);
    for (const id of team.playerIds) { const p = this.player(id); if (p) { p.teamId = null; this.autoAssign(p); } }
    this.broadcast();
  }

  joinTeam(by: string, teamId: string) {
    const p = this.mustPlayer(by);
    if (this.s.settings.mode !== 'teams') fail('Teams are off in free-for-all.');
    if (by === this.s.readerId) fail('Leave the reader seat first.');
    if (this.s.phase === 'buzz' || this.s.phase === 'bonus') fail('Switch teams between questions.');
    const team = this.s.teams.find((t) => t.id === teamId) ?? fail('No such team.');
    if (team.playerIds.includes(by)) return;
    if (team.playerIds.length >= TIMING.teamSize) fail(`Teams have at most ${TIMING.teamSize} players.`);
    this.removeFromTeam(p);
    team.playerIds.push(by);
    p.teamId = team.id;
    this.broadcast();
  }

  /** The host or reader puts a player on a team (or takes them off every team). */
  movePlayer(by: string, playerId: string, teamId: string | null) {
    if (!this.isController(by)) fail('Only the host or reader can move players.');
    if (this.s.settings.mode !== 'teams') fail('Teams are off in free-for-all.');
    if (this.s.phase === 'buzz' || this.s.phase === 'bonus') fail('Move players between questions.');
    const p = this.mustPlayer(playerId);
    if (p.id === this.s.readerId) fail('The reader is not on a team.');
    if (teamId === null) { this.removeFromTeam(p); this.broadcast(); return; }
    const team = this.s.teams.find((t) => t.id === teamId) ?? fail('No such team.');
    if (team.playerIds.includes(p.id)) return;
    if (team.playerIds.length >= TIMING.teamSize) fail(`Teams have at most ${TIMING.teamSize} players.`);
    this.removeFromTeam(p);
    team.playerIds.push(p.id);
    p.teamId = team.id;
    this.broadcast();
  }

  makeCaptain(by: string, target?: string) {
    const id = target ?? by;
    if (target && target !== by && !this.isController(by)) fail('Only the host or reader can pick another captain.');
    const team = this.s.teams.find((t) => t.playerIds.includes(id)) ?? fail('Not on a team.');
    team.playerIds = [id, ...team.playerIds.filter((x) => x !== id)];
    this.broadcast();
  }

  /** Take (target = self) or assign (host) the reader seat; null target frees it. */
  setReader(by: string, target: string | null) {
    if (this.s.daily) fail('The daily challenge has no reader.');
    if (this.s.survival) fail('Survival has no reader.');
    if (this.midGame()) fail('Change the reader between questions.');
    if (target === null) {
      if (by !== this.s.readerId && by !== this.s.hostId) fail('Only the reader or host can free the seat.');
      const old = this.s.readerId ? this.player(this.s.readerId) : undefined;
      this.s.readerId = null;
      if (old && this.s.settings.mode === 'teams') this.autoAssign(old);
      if (old) this.system(`${old.name} is no longer reading.`);
    } else {
      if (target !== by && by !== this.s.hostId && by !== this.s.readerId) fail('Only the host or reader can assign someone else.');
      if (this.readerOnline() && this.s.readerId !== target && by !== this.s.readerId) fail(`${this.player(this.s.readerId!)!.name} is already reading.`);
      const p = this.mustPlayer(target);
      const old = this.s.readerId ? this.player(this.s.readerId) : undefined;
      if (old && old !== p && this.s.settings.mode === 'teams') this.autoAssign(old);
      this.removeFromTeam(p);
      this.s.readerId = p.id;
      this.system(`${p.name} is now the reader.`);
      void this.fillQueue();
    }
    this.broadcast();
  }

  // ---------- game flow ----------

  start(by: string) {
    if (!this.isController(by)) fail('Only the host or reader can start.');
    if (this.s.daily?.done) fail('You’ve played today’s challenge. Come back tomorrow for a new one!');
    if (this.s.survival?.done) fail('This run is over. Tap Play again for a new one.');
    if (this.s.phase === 'gameOver') this.resetScores();
    else if (this.s.phase !== 'lobby') fail('The game is already running.');
    this.s.message = null;
    this.s.paused = false;
    this.s.pausedAt = null;
    this.s.recorded = false;
    this.s.unranked = this.s.players.some((p) => p.peek);
    this.system('Game started. Good luck!');
    void this.loadTossup();
  }

  private resetScores() {
    Object.assign(this.s, { rulings: [], adjustments: [], heard: [], protests: [], review: [], reported: {}, tossupNum: 0, bonusNum: 0, tossup: null, bonus: null, buzz: null, vote: null, nextCategory: null, voteRun: null, lastBounty: null });
  }

  // ---------- question reports ----------

  /**
   * The question behind one of this room's review items, for a player's report. Only finished tossups are in the
   * review, so nobody can report (or learn anything about) a question that is still being read.
   */
  reportTarget(by: string, num: unknown) {
    const p = this.mustPlayer(by);
    if (p.bot) fail('Bots can’t report questions.');
    const item = this.s.review.find((r) => r.num === Number(num));
    if (!item?.ref) fail('You can report a question once it has been read.');
    if (this.s.reported?.[by]?.includes(item!.num)) fail('You already reported this question.');
    const words = [...item!.words];
    if (item!.powerIndex !== null && item!.powerIndex <= words.length) words.splice(item!.powerIndex, 0, '(*)');
    return {
      questionId: item!.ref!.id, source: item!.ref!.source, category: item!.category, subcategory: item!.subcategory,
      setName: item!.setName ?? null, question: words.join(' '), answer: item!.answerHtml,
    };
  }

  /** Remember that this player reported this review item (their Report button turns into "Reported"). */
  markReported(by: string, num: number) {
    const mine = ((this.s.reported ??= {})[by] ??= []);
    if (!mine.includes(num)) mine.push(num);
    this.s.lastActive = Date.now();
    this.io.emitTo([by], 'state', this.snapshot(by));
  }

  end(by: string) {
    if (!this.isController(by)) fail('Only the host or reader can end the game.');
    this.finishGame();
  }

  /** The set number of tossups has been played (never in the daily challenge, which has its own count, or survival, which runs until 3 misses). */
  private lengthReached() {
    const n = this.s.settings.gameLength;
    return !this.s.daily && !this.s.survival && n > 0 && this.s.tossupNum >= n;
  }

  /** Stop the game and show the summary: the host ended it, or the last tossup is done. */
  private finishGame() {
    this.dispose();
    this.pending = [];
    this.loadGen++;
    if (this.s.tossup && !this.s.tossup.ended) this.s.tossup.ended = true;
    this.s.buzz = null;
    this.s.vote = null;
    this.s.nextCategory = null;
    this.s.voteRun = null;
    this.s.paused = false;
    this.s.pausedAt = null;
    this.s.phase = 'gameOver';
    this.system('Game over.');
    this.recordResults(false);
    if (this.s.daily && !this.s.daily.done) {
      this.s.daily.done = true;
      const outcome = this.dailyOutcome();
      if (outcome) this.onDailyDone?.(outcome);
    }
    // Ending a run early (giving up) counts as finishing it.
    if (this.s.survival && !this.s.survival.done) this.finishSurvival();
    this.broadcast();
  }

  // ---------- daily challenge ----------

  /** Called once when a daily-challenge room finishes. */
  onDailyDone?: (outcome: DailyOutcome) => void;

  /** Turn this fresh room into today's challenge: fixed questions, standard settings, no extras. */
  makeDaily(info: Omit<DailyInfo, 'done' | 'total'>, tossups: Tossup[]) {
    this.s.daily = { ...info, total: tossups.length, done: false };
    this.useDailyQuestions(tossups);
    this.s.settings = { ...structuredClone(DEFAULT_SETTINGS), mode: 'ffa', bonuses: false, deadSeconds: 3, source: 'upload' };
  }

  /** (Re)attach the daily questions, e.g. after a restart. */
  useDailyQuestions(tossups: Tossup[]) { this.uploadProvider = new InOrderProvider(tossups); }

  private dailyOutcome(): DailyOutcome | null {
    const d = this.s.daily;
    const p = this.s.players.find((x) => !x.bot);
    if (!d || !p) return null;
    const mine = this.s.rulings.filter((r) => r.type === 'tossup' && r.playerId === p.id && !r.overridden);
    let points = 0, powers = 0, tens = 0, negs = 0;
    const depths: number[] = [];
    let marks = '';
    for (let n = 1; n <= d.total; n++) {
      const r = mine.filter((x) => x.num === n).at(-1);
      if (!r) { marks += '-'; continue; }
      points += r.points;
      if (r.correct) {
        if (r.kind === 'power') powers++; else tens++;
        marks += r.kind === 'power' ? 'P' : 'T';
        if (r.totalWords) depths.push((r.wordIndex ?? r.totalWords) / r.totalWords);
      } else if (r.kind === 'neg') { negs++; marks += 'N'; } else marks += 'Z';
    }
    return {
      day: d.day, playerKey: d.playerKey, playerId: p.id, name: p.name, accountId: (p as any).accountId,
      points, powers, tens, negs, marks, depth: depths.length ? depths.reduce((a, b) => a + b, 0) / depths.length : null,
    };
  }

  // ---------- survival ----------

  /** Called once when a survival run ends (out of lives, given up, or abandoned). */
  onSurvivalDone?: (outcome: SurvivalOutcome) => void;

  /** Turn this fresh room into a survival run: endless tossups, standard settings, no extras. */
  makeSurvival(playerKey: string) {
    this.s.survival = { playerKey, lives: SURVIVAL_LIVES, marks: '', startedAt: Date.now(), done: false };
    this.useSurvivalQuestions();
    this.s.settings = { ...structuredClone(DEFAULT_SETTINGS), mode: 'ffa', bonuses: false, deadSeconds: 3, source: 'upload', topicVote: false };
  }

  /** (Re)attach the survival questions, e.g. after a restart. Questions already played stay in seenTossups. */
  private useSurvivalQuestions() { this.uploadProvider = new SurvivalProvider(this.qbreader, () => this.s.tossupNum + 1); }

  /** The one person playing the run. */
  private survivor() { return this.s.players.find((x) => !x.bot); }

  /** A tossup of the run just ended: note how it went, and take a life unless they got it. */
  private survivalTossupOver(num: number, got: boolean) {
    const sv = this.s.survival!;
    const p = this.survivor();
    const r = p && this.s.rulings.filter((x) => x.type === 'tossup' && x.num === num && x.playerId === p.id && !x.overridden).at(-1);
    sv.marks += !r ? '-' : r.correct ? (r.kind === 'power' ? 'P' : 'T') : r.kind === 'neg' ? 'N' : 'Z';
    if (got) return;
    sv.lives = Math.max(0, sv.lives - 1);
    if (sv.lives === 0) {
      this.system('Out of lives. That’s the run!');
      this.finishSurvival();
    }
  }

  /** End the run once: report it for the leaderboard and save the game to the player's profile right away. */
  private finishSurvival() {
    const sv = this.s.survival;
    if (!sv || sv.done) return;
    sv.done = true;
    const outcome = this.survivalOutcome();
    if (outcome) this.onSurvivalDone?.(outcome);
    this.recordResults(false);
  }

  private survivalOutcome(): SurvivalOutcome | null {
    const sv = this.s.survival;
    const p = this.survivor();
    if (!sv || !p) return null;
    const mine = this.s.rulings.filter((r) => r.type === 'tossup' && r.playerId === p.id && !r.overridden);
    const count = (m: string) => [...sv.marks].filter((x) => x === m).length;
    return {
      code: this.s.code, playerKey: sv.playerKey, playerId: p.id, name: p.name, accountId: p.accountId,
      tossups: sv.marks.length, correct: count('P') + count('T'), powers: count('P'), tens: count('T'), negs: count('N'),
      points: mine.reduce((a, r) => a + r.points, 0), marks: sv.marks,
    };
  }

  /** Save a game everyone walked away from (called before an idle room is deleted). */
  recordIfUnfinished() {
    // A survival run left open ends where it stands: the tossups already played count, nothing more.
    if (this.s.survival && !this.s.survival.done && this.s.phase !== 'lobby') this.finishSurvival();
    if (this.s.phase !== 'lobby' && this.s.phase !== 'gameOver' && this.s.heard.length >= 3) this.recordResults(true);
  }

  /** Hand each logged-in player's results to io.gameOver, once per game. */
  private recordResults(abandoned: boolean) {
    if (this.s.recorded || !this.s.heard.length) return;
    this.s.recorded = true;
    const { players, teams } = this.sharedSnapshot();
    const statsOf = new Map(players.map((p) => [p.id, p]));
    const played = (id: string) => { const st = statsOf.get(id)?.stats; return !!st && (st.heard > 0 || st.buzzes > 0); };
    const set = this.s.settings;
    this.io.gameSummary?.({
      at: Date.now(), day: dayKey(), kind: this.s.daily ? 'daily' : this.s.survival ? 'survival' : 'room',
      mode: set.mode, party: set.mode === 'ffa' && set.topicVote, source: set.source,
      players: this.s.players.filter((p) => !p.bot && p.id !== this.s.readerId && played(p.id)).length,
      bots: this.s.players.filter((p) => p.bot).length, reader: !!this.s.readerId,
      tossups: this.s.heard.length, bonuses: this.s.bonusNum, bounty: set.bounty, length: set.gameLength, abandoned,
    });
    if (!this.io.gameOver) return;
    const teamsMode = this.s.settings.mode === 'teams';
    // Competing sides: teams with someone who played, or (free-for-all) players other than the reader who played.
    const sides = teams.filter((t) => (teamsMode ? t.playerIds.some(played) : t.id !== this.s.readerId && played(t.id)));
    const ranked = [...sides].sort((a, b) => b.points - a.points);
    const human = (id: string) => { const p = this.player(id); return !!p && !p.bot; };
    const humanSide = (t: (typeof sides)[number]) => t.playerIds.some((id) => human(id) && played(id));
    // Leaderboards count ordinary games only: the daily and survival have boards of their own.
    const boardGame = !this.s.daily && !this.s.survival && !this.s.unranked && set.source !== 'upload';
    const records: { accountId: string; game: GameRecord }[] = [];
    for (const p of this.s.players) {
      if (!p.accountId || !played(p.id)) continue;
      const side = sides.find((t) => t.id === this.teamOf(p.id));
      const pub = statsOf.get(p.id)!;
      const st = pub.stats;
      const correct = st.powers + st.tens;
      records.push({
        accountId: p.accountId,
        game: {
          at: Date.now(), room: this.s.code, mode: this.s.settings.mode, sides: sides.length,
          rank: side ? 1 + sides.filter((t) => t.points > side.points).length : sides.length,
          standings: ranked.slice(0, 8).map((t) => ({ name: t.name, points: t.points, you: t.id === side?.id })),
          ...(abandoned ? { abandoned: true } : {}),
          ...(this.s.daily ? { daily: this.s.daily.number } : {}),
          ...(this.s.survival ? { survival: true } : {}),
          ...((): Partial<GameRecord> => {
            if (!boardGame) return {};
            const versus = !!side && sides.some((t) => t.id !== side.id && humanSide(t));
            const won = versus && !abandoned && side!.points > 0 && !sides.some((t) => t.points > side!.points);
            return { ranked: true, ...(versus ? { versus: true } : {}), ...(won ? { won: true } : {}) };
          })(),
          tossups: this.s.heard.length,
          points: st.points, powers: st.powers, tens: st.tens, negs: st.negs, buzzes: st.buzzes, heard: st.heard,
          correctDepthSum: st.avgCorrectDepth != null ? st.avgCorrectDepth * correct : 0,
          bestStreak: pub.bestStreak,
          bonusPoints: side?.bonusPoints ?? 0, bonusesHeard: side?.bonusesHeard ?? 0,
          categories: st.categories,
        },
      });
    }
    if (records.length) this.io.gameOver(records);
  }

  next(by: string) {
    const admin = !!this.player(by)?.admin;
    if (!this.canDirect(by) && !admin) fail('The reader decides when to move on.');
    this.notPaused();
    if (this.s.vote) return this.closeVote();
    const { phase, tossup, bonus } = this.s;
    if (phase === 'tossupEnd' && this.s.daily && this.s.tossupNum >= this.s.daily.total) return this.end(by);
    if (phase === 'tossupEnd' && this.s.survival?.done) return this.end(by);
    if ((phase === 'reading' || phase === 'buzz') && this.s.survival) fail('Every tossup counts in survival: buzz, or let it run out.');
    if (phase === 'tossupEnd') {
      if (tossup?.bonusTeam) void this.startBonus(tossup.bonusTeam);
      else void this.loadTossup();
    } else if (phase === 'bonus' && bonus?.done) {
      void this.loadTossup();
    } else if (phase === 'reading' || phase === 'buzz') {
      if (!this.isController(by) && !admin) fail('Only the host or reader can skip a question.');
      this.endTossup(null, true);
    } else if (phase === 'bonus') {
      if (!this.isController(by) && !admin) fail('Only the host or reader can skip a bonus.');
      void this.loadTossup();
    } else if (phase === 'lobby' || phase === 'gameOver') {
      this.start(by);
    }
  }

  /**
   * Whether tossup `num` is a bounty: never the first, at least 3 tossups after the last one, then a 1 in 4
   * chance each time, and always by 8 tossups after the last. Never in the daily challenge or survival.
   */
  private rollBounty(num: number) {
    if (!this.s.settings.bounty || this.s.daily || this.s.survival || num < 2) return false;
    const gap = num - (this.s.lastBounty ?? 0);
    if (gap < 4) return false;
    if (gap < 8 && bountyRandom.next() >= 0.25) return false;
    this.s.lastBounty = num;
    return true;
  }

  private async loadTossup() {
    // Every way to the next tossup (Next, a closed vote, a skipped or finished bonus) ends here after the last one.
    if (this.lengthReached()) return this.finishGame();
    if (this.s.settings.source === 'upload') this.s.unranked = true; // whoever uploaded the packet knows the answers
    this.dispose();
    this.pending = [];
    const gen = ++this.loadGen;
    const run = this.s.voteRun && this.s.settings.topicVote && this.s.voteRun.played < this.s.voteRun.total ? this.s.voteRun : null;
    const voted = run?.option ?? this.s.nextCategory ?? null;
    Object.assign(this.s, { phase: 'loading', buzz: null, bonus: null, message: null, vote: null, nextCategory: null });
    this.broadcast();
    let q: Tossup | null = voted ? null : this.upcoming.shift() ?? null;
    try {
      // The voted topic narrows the room's filters for this one tossup; if it has nothing left, fall back to the filters.
      if (voted) q = await this.provider().nextTossup(this.onlyCategory(voted), this.s.seenTossups);
      // The voted topic ran out of questions: end its run early and play from the room's filters.
      if (voted && !q && run) run.played = run.total;
      else if (run) run.played++;
      q ??= await this.provider().nextTossup(this.s.settings.filters, this.s.seenTossups);
    } catch (e: any) {
      if (gen !== this.loadGen) return;
      this.s.message = `${e?.message ?? e}. Try again, or switch the question source to Built-in questions.`;
      this.s.phase = this.s.tossupNum ? 'tossupEnd' : 'lobby';
      this.s.tossup = this.s.tossupNum ? this.s.tossup : null;
      if (this.s.tossup) this.s.tossup.bonusTeam = null;
      return this.broadcast();
    }
    if (gen !== this.loadGen) return;
    if (!q && this.s.survival) {
      this.finishSurvival();
      this.s.message = 'You’ve gone through every question we have. What a run!';
      this.s.phase = this.s.tossupNum ? 'tossupEnd' : 'lobby';
      return this.broadcast();
    }
    if (!q) {
      this.s.message = this.s.settings.source === 'upload'
        ? 'No more unread questions in the uploaded packet match these filters. Clear the filters, or switch to QBReader or Built-in questions.'
        : 'No more unread questions match these filters. Widen the filters or upload a packet.';
      this.s.phase = this.s.tossupNum ? 'tossupEnd' : 'lobby';
      if (this.s.tossup) this.s.tossup.bonusTeam = null;
      return this.broadcast();
    }
    this.s.seenTossups.add(q.id);
    const { words, powerIndex } = parseTossupText(q.question);
    this.s.tossup = {
      num: ++this.s.tossupNum, q, words, powerIndex, revealed: 0, revealTimes: [], locked: new Set(), markers: [],
      paused: false, ended: false, bonusTeam: null, source: this.s.daily ? 'daily' : this.s.settings.source,
      ...(this.rollBounty(this.s.tossupNum) ? { bounty: true } : {}), // tossupNum is this tossup's number by now
    };
    this.s.phase = 'reading';
    this.broadcast();
    this.setTimer('read', TIMING.startDelayMs, () => this.readNext());
    void this.fillQueue();
  }

  // ---------- the reader's look-ahead queue ----------

  private wantsQueue() { return this.readerOnline(); }

  /** Fetch tossups until the reader can see the next few. Queued questions count as seen, so they never repeat. */
  private async fillQueue() {
    if (this.fillingQueue || !this.wantsQueue()) return;
    this.fillingQueue = true;
    const gen = this.queueGen;
    try {
      while (this.upcoming.length < TIMING.lookahead && this.wantsQueue() && gen === this.queueGen) {
        const q = await this.provider().nextTossup(this.s.settings.filters, this.s.seenTossups);
        if (!q || gen !== this.queueGen) break;
        this.s.seenTossups.add(q.id);
        this.upcoming.push(q);
        this.broadcast();
      }
    } catch { /* the reader can still play; the next tossup is fetched when it is needed */ }
    finally {
      this.fillingQueue = false;
      if (gen !== this.queueGen) void this.fillQueue();
      else this.broadcast();
    }
  }

  /** Drop the queue (new filters or source). Unread questions go back into the pool. */
  private clearQueue() {
    this.queueGen++;
    for (const q of this.upcoming) this.s.seenTossups.delete(q.id);
    this.upcoming = [];
  }

  /** Reader: throw out an upcoming tossup before it is read; a new one takes its place. */
  skipUpcoming(by: string, id: string) {
    if (by !== this.s.readerId && by !== this.s.hostId) fail('Only the reader can skip upcoming questions.');
    const i = this.upcoming.findIndex((q) => q.id === id);
    if (i < 0) fail('That question is no longer in the queue.');
    this.upcoming.splice(i, 1); // stays "seen", so it will not come back
    this.broadcast();
    void this.fillQueue();
  }

  private readNext() {
    const t = this.s.tossup;
    if (!t || t.ended || this.s.phase !== 'reading' || t.paused) return;
    if (t.revealed >= t.words.length) return this.openDeadWindow();
    if (this.instantReveal()) {
      while (t.revealed < t.words.length) this.revealWord();
      return this.openDeadWindow();
    }
    this.revealWord();
    if (t.revealed >= t.words.length) this.openDeadWindow();
    else this.setTimer('read', this.wordMs(t.words[t.revealed - 1]), () => this.readNext());
  }

  private revealWord() {
    const t = this.s.tossup!;
    const i = t.revealed++;
    t.revealTimes[i] = Date.now();
    const word = t.words[i];
    this.io.emitEach('tick', (viewer) => ({ num: t.num, i, word: this.textVisibleTo(viewer) ? word : '' }));
  }

  private openDeadWindow() {
    const t = this.s.tossup!;
    const ms = buzzWindowSeconds(this.s.settings) * 1000;
    t.deadline = Date.now() + ms;
    this.setTimer('dead', ms, () => this.endTossup(null));
    this.broadcast();
  }

  /** Reader controls: pause / resume the teleprompter. */
  setPaused(by: string, paused: boolean) {
    if (!this.isController(by)) fail('Only the reader or host can pause.');
    if (this.s.daily && paused) fail('The daily challenge can’t be paused.');
    if (this.s.survival && paused) fail('Survival can’t be paused.');
    this.notPaused();
    const t = this.s.tossup;
    if (!t || this.s.phase !== 'reading') fail('Nothing is being read.');
    if (t!.paused === paused) return;
    t!.paused = paused;
    if (paused) { this.clearTimer('read', 'dead'); t!.deadline = undefined; this.broadcast(); }
    else if (t!.revealed >= t!.words.length) this.openDeadWindow();
    else { this.broadcast(); this.setTimer('read', 150, () => this.readNext()); }
  }

  /** Reader control: jump the cursor forward so `count` words are revealed (to resync with their voice). */
  revealTo(by: string, count: number) {
    if (!this.isController(by)) fail('Only the reader or host can move the cursor.');
    this.notPaused();
    const t = this.s.tossup;
    if (!t || this.s.phase !== 'reading' || this.pending.length) fail('Not reading right now.');
    const target = Math.min(t!.words.length, Math.floor(Number(count)) || 0);
    if (target <= t!.revealed) return;
    while (t!.revealed < target) this.revealWord();
    if (t!.revealed >= t!.words.length) { this.clearTimer('read'); if (!t!.paused) this.openDeadWindow(); else this.broadcast(); }
    else if (!t!.paused) this.setTimer('read', this.wordMs(t!.words[t!.revealed - 1]), () => this.readNext());
  }

  buzz(by: string, clientCount: number) {
    const t = this.s.tossup;
    if (!t || this.s.phase !== 'reading' || t.ended) fail('You cannot buzz right now.');
    this.notPaused();
    const teamId = this.teamOf(by) ?? fail(by === this.s.readerId ? 'The reader cannot buzz.' : 'Join a team to buzz.');
    // A frozen buzzer just does nothing: no error, no buzz.
    if (this.isFrozen(this.player(by)!)) return;
    if (t!.locked.has(teamId)) fail(this.s.settings.mode === 'teams' ? 'Your team already buzzed on this question.' : 'You already buzzed on this question.');
    if (this.pending.some((p) => p.teamId === teamId)) return;
    const now = Date.now();
    // Trust the client's word count only as far back as plausible network lag allows.
    let count = Math.max(0, Math.min(Math.floor(Number(clientCount)) || 0, t!.revealed));
    const allowed = this.lagAllowance(this.player(by)!.ping);
    while (count < t!.revealed && now - t!.revealTimes[count] > allowed) count++;
    if (this.player(by)!.slowed) count = Math.min(t!.revealed, count + SLOW_WORDS);
    this.pending.push({ playerId: by, teamId, count, at: now });
    if (this.pending.length === 1) {
      this.clearTimer('read', 'dead');
      this.setTimer('grace', TIMING.graceMs, () => this.resolveBuzz());
    }
  }

  /** How far back (ms) this player's buzz may claim to have been pressed, from their measured round trip. */
  private lagAllowance(ping: number | undefined): number {
    if (ping == null || !Number.isFinite(ping)) return TIMING.lagUnknownMs;
    return Math.min(TIMING.maxLagMs, Math.max(TIMING.lagFloorMs, ping * 1.5 + TIMING.lagMarginMs));
  }

  private resolveBuzz() {
    const t = this.s.tossup;
    const candidates = this.pending.filter((p) => this.player(p.playerId));
    this.pending = [];
    if (!t || !candidates.length) return;
    candidates.sort((a, b) => a.count - b.count || a.at - b.at);
    const win = candidates[0];
    const name = this.player(win.playerId)!.name;
    this.s.buzz = {
      playerId: win.playerId, teamId: win.teamId, wordIndex: win.count,
      deadline: Date.now() + this.s.settings.answerSeconds * 1000, typing: '', prompts: 0,
    };
    t.deadline = undefined;
    t.markers.push({ playerId: win.playerId, playerName: name, wordIndex: win.count, result: 'pending', given: '' });
    this.s.phase = 'buzz';
    this.setTimer('answer', this.s.settings.answerSeconds * 1000, () => this.submitAnswer(win.playerId, this.s.buzz?.typing ?? '', true));
    this.broadcast();
  }

  typing(by: string, text: string) {
    const clean = String(text ?? '').slice(0, 200);
    const b = this.s.buzz;
    if (b && b.playerId === by && !b.awaiting) {
      b.typing = clean;
      this.io.emitTo([...this.s.players.filter((p) => p.online && p.id !== by).map((p) => p.id), SPECTATOR], 'typing', { kind: 'tossup', text: clean });
      return;
    }
    const bn = this.s.bonus;
    if (bn && !bn.revealing && !bn.done && !bn.awaiting && this.captainOf(bn.teamId) === by) {
      bn.typing = clean;
      const watchers = [...this.teamMembers(bn.teamId), ...(this.s.readerId ? [this.s.readerId] : [])].filter((id) => id !== by);
      this.io.emitTo(watchers, 'typing', { kind: 'bonus', text: clean });
    }
  }

  submitAnswer(by: string, text: string, timedOut = false) {
    const b = this.s.buzz;
    if (!b || b.playerId !== by || b.awaiting) { if (timedOut) return; fail('It is not your turn to answer.'); }
    if (!timedOut) this.notPaused();
    const given = String(text ?? '').trim().slice(0, 200);
    this.clearTimer('answer');
    const { verdict, correctedTo, spelling } = given ? checkAnswerDetailed(given, this.s.tossup!.q.answer) : { verdict: 'incorrect' as const, correctedTo: undefined, spelling: false };
    if (given && this.s.settings.readerRules && this.readerOnline()) {
      b!.awaiting = { given, suggestion: verdict };
      b!.deadline = null;
      return this.broadcast();
    }
    this.applyTossupVerdict(spelling && b!.spellingUsed ? 'incorrect' : verdict, given, correctedTo, spelling);
  }

  /** The reader's ruling on the current tossup or bonus answer. */
  rule(by: string, verdict: Verdict) {
    if (by !== this.s.readerId && by !== this.s.hostId) fail('Only the reader rules on answers.');
    if (!['correct', 'prompt', 'incorrect'].includes(verdict)) fail('Unknown ruling.');
    const waiting = this.s.buzz?.awaiting ?? this.s.bonus?.awaiting;
    if (waiting && verdict === 'correct' && waiting.suggestion !== 'correct') this.s.unranked = true;
    if (this.s.buzz?.awaiting) this.applyTossupVerdict(verdict, this.s.buzz.awaiting.given);
    else if (this.s.bonus?.awaiting) this.applyBonusVerdict(verdict, this.s.bonus.awaiting.given);
    else fail('There is nothing to rule on.');
  }

  /** `spelling`: a near miss, so the player gets one chance to fix a typo (`spelling` holds what they typed). */
  private applyTossupVerdict(verdict: Verdict, given: string, correctedTo?: string, spelling = false) {
    const t = this.s.tossup!;
    const b = this.s.buzz!;
    const marker = t.markers[t.markers.length - 1];
    marker.given = given;
    if (verdict === 'prompt' && b.prompts < TIMING.maxPrompts) {
      b.prompts++;
      b.awaiting = undefined;
      b.typing = '';
      b.spelling = spelling ? given : undefined;
      if (spelling) b.spellingUsed = true;
      b.deadline = Date.now() + TIMING.promptSeconds * 1000;
      marker.result = 'prompt';
      this.setTimer('answer', TIMING.promptSeconds * 1000, () => this.submitAnswer(b.playerId, this.s.buzz?.typing ?? '', true));
      return this.broadcast();
    }
    const correct = verdict === 'correct';
    const { points, kind } = withBounty(scoreTossup(correct, b.wordIndex, t.words.length, t.powerIndex, this.s.settings), !!t.bounty);
    const p = this.player(b.playerId);
    this.s.rulings.push({
      id: rid(), type: 'tossup', num: t.num, playerId: b.playerId, playerName: p?.name ?? '?', teamId: b.teamId,
      category: t.q.category, given, correct, overridden: false, points, kind,
      wordIndex: b.wordIndex, totalWords: t.words.length, powerIndex: t.powerIndex,
      ...(correct && correctedTo ? { correctedTo } : {}),
      ...(t.bounty ? { bounty: true } : {}),
    });
    marker.result = kind;
    if (correct && correctedTo) marker.correctedTo = correctedTo;
    this.s.buzz = null;
    if (correct) return this.endTossup(b.teamId);

    t.locked.add(b.teamId);
    const remaining = [...this.activeTeams()].filter((id) => !t.locked.has(id));
    if (!remaining.length) return this.endTossup(null);
    this.s.phase = 'reading';
    if (this.readerOnline() && t.revealed < t.words.length) t.paused = true; // the reader resumes when ready
    if (t.paused) return this.broadcast();
    if (t.revealed < t.words.length) { this.broadcast(); this.setTimer('read', 500, () => this.readNext()); }
    else this.openDeadWindow();
  }

  private endTossup(winnerTeam: string | null, skipped = false) {
    const t = this.s.tossup;
    if (!t || t.ended) return;
    this.clearTimer('read', 'dead', 'answer', 'grace');
    this.pending = [];
    t.ended = true;
    t.deadline = undefined;
    t.revealed = t.words.length;
    if (this.s.buzz) { t.markers = t.markers.filter((m) => m.result !== 'pending' && m.result !== 'prompt'); this.s.buzz = null; }
    if (!skipped) {
      this.s.heard.push({
        num: t.num, category: t.q.category,
        playerIds: this.s.players.filter((p) => p.online && this.teamOf(p.id)).map((p) => p.id),
      });
    }
    this.s.review.unshift({
      num: t.num, category: t.q.category, subcategory: t.q.subcategory, setName: t.q.setName,
      words: t.words, powerIndex: t.powerIndex, answerHtml: safeAnswerHtml(t.q.answer), buzzes: t.markers,
      ref: { id: t.q.id, source: t.source ?? (this.s.daily ? 'daily' : this.s.settings.source) },
      ...(t.bounty ? { bounty: true } : {}),
    });
    if (this.s.review.length > 100) this.s.review.pop();
    t.bonusTeam = winnerTeam && this.s.settings.bonuses && this.s.settings.source !== 'lightning' ? winnerTeam : null;
    if (this.s.survival && !this.s.survival.done) this.survivalTossupOver(t.num, !!winnerTeam);
    this.s.phase = 'tossupEnd';
    if (!t.bonusTeam) this.openVote();
    this.broadcast();
  }

  // ---------- topic vote ----------

  private votingOn() { return this.s.settings.topicVote && !this.s.daily && !this.s.survival && !this.readerOnline(); }

  /** Online human players who can vote (the reader and bots don't). */
  private voters() { return this.s.players.filter((p) => p.online && !p.bot && this.teamOf(p.id)); }

  /** The room's filters narrowed to one category (keeping any subcategories picked inside it). */
  private onlyCategory(category: string): Filters {
    const f = this.s.settings.filters;
    const topic = TOPIC_BY_NAME.get(category);
    if (topic) return { ...f, categories: [], subcategories: [], topics: [topic.id] };
    const subs = CATEGORIES[category] ?? [];
    return { ...f, categories: [category], subcategories: f.subcategories.filter((sc) => subs.includes(sc)) };
  }

  /** Between tossups: offer a few categories for the next one. The next tossup starts when the vote closes. */
  private openVote() {
    if (!this.votingOn() || this.lengthReached()) return;
    // The voted topic is still running: no vote until its last tossup is done.
    if (this.s.voteRun && this.s.voteRun.played < this.s.voteRun.total) return;
    this.s.voteRun = null;
    const f = this.s.settings.filters;
    const topics = cleanTopics(f.topics).map((id) => TOPIC_BY_ID.get(id)!.name);
    // Picked categories and topics are on the ballot; with nothing picked, every category is.
    const pool = [...(f.categories.length ? f.categories : topics.length ? [] : Object.keys(CATEGORIES)), ...topics];
    if (pool.length < 2) return;
    const last = this.s.tossup?.q.category;
    // Prefer categories other than the one just played, so the topics move around.
    const fresh = shuffle(pool.filter((c) => c !== last));
    const options = [...fresh, ...pool.filter((c) => c === last)].slice(0, TIMING.voteOptions);
    this.s.vote = { options, votes: {}, deadline: Date.now() + TIMING.voteMs };
    this.setTimer('vote', TIMING.voteMs, () => this.closeVote());
  }

  castVote(by: string, category: string) {
    const v = this.s.vote ?? fail('There is no vote open.');
    if (!this.voters().some((p) => p.id === by)) fail('Only players can vote.');
    if (!v!.options.includes(category)) fail('That topic is not on the ballot.');
    this.notPaused();
    v!.votes[by] = category;
    const voters = this.voters();
    if (voters.every((p) => v!.votes[p.id])) return this.closeVote();
    this.broadcast();
  }

  /** Count the votes (ties broken at random, no votes = any option) and start the next tossup. */
  private closeVote() {
    const v = this.s.vote;
    if (!v) return;
    this.clearTimer('vote');
    const counts = new Map(v.options.map((o) => [o, 0]));
    for (const c of Object.values(v.votes)) if (counts.has(c)) counts.set(c, counts.get(c)! + 1);
    const top = Math.max(...counts.values());
    const leaders = v.options.filter((o) => counts.get(o) === top);
    this.s.voteRun = { option: leaders[Math.floor(Math.random() * leaders.length)], total: this.voteRunLength(), played: 0 };
    this.s.vote = null;
    void this.loadTossup();
  }

  /**
   * How many tossups a voted topic plays for: 5, or about a quarter of a set game length, up to 10
   * (20 tossups → 5, 30 → 8, 40 or more → 10). Never past the end of the game.
   */
  private voteRunLength() {
    const n = this.s.settings.gameLength;
    if (!n) return TIMING.voteRunMin;
    const len = Math.min(TIMING.voteRunMax, Math.max(TIMING.voteRunMin, Math.round(n / 4)));
    return Math.max(1, Math.min(len, n - this.s.tossupNum));
  }

  /** Vote switched off mid-vote: stay on this tossup and let someone press Next. */
  private cancelVote() {
    this.clearTimer('vote');
    this.s.vote = null;
  }

  // ---------- bonuses ----------

  private async startBonus(teamId: string) {
    this.dispose();
    const gen = ++this.loadGen;
    this.s.phase = 'loading';
    this.broadcast();
    let q: Bonus | null = null;
    try {
      q = await this.provider().nextBonus(this.s.settings.filters, this.s.seenBonuses);
    } catch (e: any) {
      if (gen !== this.loadGen) return;
      this.s.message = `Could not load a bonus (${e?.message ?? e}). Moving on.`;
    }
    if (gen !== this.loadGen) return;
    if (!q) {
      this.s.message ??= 'No bonuses left for these filters; skipping the bonus.';
      return this.loadTossup().then(() => { this.s.message ??= null; });
    }
    this.s.seenBonuses.add(q.id);
    this.s.bonus = {
      num: ++this.s.bonusNum, tossup: this.s.tossupNum, teamId, q, current: 0, results: [], deadline: null, typing: '', prompts: 0, revealing: false, done: false,
    };
    this.s.phase = 'bonus';
    this.startBonusPart();
  }

  private startBonusPart() {
    const bn = this.s.bonus!;
    Object.assign(bn, { typing: '', prompts: 0, revealing: false, awaiting: undefined, spelling: undefined, spellingUsed: false });
    bn.deadline = Date.now() + this.s.settings.bonusSeconds * 1000;
    this.setTimer('bonus', this.s.settings.bonusSeconds * 1000, () => this.bonusSubmit(this.captainOf(bn.teamId) ?? '', bn.typing, true));
    this.broadcast();
  }

  bonusSubmit(by: string, text: string, timedOut = false) {
    const bn = this.s.bonus;
    if (!bn || this.s.phase !== 'bonus' || bn.revealing || bn.done || bn.awaiting) { if (timedOut) return; fail('There is no bonus part to answer.'); }
    if (!timedOut && this.captainOf(bn!.teamId) !== by) fail('Only your team captain submits bonus answers.');
    if (!timedOut) this.notPaused();
    this.clearTimer('bonus');
    const given = String(text ?? '').trim().slice(0, 200);
    const { verdict, correctedTo, spelling } = given ? checkAnswerDetailed(given, bn!.q.answers[bn!.current]) : { verdict: 'incorrect' as const, correctedTo: undefined, spelling: false };
    if (given && this.s.settings.readerRules && this.readerOnline()) {
      bn!.awaiting = { given, suggestion: verdict };
      bn!.deadline = null;
      return this.broadcast();
    }
    this.applyBonusVerdict(spelling && bn!.spellingUsed ? 'incorrect' : verdict, given, correctedTo, spelling);
  }

  private applyBonusVerdict(verdict: Verdict, given: string, correctedTo?: string, spelling = false) {
    const bn = this.s.bonus!;
    bn.awaiting = undefined;
    if (verdict === 'prompt' && bn.prompts < TIMING.maxPrompts) {
      bn.prompts++;
      bn.typing = '';
      bn.spelling = spelling ? given : undefined;
      if (spelling) bn.spellingUsed = true;
      bn.deadline = Date.now() + TIMING.promptSeconds * 1000;
      this.setTimer('bonus', TIMING.promptSeconds * 1000, () => this.bonusSubmit(this.captainOf(bn.teamId) ?? '', bn.typing, true));
      return this.broadcast();
    }
    const correct = verdict === 'correct';
    const captain = this.captainOf(bn.teamId) ?? bn.teamId;
    this.s.rulings.push({
      id: rid(), type: 'bonus', num: bn.num, playerId: captain, playerName: this.player(captain)?.name ?? '?', teamId: bn.teamId,
      category: bn.q.category, given, correct, overridden: false, points: correct ? this.s.settings.bonusPartValue : 0, partIndex: bn.current, tossup: bn.tossup,
      ...(correct && correctedTo ? { correctedTo } : {}),
    });
    bn.results[bn.current] = { given, correct, ...(correct && correctedTo ? { correctedTo } : {}) };
    bn.revealing = true;
    bn.deadline = null;
    this.setTimer('bonusReveal', TIMING.partRevealMs, () => this.afterBonusReveal());
    this.broadcast();
  }

  private afterBonusReveal() {
    const bn = this.s.bonus;
    if (!bn) return;
    bn.current++;
    if (bn.current >= bn.q.parts.length) { bn.done = true; bn.revealing = false; bn.current = bn.q.parts.length - 1; this.openVote(); this.broadcast(); }
    else this.startBonusPart();
  }

  // ---------- chat, protests, overrides ----------

  chat(by: string, text: string, scope: 'all' | 'team') {
    const p = this.mustPlayer(by);
    if (p.muted) fail('You’re muted in this room.');
    const clean = String(text ?? '').trim().slice(0, 300);
    if (!clean) return;
    const teamId = this.teamOf(by);
    const msg: ChatMessage = { id: rid(), at: Date.now(), playerId: by, playerName: p.name, text: clean, scope: 'all' };
    if (scope === 'team' && teamId && this.s.settings.mode === 'teams') {
      msg.scope = 'team';
      this.postChat(msg, this.teamMembers(teamId));
    } else this.postChat(msg);
  }

  protest(by: string, rulingId: string, note: string) {
    const p = this.mustPlayer(by);
    if (this.s.daily) fail('Not available in the daily challenge: every score is checked the same way for everyone.');
    if (this.s.survival) fail('Not available in survival: every answer is checked the same way for everyone.');
    const r = this.s.rulings.find((x) => x.id === rulingId) ?? fail('No such ruling.');
    if (this.s.protests.some((x) => x.rulingId === rulingId && !x.resolved)) fail('That ruling is already protested.');
    this.s.protests.push({ id: rid(), rulingId, byId: by, byName: p.name, note: String(note ?? '').slice(0, 200), resolved: false });
    const where = r!.type === 'tossup' ? `tossup ${r!.num}` : `bonus ${r!.num}`;
    this.system(`${p.name} thinks "${r!.given || '(no answer)'}" by ${r!.playerName} on ${where} should be marked ${r!.correct ? 'wrong' : 'correct'}. The ${this.s.readerId ? 'reader' : 'host'} will decide.`);
    this.broadcast();
  }

  resolveProtest(by: string, protestId: string, accept: boolean) {
    if (!this.isController(by)) fail('Only the host or reader resolves protests.');
    if (this.s.daily) fail('Not available in the daily challenge: every score is checked the same way for everyone.');
    if (this.s.survival) fail('Not available in survival: every answer is checked the same way for everyone.');
    const pr = this.s.protests.find((x) => x.id === protestId && !x.resolved) ?? fail('No open protest.');
    pr!.resolved = true;
    if (accept) this.flipRuling(pr!.rulingId);
    const r = this.s.rulings.find((x) => x.id === pr!.rulingId);
    const judge = this.player(by)?.name ?? (by === this.s.readerId ? 'The reader' : 'The host');
    this.system(accept
      ? `${judge} agreed with ${pr!.byName}: "${r?.given || '(no answer)'}" is now marked ${r?.correct ? 'correct' : 'wrong'}, and the scores are updated.`
      : `${judge} kept the ruling on "${r?.given || '(no answer)'}" that ${pr!.byName} protested.`);
    this.broadcast();
  }

  override(by: string, rulingId: string) {
    if (!this.isController(by)) fail('Only the host or reader can override.');
    if (this.s.daily) fail('Not available in the daily challenge: every score is checked the same way for everyone.');
    if (this.s.survival) fail('Not available in survival: every answer is checked the same way for everyone.');
    this.flipRuling(rulingId);
    const r = this.s.rulings.find((x) => x.id === rulingId)!;
    this.system(`${this.player(by)?.name ?? 'The host'} changed "${r.given || '(no answer)'}" by ${r.playerName} to ${r.correct ? 'correct' : 'wrong'}. The scores are updated.`);
    this.broadcast();
  }

  private flipRuling(rulingId: string) {
    const r = this.s.rulings.find((x) => x.id === rulingId) ?? fail('No such ruling.');
    this.s.unranked = true;
    if (r!.type !== 'tossup') {
      r!.correct = !r!.correct;
      r!.overridden = !r!.overridden;
      r!.points = r!.correct ? this.s.settings.bonusPartValue : 0;
      return;
    }
    // A cancelled answer was correct; flipping it means ruling it wrong.
    r!.correct = r!.voidedBy ? false : !r!.correct;
    r!.voidedBy = undefined;
    r!.overridden = !r!.overridden;
    this.rescoreTossupRuling(r!);
    this.settleTossup(r!.num);
  }

  private rescoreTossupRuling(r: Ruling) {
    const scored = withBounty(scoreTossup(r.correct, r.wordIndex ?? 0, r.totalWords ?? 0, r.powerIndex ?? null, this.s.settings), !!r.bounty);
    // A cancelled correct answer scores nothing (it isn't a neg).
    const { points, kind } = r.voidedBy ? { points: 0, kind: 'zero' as const } : scored;
    r.points = points;
    r.kind = kind;
    const lists = [this.s.tossup?.num === r.num ? this.s.tossup.markers : [], ...this.s.review.filter((x) => x.num === r.num).map((x) => x.buzzes)];
    for (const list of new Set(lists)) for (const m of list) if (m.playerId === r.playerId && m.given === r.given) m.result = kind;
  }

  /**
   * Only one answer scores on a tossup: the earliest correct one. After a ruling is reversed, later correct
   * answers on the same tossup are cancelled (and get their points back if the earlier one is reversed again).
   */
  private settleTossup(num: number) {
    let winner: Ruling | null = null;
    for (const r of this.s.rulings) {
      if (r.type !== 'tossup' || r.num !== num) continue;
      const right = r.correct || !!r.voidedBy;
      if (!right) continue;
      if (!winner) {
        winner = r;
        if (r.voidedBy) { r.voidedBy = undefined; r.correct = true; this.rescoreTossupRuling(r); }
      } else if (r.voidedBy !== winner.id) {
        r.voidedBy = winner.id;
        r.correct = false;
        this.rescoreTossupRuling(r);
      }
    }
    // Reversing a ruling on the tossup that just ended also decides who gets its bonus.
    const t = this.s.tossup;
    if (t && t.num === num && t.ended && this.s.phase === 'tossupEnd' && this.s.settings.bonuses && this.s.settings.source !== 'lightning') {
      t.bonusTeam = winner ? winner.teamId : null;
    }
  }

  adjust(by: string, playerId: string, delta: number) {
    if (!this.isController(by)) fail('Only the host or reader can adjust scores.');
    if (this.s.daily) fail('Not available in the daily challenge: every score is checked the same way for everyone.');
    if (this.s.survival) fail('Not available in survival: every answer is checked the same way for everyone.');
    const teamId = this.teamOf(playerId) ?? fail('That player is not playing.');
    const d = clamp(delta, -50, 50, 0);
    if (!d) return;
    this.s.adjustments.push({ playerId, teamId: teamId!, delta: d, num: this.s.tossupNum });
    this.s.unranked = true;
    this.system(`${this.player(playerId)?.name} ${d > 0 ? '+' : ''}${d} (score adjustment).`);
    this.broadcast();
  }

  upload(by: string, raw: unknown) {
    if (!this.isController(by)) fail('Only the host or reader can upload a packet.');
    // Fixed-question rooms: a packet would replace the questions everyone else plays.
    if (this.s.daily) fail('The daily challenge uses the same questions for everyone.');
    if (this.s.survival) fail('Survival uses the same questions for everyone.');
    const parsed = parseUpload(raw);
    if (!parsed.tossups.length) fail('No tossups found. Each needs "question" and "answer" fields.');
    this.s.upload = parsed;
    this.uploadProvider = new LocalProvider(parsed.tossups, parsed.bonuses);
    this.s.settings.source = 'upload';
    this.clearQueue();
    void this.fillQueue();
    this.system(`Packet loaded: ${parsed.tossups.length} tossups, ${parsed.bonuses.length} bonuses.`);
    this.broadcast();
    return { tossups: parsed.tossups.length, bonuses: parsed.bonuses.length };
  }

  // ---------- snapshots ----------

  private sharedSnapshot() {
    const ids = this.s.players.map((p) => p.id);
    const stats = computePlayerStats(ids, this.s.rulings, this.s.adjustments, this.s.heard);
    const teams = this.s.settings.mode === 'teams'
      ? this.s.teams.map((t) => ({ id: t.id, name: t.name, playerIds: t.playerIds, captainId: this.captainOf(t.id), ...computeTeamTotals(t.id, this.s.rulings, this.s.adjustments) }))
      : [];
    const streaks = this.streaks();
    const players = this.s.players.map((p) => ({ id: p.id, name: p.name, online: p.online, teamId: this.teamOf(p.id), stats: stats[p.id], ...streaks[p.id], ...(p.bot ? { bot: p.bot } : {}), ...(p.username ? { username: p.username } : {}), ...(p.admin ? { admin: true } : {}), ...(p.title ? { title: p.title } : {}), ...(p.level ? { level: p.level } : {}), ...(p.pic ? { pic: p.pic } : {}), ...(p.ping != null && p.online && !p.bot ? { ping: Math.round(p.ping) } : {}), ...(p.muted ? { muted: true } : {}) }));
    // FFA bonus totals live on each player's "team" (themselves).
    const ffaTeams = this.s.settings.mode === 'ffa'
      ? this.s.players.map((p) => ({ id: p.id, name: p.name, playerIds: [p.id], captainId: p.id, ...computeTeamTotals(p.id, this.s.rulings, this.s.adjustments) }))
      : [];
    const allTeams = teams.length ? teams : ffaTeams;
    const over = this.s.phase === 'gameOver';
    return {
      players, teams: allTeams,
      history: over ? this.scoreHistory() : [],
      highlights: over ? this.computeHighlights(players, allTeams) : [],
    };
  }

  /** Current and best run of converted tossups per player, over the tossups they heard. */
  private streaks(): Record<string, { streak: number; bestStreak: number }> {
    const out: Record<string, { streak: number; bestStreak: number }> = {};
    for (const p of this.s.players) out[p.id] = { streak: 0, bestStreak: 0 };
    const got = new Map<number, string>();
    for (const r of this.s.rulings) if (r.type === 'tossup' && r.correct) got.set(r.num, r.playerId);
    for (const h of [...this.s.heard].sort((a, b) => a.num - b.num)) {
      for (const id of h.playerIds) {
        const st = out[id];
        if (!st) continue;
        st.streak = got.get(h.num) === id ? st.streak + 1 : 0;
        st.bestStreak = Math.max(st.bestStreak, st.streak);
      }
    }
    return out;
  }

  /** Running score after each tossup (its bonus included), per team or per player. */
  private scoreHistory(): ScorePoint[] {
    const sides = this.s.settings.mode === 'teams'
      ? this.s.teams.map((t) => t.id)
      : this.s.players.filter((p) => p.id !== this.s.readerId).map((p) => p.id);
    const delta = new Map<number, Record<string, number>>();
    const add = (num: number, side: string, pts: number) => {
      const d = delta.get(num) ?? {};
      d[side] = (d[side] ?? 0) + pts;
      delta.set(num, d);
    };
    for (const r of this.s.rulings) add(r.type === 'tossup' ? r.num : r.tossup ?? r.num, r.teamId, r.points);
    for (const a of this.s.adjustments) add(a.num ?? this.s.tossupNum, a.teamId, a.delta);
    const nums = [...new Set([...this.s.heard.map((h) => h.num), ...delta.keys()])].sort((a, b) => a - b);
    const run: Record<string, number> = Object.fromEntries(sides.map((id) => [id, 0]));
    const out: ScorePoint[] = [{ num: 0, totals: { ...run } }];
    for (const num of nums) {
      for (const [side, pts] of Object.entries(delta.get(num) ?? {})) if (side in run) run[side] += pts;
      out.push({ num, totals: { ...run } });
    }
    return out;
  }

  private computeHighlights(
    players: { id: string; name: string; stats: PlayerStats; bestStreak: number }[],
    teams: { name: string; bonusesHeard: number; bonusPoints: number }[],
  ): Highlight[] {
    const out: Highlight[] = [];
    const ps = players.filter((p) => p.id !== this.s.readerId);
    const name = (id: string) => this.player(id)?.name ?? '?';
    const best = <T,>(xs: T[], score: (x: T) => number) => xs.reduce<T | null>((m, x) => (m === null || score(x) > score(m) ? x : m), null);

    const correct = this.s.rulings.filter((r) => r.type === 'tossup' && r.correct && r.totalWords);
    const early = best(correct, (r) => -(r.wordIndex ?? 0) / r.totalWords!);
    if (early) out.push({ icon: '⚡', title: 'Earliest buzz', name: name(early.playerId), detail: `${Math.round(((early.wordIndex ?? 0) / early.totalWords!) * 100)}% into tossup ${early.num}` });
    const powers = best(ps, (p) => p.stats.powers);
    if (powers && powers.stats.powers > 0) out.push({ icon: '💥', title: 'Most powers', name: powers.name, detail: `${powers.stats.powers} power${powers.stats.powers === 1 ? '' : 's'}` });
    const streak = best(ps, (p) => p.bestStreak);
    if (streak && streak.bestStreak >= 2) out.push({ icon: '🔥', title: 'Longest streak', name: streak.name, detail: `${streak.bestStreak} tossups in a row` });
    const ppth = best(ps.filter((p) => p.stats.heard >= 3), (p) => p.stats.points / p.stats.heard);
    if (ppth && ppth.stats.points > 0) out.push({ icon: '📈', title: 'Best points per tossup', name: ppth.name, detail: `${(ppth.stats.points / ppth.stats.heard).toFixed(2)} PPTH` });
    if (this.s.settings.mode === 'teams') {
      const ppb = best(teams.filter((t) => t.bonusesHeard > 0), (t) => t.bonusPoints / t.bonusesHeard);
      if (ppb) out.push({ icon: '🎯', title: 'Best bonus conversion', name: ppb.name, detail: `${(ppb.bonusPoints / ppb.bonusesHeard).toFixed(1)} PPB` });
    }
    const negs = best(ps, (p) => p.stats.negs);
    if (negs && negs.stats.negs > 0) out.push({ icon: '🎲', title: 'Boldest buzzer', name: negs.name, detail: `${negs.stats.negs} neg${negs.stats.negs === 1 ? '' : 's'}` });
    return out;
  }

  // ---------- saving and restoring (survives a server restart) ----------

  /** Plain JSON copy of the room. */
  toJSON() {
    const s = this.s;
    return {
      ...s,
      seenTossups: [...s.seenTossups],
      seenBonuses: [...s.seenBonuses],
      tossup: s.tossup && { ...s.tossup, locked: [...s.tossup.locked] },
    };
  }

  /** Rebuild a room saved with toJSON. Everyone starts offline and a running game comes back paused. */
  static restore(data: ReturnType<Room['toJSON']>, io: RoomIO, deps: RoomDeps = {}): Room {
    const room = new Room(data.code, io, deps);
    room.s = {
      ...room.s,
      ...data,
      seenTossups: new Set(data.seenTossups),
      seenBonuses: new Set(data.seenBonuses),
      tossup: data.tossup && { ...data.tossup, locked: new Set(data.tossup.locked) },
      paused: false,
      pausedAt: null,
    };
    for (const p of room.s.players) p.online = false;
    room.hostReservedUntil = Date.now() + 2 * 60_000;
    if (room.s.upload) room.uploadProvider = new LocalProvider(room.s.upload.tossups, room.s.upload.bonuses);
    if (room.s.survival) room.useSurvivalQuestions();
    room.rearm();
    return room;
  }

  private rearm() {
    const s = this.s;
    const now = Date.now();
    s.vote = null; // a vote doesn't survive a restart; whoever is there presses Next
    if (s.phase === 'loading') {
      s.phase = s.tossup ? 'tossupEnd' : s.tossupNum ? 'tossupEnd' : 'lobby';
      if (s.tossup && !s.tossup.ended) s.tossup.ended = true;
    }
    if (!['reading', 'buzz', 'bonus'].includes(s.phase)) return;
    s.paused = true;
    s.pausedAt = now;
    const t = s.tossup;
    if (s.phase === 'reading' && t && !t.paused) {
      if (t.revealed >= t.words.length) { const ms = buzzWindowSeconds(s.settings) * 1000; t.deadline = now + ms; this.setTimer('dead', ms, () => this.endTossup(null)); }
      else this.setTimer('read', 500, () => this.readNext());
    } else if (s.phase === 'buzz' && s.buzz && !s.buzz.awaiting) {
      const b = s.buzz;
      const secs = b.prompts ? TIMING.promptSeconds : s.settings.answerSeconds;
      b.deadline = now + secs * 1000;
      this.setTimer('answer', secs * 1000, () => this.submitAnswer(b.playerId, this.s.buzz?.typing ?? '', true));
    } else if (s.phase === 'bonus' && s.bonus && !s.bonus.done) {
      const bn = s.bonus;
      if (bn.revealing) this.setTimer('bonusReveal', TIMING.partRevealMs, () => this.afterBonusReveal());
      else if (!bn.awaiting) {
        const secs = bn.prompts ? TIMING.promptSeconds : s.settings.bonusSeconds;
        bn.deadline = now + secs * 1000;
        this.setTimer('bonus', secs * 1000, () => this.bonusSubmit(this.captainOf(bn.teamId) ?? '', bn.typing, true));
      }
    }
    this.system('The server restarted. The host or reader can press Resume to carry on.');
  }

  snapshot(viewer: string | null, shared = this.sharedSnapshot()): PublicState {
    const s = this.s;
    const isReader = !!viewer && viewer === s.readerId;
    const visible = viewer ? this.textVisibleTo(viewer) : false;
    const t = s.tossup;
    const reveal = !!t && (t.ended || isReader);
    const bn = s.bonus;
    const viewerTeam = viewer ? this.teamOf(viewer) : null;
    const seesBonusTyping = !!bn && (isReader || viewerTeam === bn.teamId);
    // Only a logged-in admin gets these; nobody else's state ever mentions peeking or freezing.
    const me = viewer ? this.player(viewer) : undefined;
    const adminExtras = me?.admin ? {
      admin: {
        peek: !!me.peek,
        frozen: s.players.filter((p) => p.frozen || (p.frozenFor !== undefined && p.frozenFor >= s.tossupNum)).map((p) => ({ id: p.id, always: !!p.frozen })),
        slowed: s.players.filter((p) => p.slowed).map((p) => p.id),
      },
      ...(me.peek ? {
        peek: {
          tossup: t && !t.ended ? safeAnswerHtml(t.q.answer) : undefined,
          bonus: bn && !bn.done ? bn.q.answers.map((a) => safeAnswerHtml(a)) : undefined,
        },
      } : {}),
    } : {};
    return {
      ...adminExtras,
      code: s.code,
      you: viewer,
      hostId: s.hostId,
      readerId: s.readerId,
      heldReader: s.seatHold?.reader && Date.now() < s.seatHold.reader.until
        ? { id: s.seatHold.reader.id, name: this.player(s.seatHold.reader.id)?.name ?? '?', until: s.seatHold.reader.until }
        : null,
      settings: s.settings,
      phase: s.phase,
      tossup: t && {
        num: t.num, category: t.q.category, subcategory: t.q.subcategory, difficulty: t.q.difficulty, setName: t.q.setName, year: t.q.year,
        ...this.topicOf(t.q),
        revealed: t.words.slice(0, t.revealed).map((w) => (visible || t.ended ? w : '')),
        totalWords: t.words.length,
        words: reveal ? t.words : undefined,
        powerIndex: reveal ? t.powerIndex : undefined,
        answerHtml: reveal ? safeAnswerHtml(t.q.answer) : undefined,
        answerKey: t.ended ? answerKey(t.q, t.markers.filter((m) => m.playerId === viewer && (m.result === 'neg' || m.result === 'zero') && m.given).map((m) => m.given!)) : undefined,
        buzzes: t.markers,
        textVisible: visible,
        paused: t.paused,
        deadline: t.deadline,
        lockedTeamIds: [...t.locked],
        bonusTeamId: t.ended ? t.bonusTeam : null,
        ...(t.bounty ? { bounty: true } : {}),
      },
      buzz: s.buzz && {
        playerId: s.buzz.playerId, playerName: this.player(s.buzz.playerId)?.name ?? '?', wordIndex: s.buzz.wordIndex,
        deadline: s.buzz.deadline, typing: s.buzz.typing, prompts: s.buzz.prompts, awaitingRuling: s.buzz.awaiting,
        ...(s.buzz.spelling ? { spelling: s.buzz.spelling } : {}),
      },
      bonus: bn && {
        num: bn.num, teamId: bn.teamId, teamName: this.teamName(bn.teamId), category: bn.q.category,
        leadin: visible || isReader ? bn.q.leadin : '',
        parts: bn.q.parts.slice(0, bn.current + 1).map((text, i) => {
          const shown = i < bn.current || bn.revealing || bn.done;
          return {
            text: visible || shown ? text : '',
            answerHtml: shown ? safeAnswerHtml(bn.q.answers[i]) : undefined,
            given: bn.results[i]?.given,
            correct: bn.results[i]?.correct,
            correctedTo: bn.results[i]?.correctedTo,
          };
        }),
        current: bn.current, deadline: bn.deadline, typing: seesBonusTyping ? bn.typing : '', prompts: bn.prompts,
        revealing: bn.revealing, done: bn.done, awaitingRuling: bn.awaiting,
        ...(bn.spelling && seesBonusTyping ? { spelling: bn.spelling } : {}),
        readerParts: isReader ? bn.q.parts.map((text, i) => ({ text, answerHtml: safeAnswerHtml(bn.q.answers[i]) })) : undefined,
      },
      players: shared.players,
      teams: shared.teams,
      rulings: s.rulings.slice(-60),
      protests: s.protests.filter((p) => !p.resolved),
      review: s.review,
      reported: viewer ? s.reported?.[viewer] ?? [] : [],
      tossupsRead: s.heard.length,
      uploadedCount: s.upload ? { tossups: s.upload.tossups.length, bonuses: s.upload.bonuses.length } : null,
      message: s.message,
      paused: s.paused,
      history: shared.history,
      highlights: shared.highlights,
      daily: s.daily ? { day: s.daily.day, number: s.daily.number, total: s.daily.total, done: s.daily.done } : undefined,
      survival: s.survival ? {
        lives: s.survival.lives, maxLives: SURVIVAL_LIVES, tossups: s.survival.marks.length,
        correct: [...s.survival.marks].filter((m) => m === 'P' || m === 'T').length, marks: s.survival.marks, done: s.survival.done,
      } : undefined,
      vote: s.vote ? this.publicVote(s.vote, viewer) : null,
      ...(s.voteRun && s.voteRun.played > 0 && s.settings.topicVote
        ? { voteRun: { name: s.voteRun.option, num: Math.min(s.voteRun.played, s.voteRun.total), total: s.voteRun.total } }
        : {}),
      ...(isReader ? {
        upcoming: this.upcoming.map((q) => ({
          id: q.id, category: q.category, subcategory: q.subcategory, difficulty: q.difficulty, setName: q.setName, year: q.year,
          text: stripHtml(q.question).replace(/\s*\(\*\)\s*/, ' (*) '), answerHtml: safeAnswerHtml(q.answer),
        })),
        upcomingLoading: this.fillingQueue,
      } : {}),
    };
  }

  private publicVote(v: NonNullable<RoomState['vote']>, viewer: string | null) {
    const counts: Record<string, number> = Object.fromEntries(v.options.map((o) => [o, 0]));
    for (const c of Object.values(v.votes)) if (c in counts) counts[c]++;
    const voters = this.voters();
    return {
      options: v.options, counts, mine: (viewer && v.votes[viewer]) || null, deadline: v.deadline,
      runLength: this.voteRunLength(),
      voters: voters.length, voted: voters.filter((p) => v.votes[p.id]).length,
    };
  }

  chatHistory(viewer: string) {
    void viewer;
    return this.s.chat;
  }
}
