import {
  DEFAULT_SETTINGS, SPECTATOR,
  type BotSkill, type BuzzMarker, type ChatMessage, type Highlight, type Phase, type PlayerStats, type Protest, type PublicState, type ReviewItem,
  type Ruling, type ScorePoint, type Settings, type Verdict,
} from '../../shared/types';
import { checkAnswerDetailed } from '../game/answerCheck';
import { computePlayerStats, computeTeamTotals, parseTossupText, scoreTossup, type Adjustment, type HeardEntry } from '../game/scoring';
import { stripHtml, safeAnswerHtml } from '../game/text';
import { LocalProvider, parseUpload, QBReaderProvider } from '../questions/providers';
import { CATALOG_BONUSES, CATALOG_TOSSUPS } from '../questions/catalog';
import { SAMPLE_BONUSES, SAMPLE_TOSSUPS } from '../questions/sample';
import type { Bonus, QuestionProvider, Tossup } from '../questions/types';
import type { GameRecord } from '../../shared/accounts';

/** How the room talks to the outside world (Socket.IO in production, a fake in tests). */
export interface RoomIO {
  /** Send a per-viewer payload to every connected player of the room. */
  emitEach(event: string, payload: (viewerId: string) => unknown): void;
  /** Send the same payload to specific players. */
  emitTo(playerIds: string[], event: string, payload: unknown): void;
  /** A game finished: one record per logged-in player who played in it. */
  gameOver?(records: { accountId: string; game: GameRecord }[]): void;
}

/** A logged-in player's account, attached when they join. */
export interface JoinAccount { id: string; username: string; admin?: boolean }

export class ActionError extends Error {}
const fail = (msg: string): never => { throw new ActionError(msg); };

export const TIMING = {
  /** A host or reader who drops gets their seat back if they reconnect within this long. */
  seatHoldMs: 3 * 60_000,
  /** After the first buzz arrives, wait this long for earlier (laggier) buzzes before awarding it. */
  graceMs: 120,
  /** A client may claim it buzzed before a word only if that word went out at most this long ago. */
  maxLagMs: 1200,
  promptSeconds: 5,
  partRevealMs: 3000,
  startDelayMs: 900,
  maxPrompts: 2,
  teamSize: 4,
  /** How many upcoming tossups the reader can preview. */
  lookahead: 3,
};

interface Player { id: string; token: string; name: string; online: boolean; teamId: string | null; bot?: BotSkill; accountId?: string; username?: string; admin?: boolean }
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
}

interface LiveBuzz {
  playerId: string;
  teamId: string;
  wordIndex: number;
  deadline: number | null;
  typing: string;
  prompts: number;
  awaiting?: { given: string; suggestion: Verdict };
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
}

/** Everything about a room. Plain data except the Sets, so it can move to Redis later. */
export interface RoomState {
  /** Set for a daily-challenge room: one player, fixed questions, fixed settings. */
  daily: DailyInfo | null;
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
  /** Whole-game pause by the host or reader: every timer is frozen. */
  paused: boolean;
  pausedAt: number | null;
  /** Seats kept for a host or reader whose connection dropped, until they come back or time runs out. */
  seatHold?: { host?: { id: string; until: number }; reader?: { id: string; until: number } };
  /** This game's results were already saved to players' profiles. */
  recorded?: boolean;
}

const rid =(n = 10) => Array.from({ length: n }, () => 'abcdefghijkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 32)]).join('');
const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/** Built-in questions: the original sample packet plus the Trivio catalog. Works offline. */
const sampleProvider = new LocalProvider([...SAMPLE_TOSSUPS, ...CATALOG_TOSSUPS], [...SAMPLE_BONUSES, ...CATALOG_BONUSES]);

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
      tossupNum: 0, bonusNum: 0, message: null, lastActive: Date.now(), paused: false, pausedAt: null, daily: null,
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

  private provider(): QuestionProvider {
    if (this.s.settings.source === 'sample') return sampleProvider;
    if (this.s.settings.source === 'upload') return this.uploadProvider ?? sampleProvider;
    return this.qbreader;
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
    let existing = token ? this.s.players.find((p) => p.token === token) : undefined;
    // A seat that belongs to a different account isn't yours, even with its token.
    if (existing?.accountId && account && existing.accountId !== account.id) existing = undefined;
    // Logged-in players get their seat back from any device.
    if (!existing && account) existing = this.s.players.find((p) => p.accountId === account.id);
    if (existing) {
      existing.online = true;
      if (clean) existing.name = clean;
      if (account && !existing.accountId) { existing.accountId = account.id; existing.username = account.username; }
      // Admin powers need the admin to be logged in right now, not just a saved seat token.
      existing.admin = (account && existing.accountId === account.id && account.admin) || undefined;
      const hostAway = !this.s.hostId || !this.player(this.s.hostId)?.online;
      if (hostAway && (existing.id === this.s.hostId || Date.now() > this.hostReservedUntil)) this.s.hostId = existing.id;
      this.restoreSeats(existing);
      this.broadcast();
      return { playerId: existing.id, token: existing.token };
    }
    if (!clean) fail('Pick a display name.');
    if (this.s.daily && this.s.players.length) fail('The daily challenge is played solo. Start your own from the home page.');
    if (this.s.players.length >= 60) fail('This room is full.');
    const p: Player = { id: rid(), token: rid(24), name: clean, online: true, teamId: null, ...(account ? { accountId: account.id, username: account.username, ...(account.admin ? { admin: true } : {}) } : {}) };
    this.s.players.push(p);
    if (this.s.settings.mode === 'teams') this.autoAssign(p);
    if (!this.s.hostId || (!this.player(this.s.hostId)?.online && Date.now() > this.hostReservedUntil)) this.s.hostId = p.id;
    this.system(`${p.name} joined.`);
    this.broadcast();
    return { playerId: p.id, token: p.token };
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
    const source = { qbreader: 'QBReader', sample: 'the built-in questions', upload: 'the uploaded packet' }[s.source] ?? s.source;
    const parts = [f.subcategories.length ? f.subcategories.join(', ') : f.categories.length ? f.categories.join(', ') : 'all categories'];
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
    const s = this.s.settings;
    const questionsKey = this.questionsKey();
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
    for (const k of ['powers', 'negs', 'bonuses', 'showTextToPlayers', 'readerRules'] as const) {
      if (typeof patch[k] === 'boolean') s[k] = patch[k]!;
    }
    if (patch.powerValue !== undefined) s.powerValue = clamp(patch.powerValue, 0, 50, s.powerValue);
    if (patch.tenValue !== undefined) s.tenValue = clamp(patch.tenValue, 0, 50, s.tenValue);
    if (patch.negValue !== undefined) s.negValue = clamp(patch.negValue, -50, 0, s.negValue);
    if (patch.bonusPartValue !== undefined) s.bonusPartValue = clamp(patch.bonusPartValue, 0, 50, s.bonusPartValue);
    if (patch.source && ['qbreader', 'sample', 'upload'].includes(patch.source)) {
      if (patch.source === 'upload' && !this.uploadProvider) fail('Upload a packet first.');
      s.source = patch.source;
    }
    if (patch.filters) {
      const f = patch.filters;
      s.filters = {
        categories: Array.isArray(f.categories) ? f.categories.map(String).slice(0, 30) : s.filters.categories,
        subcategories: Array.isArray(f.subcategories) ? f.subcategories.map(String).slice(0, 60) : s.filters.subcategories,
        difficulties: Array.isArray(f.difficulties) ? f.difficulties.map(Number).filter((d) => d >= 0 && d <= 10) : s.filters.difficulties,
        minYear: f.minYear ? clamp(f.minYear, 1990, 2100, 0) || undefined : undefined,
        maxYear: f.maxYear ? clamp(f.maxYear, 1990, 2100, 0) || undefined : undefined,
      };
    }
    if (patch.source || patch.filters) {
      const before = questionsKey;
      if (this.questionsKey() !== before) {
        this.clearQueue();
        void this.fillQueue();
        if (this.s.phase !== 'lobby') this.system(`${this.mustPlayer(by).name} changed the questions to ${this.questionsLabel()}. ${this.midGame() ? 'They start with the next tossup.' : ''}`.trim());
      }
    }
    this.broadcast();
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
    if (this.s.phase === 'gameOver') this.resetScores();
    else if (this.s.phase !== 'lobby') fail('The game is already running.');
    this.s.message = null;
    this.s.paused = false;
    this.s.pausedAt = null;
    this.s.recorded = false;
    this.system('Game started. Good luck!');
    void this.loadTossup();
  }

  private resetScores() {
    Object.assign(this.s, { rulings: [], adjustments: [], heard: [], protests: [], review: [], tossupNum: 0, bonusNum: 0, tossup: null, bonus: null, buzz: null });
  }

  end(by: string) {
    if (!this.isController(by)) fail('Only the host or reader can end the game.');
    this.dispose();
    this.pending = [];
    this.loadGen++;
    if (this.s.tossup && !this.s.tossup.ended) this.s.tossup.ended = true;
    this.s.buzz = null;
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

  /** Save a game everyone walked away from (called before an idle room is deleted). */
  recordIfUnfinished() {
    if (this.s.phase !== 'lobby' && this.s.phase !== 'gameOver' && this.s.heard.length >= 3) this.recordResults(true);
  }

  /** Hand each logged-in player's results to io.gameOver, once per game. */
  private recordResults(abandoned: boolean) {
    if (this.s.recorded || !this.s.heard.length || !this.io.gameOver) return;
    this.s.recorded = true;
    const { players, teams } = this.sharedSnapshot();
    const statsOf = new Map(players.map((p) => [p.id, p]));
    const played = (id: string) => { const st = statsOf.get(id)?.stats; return !!st && (st.heard > 0 || st.buzzes > 0); };
    const teamsMode = this.s.settings.mode === 'teams';
    // Competing sides: teams with someone who played, or (free-for-all) players other than the reader who played.
    const sides = teams.filter((t) => (teamsMode ? t.playerIds.some(played) : t.id !== this.s.readerId && played(t.id)));
    const ranked = [...sides].sort((a, b) => b.points - a.points);
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
    if (!this.canDirect(by)) fail('The reader decides when to move on.');
    this.notPaused();
    const { phase, tossup, bonus } = this.s;
    if (phase === 'tossupEnd' && this.s.daily && this.s.tossupNum >= this.s.daily.total) return this.end(by);
    if (phase === 'tossupEnd') {
      if (tossup?.bonusTeam) void this.startBonus(tossup.bonusTeam);
      else void this.loadTossup();
    } else if (phase === 'bonus' && bonus?.done) {
      void this.loadTossup();
    } else if (phase === 'reading' || phase === 'buzz') {
      if (!this.isController(by)) fail('Only the host or reader can skip a question.');
      this.endTossup(null, true);
    } else if (phase === 'bonus') {
      if (!this.isController(by)) fail('Only the host or reader can skip a bonus.');
      void this.loadTossup();
    } else if (phase === 'lobby' || phase === 'gameOver') {
      this.start(by);
    }
  }

  private async loadTossup() {
    this.dispose();
    this.pending = [];
    const gen = ++this.loadGen;
    Object.assign(this.s, { phase: 'loading', buzz: null, bonus: null, message: null });
    this.broadcast();
    let q: Tossup | null = this.upcoming.shift() ?? null;
    try {
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
    if (!q) {
      this.s.message = 'No more unread questions match these filters. Widen the filters or upload a packet.';
      this.s.phase = this.s.tossupNum ? 'tossupEnd' : 'lobby';
      if (this.s.tossup) this.s.tossup.bonusTeam = null;
      return this.broadcast();
    }
    this.s.seenTossups.add(q.id);
    const { words, powerIndex } = parseTossupText(q.question);
    this.s.tossup = {
      num: ++this.s.tossupNum, q, words, powerIndex, revealed: 0, revealTimes: [], locked: new Set(), markers: [],
      paused: false, ended: false, bonusTeam: null,
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
    t.deadline = Date.now() + this.s.settings.deadSeconds * 1000;
    this.setTimer('dead', this.s.settings.deadSeconds * 1000, () => this.endTossup(null));
    this.broadcast();
  }

  /** Reader controls: pause / resume the teleprompter. */
  setPaused(by: string, paused: boolean) {
    if (!this.isController(by)) fail('Only the reader or host can pause.');
    if (this.s.daily && paused) fail('The daily challenge can’t be paused.');
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
    if (t!.locked.has(teamId)) fail(this.s.settings.mode === 'teams' ? 'Your team already buzzed on this question.' : 'You already buzzed on this question.');
    if (this.pending.some((p) => p.teamId === teamId)) return;
    const now = Date.now();
    // Trust the client's word count only as far back as plausible network lag allows.
    let count = Math.max(0, Math.min(Math.floor(Number(clientCount)) || 0, t!.revealed));
    while (count < t!.revealed && now - t!.revealTimes[count] > TIMING.maxLagMs) count++;
    this.pending.push({ playerId: by, teamId, count, at: now });
    if (this.pending.length === 1) {
      this.clearTimer('read', 'dead');
      this.setTimer('grace', TIMING.graceMs, () => this.resolveBuzz());
    }
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
    const { verdict, correctedTo } = given ? checkAnswerDetailed(given, this.s.tossup!.q.answer) : { verdict: 'incorrect' as const, correctedTo: undefined };
    if (given && this.s.settings.readerRules && this.readerOnline()) {
      b!.awaiting = { given, suggestion: verdict };
      b!.deadline = null;
      return this.broadcast();
    }
    this.applyTossupVerdict(verdict, given, correctedTo);
  }

  /** The reader's ruling on the current tossup or bonus answer. */
  rule(by: string, verdict: Verdict) {
    if (by !== this.s.readerId && by !== this.s.hostId) fail('Only the reader rules on answers.');
    if (!['correct', 'prompt', 'incorrect'].includes(verdict)) fail('Unknown ruling.');
    if (this.s.buzz?.awaiting) this.applyTossupVerdict(verdict, this.s.buzz.awaiting.given);
    else if (this.s.bonus?.awaiting) this.applyBonusVerdict(verdict, this.s.bonus.awaiting.given);
    else fail('There is nothing to rule on.');
  }

  private applyTossupVerdict(verdict: Verdict, given: string, correctedTo?: string) {
    const t = this.s.tossup!;
    const b = this.s.buzz!;
    const marker = t.markers[t.markers.length - 1];
    marker.given = given;
    if (verdict === 'prompt' && b.prompts < TIMING.maxPrompts) {
      b.prompts++;
      b.awaiting = undefined;
      b.typing = '';
      b.deadline = Date.now() + TIMING.promptSeconds * 1000;
      marker.result = 'prompt';
      this.setTimer('answer', TIMING.promptSeconds * 1000, () => this.submitAnswer(b.playerId, this.s.buzz?.typing ?? '', true));
      return this.broadcast();
    }
    const correct = verdict === 'correct';
    const { points, kind } = scoreTossup(correct, b.wordIndex, t.words.length, t.powerIndex, this.s.settings);
    const p = this.player(b.playerId);
    this.s.rulings.push({
      id: rid(), type: 'tossup', num: t.num, playerId: b.playerId, playerName: p?.name ?? '?', teamId: b.teamId,
      category: t.q.category, given, correct, overridden: false, points, kind,
      wordIndex: b.wordIndex, totalWords: t.words.length, powerIndex: t.powerIndex,
      ...(correct && correctedTo ? { correctedTo } : {}),
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
    });
    if (this.s.review.length > 100) this.s.review.pop();
    t.bonusTeam = winnerTeam && this.s.settings.bonuses ? winnerTeam : null;
    this.s.phase = 'tossupEnd';
    this.broadcast();
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
    Object.assign(bn, { typing: '', prompts: 0, revealing: false, awaiting: undefined });
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
    const { verdict, correctedTo } = given ? checkAnswerDetailed(given, bn!.q.answers[bn!.current]) : { verdict: 'incorrect' as const, correctedTo: undefined };
    if (given && this.s.settings.readerRules && this.readerOnline()) {
      bn!.awaiting = { given, suggestion: verdict };
      bn!.deadline = null;
      return this.broadcast();
    }
    this.applyBonusVerdict(verdict, given, correctedTo);
  }

  private applyBonusVerdict(verdict: Verdict, given: string, correctedTo?: string) {
    const bn = this.s.bonus!;
    bn.awaiting = undefined;
    if (verdict === 'prompt' && bn.prompts < TIMING.maxPrompts) {
      bn.prompts++;
      bn.typing = '';
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
    if (bn.current >= bn.q.parts.length) { bn.done = true; bn.revealing = false; bn.current = bn.q.parts.length - 1; this.broadcast(); }
    else this.startBonusPart();
  }

  // ---------- chat, protests, overrides ----------

  chat(by: string, text: string, scope: 'all' | 'team') {
    const p = this.mustPlayer(by);
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
    const r = this.s.rulings.find((x) => x.id === rulingId) ?? fail('No such ruling.');
    if (this.s.protests.some((x) => x.rulingId === rulingId && !x.resolved)) fail('That ruling is already protested.');
    this.s.protests.push({ id: rid(), rulingId, byId: by, byName: p.name, note: String(note ?? '').slice(0, 200), resolved: false });
    this.system(`${p.name} protested the ruling on "${r!.given || '(no answer)'}" (${r!.type} ${r!.num}).`);
    this.broadcast();
  }

  resolveProtest(by: string, protestId: string, accept: boolean) {
    if (!this.isController(by)) fail('Only the host or reader resolves protests.');
    if (this.s.daily) fail('Not available in the daily challenge: every score is checked the same way for everyone.');
    const pr = this.s.protests.find((x) => x.id === protestId && !x.resolved) ?? fail('No open protest.');
    pr!.resolved = true;
    if (accept) this.flipRuling(pr!.rulingId);
    this.system(`Protest ${accept ? 'upheld; ruling reversed' : 'denied'}.`);
    this.broadcast();
  }

  override(by: string, rulingId: string) {
    if (!this.isController(by)) fail('Only the host or reader can override.');
    if (this.s.daily) fail('Not available in the daily challenge: every score is checked the same way for everyone.');
    this.flipRuling(rulingId);
    const r = this.s.rulings.find((x) => x.id === rulingId)!;
    this.system(`Ruling on "${r.given || '(no answer)'}" changed to ${r.correct ? 'correct' : 'incorrect'}.`);
    this.broadcast();
  }

  private flipRuling(rulingId: string) {
    const r = this.s.rulings.find((x) => x.id === rulingId) ?? fail('No such ruling.');
    r!.correct = !r!.correct;
    r!.overridden = !r!.overridden;
    if (r!.type === 'tossup') {
      const { points, kind } = scoreTossup(r!.correct, r!.wordIndex ?? 0, r!.totalWords ?? 0, r!.powerIndex ?? null, this.s.settings);
      r!.points = points;
      r!.kind = kind;
      const lists = [this.s.tossup?.num === r!.num ? this.s.tossup.markers : [], ...this.s.review.filter((x) => x.num === r!.num).map((x) => x.buzzes)];
      for (const list of new Set(lists)) for (const m of list) if (m.playerId === r!.playerId && m.given === r!.given) m.result = kind;
      // Reversing a ruling on the tossup that just ended also decides who gets its bonus.
      const t = this.s.tossup;
      if (t && t.num === r!.num && t.ended && this.s.phase === 'tossupEnd' && this.s.settings.bonuses) {
        if (r!.correct && !t.bonusTeam) t.bonusTeam = r!.teamId;
        else if (!r!.correct && t.bonusTeam === r!.teamId) t.bonusTeam = null;
      }
    } else {
      r!.points = r!.correct ? this.s.settings.bonusPartValue : 0;
    }
  }

  adjust(by: string, playerId: string, delta: number) {
    if (!this.isController(by)) fail('Only the host or reader can adjust scores.');
    if (this.s.daily) fail('Not available in the daily challenge: every score is checked the same way for everyone.');
    const teamId = this.teamOf(playerId) ?? fail('That player is not playing.');
    const d = clamp(delta, -50, 50, 0);
    if (!d) return;
    this.s.adjustments.push({ playerId, teamId: teamId!, delta: d, num: this.s.tossupNum });
    this.system(`${this.player(playerId)?.name} ${d > 0 ? '+' : ''}${d} (score adjustment).`);
    this.broadcast();
  }

  upload(by: string, raw: unknown) {
    if (!this.isController(by)) fail('Only the host or reader can upload a packet.');
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
    const players = this.s.players.map((p) => ({ id: p.id, name: p.name, online: p.online, teamId: this.teamOf(p.id), stats: stats[p.id], ...streaks[p.id], ...(p.bot ? { bot: p.bot } : {}), ...(p.username ? { username: p.username } : {}), ...(p.admin ? { admin: true } : {}) }));
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
    room.rearm();
    return room;
  }

  private rearm() {
    const s = this.s;
    const now = Date.now();
    if (s.phase === 'loading') {
      s.phase = s.tossup ? 'tossupEnd' : s.tossupNum ? 'tossupEnd' : 'lobby';
      if (s.tossup && !s.tossup.ended) s.tossup.ended = true;
    }
    if (!['reading', 'buzz', 'bonus'].includes(s.phase)) return;
    s.paused = true;
    s.pausedAt = now;
    const t = s.tossup;
    if (s.phase === 'reading' && t && !t.paused) {
      if (t.revealed >= t.words.length) { t.deadline = now + s.settings.deadSeconds * 1000; this.setTimer('dead', s.settings.deadSeconds * 1000, () => this.endTossup(null)); }
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
    return {
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
        revealed: t.words.slice(0, t.revealed).map((w) => (visible || t.ended ? w : '')),
        totalWords: t.words.length,
        words: reveal ? t.words : undefined,
        powerIndex: reveal ? t.powerIndex : undefined,
        answerHtml: reveal ? safeAnswerHtml(t.q.answer) : undefined,
        buzzes: t.markers,
        textVisible: visible,
        paused: t.paused,
        deadline: t.deadline,
        lockedTeamIds: [...t.locked],
        bonusTeamId: t.ended ? t.bonusTeam : null,
      },
      buzz: s.buzz && {
        playerId: s.buzz.playerId, playerName: this.player(s.buzz.playerId)?.name ?? '?', wordIndex: s.buzz.wordIndex,
        deadline: s.buzz.deadline, typing: s.buzz.typing, prompts: s.buzz.prompts, awaitingRuling: s.buzz.awaiting,
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
        readerParts: isReader ? bn.q.parts.map((text, i) => ({ text, answerHtml: safeAnswerHtml(bn.q.answers[i]) })) : undefined,
      },
      players: shared.players,
      teams: shared.teams,
      rulings: s.rulings.slice(-60),
      protests: s.protests.filter((p) => !p.resolved),
      review: s.review,
      tossupsRead: s.heard.length,
      uploadedCount: s.upload ? { tossups: s.upload.tossups.length, bonuses: s.upload.bonuses.length } : null,
      message: s.message,
      paused: s.paused,
      history: shared.history,
      highlights: shared.highlights,
      daily: s.daily ? { day: s.daily.day, number: s.daily.number, total: s.daily.total, done: s.daily.done } : undefined,
      ...(isReader ? {
        upcoming: this.upcoming.map((q) => ({
          id: q.id, category: q.category, subcategory: q.subcategory, difficulty: q.difficulty, setName: q.setName, year: q.year,
          text: stripHtml(q.question).replace(/\s*\(\*\)\s*/, ' (*) '), answerHtml: safeAnswerHtml(q.answer),
        })),
        upcomingLoading: this.fillingQueue,
      } : {}),
    };
  }

  chatHistory(viewer: string) {
    void viewer;
    return this.s.chat;
  }
}
