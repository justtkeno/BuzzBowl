import {
  DEFAULT_SETTINGS,
  type BuzzMarker, type ChatMessage, type Phase, type Protest, type PublicState, type ReviewItem,
  type Ruling, type Settings, type Verdict,
} from '../../shared/types';
import { checkAnswer } from '../game/answerCheck';
import { computePlayerStats, computeTeamTotals, parseTossupText, scoreTossup, type Adjustment, type HeardEntry } from '../game/scoring';
import { safeAnswerHtml } from '../game/text';
import { LocalProvider, parseUpload, QBReaderProvider } from '../questions/providers';
import { SAMPLE_BONUSES, SAMPLE_TOSSUPS } from '../questions/sample';
import type { Bonus, QuestionProvider, Tossup } from '../questions/types';

/** How the room talks to the outside world (Socket.IO in production, a fake in tests). */
export interface RoomIO {
  /** Send a per-viewer payload to every connected player of the room. */
  emitEach(event: string, payload: (viewerId: string) => unknown): void;
  /** Send the same payload to specific players. */
  emitTo(playerIds: string[], event: string, payload: unknown): void;
}

export class ActionError extends Error {}
const fail = (msg: string): never => { throw new ActionError(msg); };

export const TIMING = {
  /** After the first buzz arrives, wait this long for earlier (laggier) buzzes before awarding it. */
  graceMs: 120,
  /** A client may claim it buzzed before a word only if that word went out at most this long ago. */
  maxLagMs: 1200,
  promptSeconds: 5,
  partRevealMs: 3000,
  startDelayMs: 900,
  maxPrompts: 2,
  teamSize: 4,
};

interface Player { id: string; token: string; name: string; online: boolean; teamId: string | null }
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
  teamId: string;
  q: Bonus;
  current: number;
  results: { given: string; correct: boolean }[];
  deadline: number | null;
  typing: string;
  prompts: number;
  revealing: boolean;
  done: boolean;
  awaiting?: { given: string; suggestion: Verdict };
}

/** Everything about a room. Plain data except the Sets, so it can move to Redis later. */
export interface RoomState {
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
}

const rid = (n = 10) => Array.from({ length: n }, () => 'abcdefghijkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 32)]).join('');
const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

const sampleProvider = new LocalProvider(SAMPLE_TOSSUPS, SAMPLE_BONUSES);

export interface RoomDeps {
  qbreader?: QuestionProvider;
}

export class Room {
  s: RoomState;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pending: { playerId: string; teamId: string; count: number; at: number }[] = [];
  private loadGen = 0;
  private qbreader: QuestionProvider;
  private uploadProvider: QuestionProvider | null = null;

  constructor(code: string, private io: RoomIO, deps: RoomDeps = {}) {
    this.qbreader = deps.qbreader ?? new QBReaderProvider();
    this.s = {
      code, hostId: null, readerId: null, settings: structuredClone(DEFAULT_SETTINGS), phase: 'lobby',
      players: [], teams: [], tossup: null, buzz: null, bonus: null, rulings: [], adjustments: [], heard: [],
      protests: [], review: [], chat: [], seenTossups: new Set(), seenBonuses: new Set(), upload: null,
      tossupNum: 0, bonusNum: 0, message: null, lastActive: Date.now(),
    };
  }

  // ---------- helpers ----------

  private player(id: string) { return this.s.players.find((p) => p.id === id); }
  private mustPlayer(id: string) { return this.player(id) ?? fail('You are not in this room.'); }
  private isController(id: string) { return id === this.s.hostId || id === this.s.readerId; }
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
    this.timers.set(name, setTimeout(() => { this.timers.delete(name); fn(); }, Math.max(0, ms)));
  }
  private clearTimer(...names: string[]) {
    for (const n of names) { const t = this.timers.get(n); if (t) clearTimeout(t); this.timers.delete(n); }
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

  join(name: string, token?: string): { playerId: string; token: string } {
    const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
    const existing = token ? this.s.players.find((p) => p.token === token) : undefined;
    if (existing) {
      existing.online = true;
      if (clean) existing.name = clean;
      if (!this.s.hostId || !this.player(this.s.hostId)?.online) this.s.hostId = this.s.hostId && this.player(this.s.hostId)?.online ? this.s.hostId : existing.id;
      this.broadcast();
      return { playerId: existing.id, token: existing.token };
    }
    if (!clean) fail('Pick a display name.');
    if (this.s.players.length >= 60) fail('This room is full.');
    const p: Player = { id: rid(), token: rid(24), name: clean, online: true, teamId: null };
    this.s.players.push(p);
    if (this.s.settings.mode === 'teams') this.autoAssign(p);
    if (!this.s.hostId || !this.player(this.s.hostId)?.online) this.s.hostId = p.id;
    this.system(`${p.name} joined.`);
    this.broadcast();
    return { playerId: p.id, token: p.token };
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
    if (this.s.hostId === playerId) this.s.hostId = this.s.players.find((x) => x.online)?.id ?? playerId;
    if (this.s.readerId === playerId) {
      this.s.readerId = null;
      this.system(`${p.name} left the reader's seat.`);
      if (this.s.buzz?.awaiting) this.applyTossupVerdict(this.s.buzz.awaiting.suggestion, this.s.buzz.awaiting.given);
      else if (this.s.bonus?.awaiting) this.applyBonusVerdict(this.s.bonus.awaiting.suggestion, this.s.bonus.awaiting.given);
    }
    // If everyone left during a buzz, let the timers resolve things; nothing else to do here.
    this.broadcast();
  }

  connectedCount() { return this.s.players.filter((p) => p.online).length; }

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

  private midGame() { return ['loading', 'reading', 'buzz', 'bonus'].includes(this.s.phase); }

  updateSettings(by: string, patch: Partial<Settings>) {
    if (!this.isController(by)) fail('Only the host or reader can change settings.');
    const s = this.s.settings;
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
    this.broadcast();
  }

  createTeam(by: string, name: string) {
    if (by !== this.s.hostId) fail('Only the host can add teams.');
    if (this.s.teams.length >= 8) fail('That is enough teams.');
    this.s.teams.push({ id: rid(), name: String(name || `Team ${String.fromCharCode(65 + this.s.teams.length)}`).slice(0, 24), playerIds: [] });
    this.broadcast();
  }

  renameTeam(by: string, teamId: string, name: string) {
    const team = this.s.teams.find((t) => t.id === teamId) ?? fail('No such team.');
    if (by !== this.s.hostId && !team.playerIds.includes(by)) fail('Only team members or the host can rename a team.');
    const clean = String(name ?? '').trim().slice(0, 24);
    if (clean) team.name = clean;
    this.broadcast();
  }

  removeTeam(by: string, teamId: string) {
    if (by !== this.s.hostId) fail('Only the host can remove teams.');
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

  makeCaptain(by: string, target?: string) {
    const id = target ?? by;
    if (target && target !== by && by !== this.s.hostId) fail('Only the host can pick another captain.');
    const team = this.s.teams.find((t) => t.playerIds.includes(id)) ?? fail('Not on a team.');
    team.playerIds = [id, ...team.playerIds.filter((x) => x !== id)];
    this.broadcast();
  }

  /** Take (target = self) or assign (host) the reader seat; null target frees it. */
  setReader(by: string, target: string | null) {
    if (this.midGame()) fail('Change the reader between questions.');
    if (target === null) {
      if (by !== this.s.readerId && by !== this.s.hostId) fail('Only the reader or host can free the seat.');
      const old = this.s.readerId ? this.player(this.s.readerId) : undefined;
      this.s.readerId = null;
      if (old && this.s.settings.mode === 'teams') this.autoAssign(old);
      if (old) this.system(`${old.name} is no longer reading.`);
    } else {
      if (target !== by && by !== this.s.hostId) fail('Only the host can assign someone else.');
      if (this.readerOnline() && this.s.readerId !== target) fail(`${this.player(this.s.readerId!)!.name} is already reading.`);
      const p = this.mustPlayer(target);
      const old = this.s.readerId ? this.player(this.s.readerId) : undefined;
      if (old && old !== p && this.s.settings.mode === 'teams') this.autoAssign(old);
      this.removeFromTeam(p);
      this.s.readerId = p.id;
      this.system(`${p.name} is now the reader.`);
    }
    this.broadcast();
  }

  // ---------- game flow ----------

  start(by: string) {
    if (!this.isController(by)) fail('Only the host or reader can start.');
    if (this.s.phase === 'gameOver') this.resetScores();
    else if (this.s.phase !== 'lobby') fail('The game is already running.');
    this.s.message = null;
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
    this.s.phase = 'gameOver';
    this.system('Game over.');
    this.broadcast();
  }

  next(by: string) {
    if (!this.canDirect(by)) fail('The reader decides when to move on.');
    const { phase, tossup, bonus } = this.s;
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
    let q: Tossup | null = null;
    try {
      q = await this.provider().nextTossup(this.s.settings.filters, this.s.seenTossups);
    } catch (e: any) {
      if (gen !== this.loadGen) return;
      this.s.message = `${e?.message ?? e}. Try again, or switch the question source to the sample packet.`;
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
      this.io.emitTo(this.s.players.filter((p) => p.online && p.id !== by).map((p) => p.id), 'typing', { kind: 'tossup', text: clean });
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
    const given = String(text ?? '').trim().slice(0, 200);
    this.clearTimer('answer');
    const verdict = given ? checkAnswer(given, this.s.tossup!.q.answer) : 'incorrect';
    if (given && this.s.settings.readerRules && this.readerOnline()) {
      b!.awaiting = { given, suggestion: verdict };
      b!.deadline = null;
      return this.broadcast();
    }
    this.applyTossupVerdict(verdict, given);
  }

  /** The reader's ruling on the current tossup or bonus answer. */
  rule(by: string, verdict: Verdict) {
    if (by !== this.s.readerId && by !== this.s.hostId) fail('Only the reader rules on answers.');
    if (!['correct', 'prompt', 'incorrect'].includes(verdict)) fail('Unknown ruling.');
    if (this.s.buzz?.awaiting) this.applyTossupVerdict(verdict, this.s.buzz.awaiting.given);
    else if (this.s.bonus?.awaiting) this.applyBonusVerdict(verdict, this.s.bonus.awaiting.given);
    else fail('There is nothing to rule on.');
  }

  private applyTossupVerdict(verdict: Verdict, given: string) {
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
    });
    marker.result = kind;
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
      num: ++this.s.bonusNum, teamId, q, current: 0, results: [], deadline: null, typing: '', prompts: 0, revealing: false, done: false,
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
    this.clearTimer('bonus');
    const given = String(text ?? '').trim().slice(0, 200);
    const verdict = given ? checkAnswer(given, bn!.q.answers[bn!.current]) : 'incorrect';
    if (given && this.s.settings.readerRules && this.readerOnline()) {
      bn!.awaiting = { given, suggestion: verdict };
      bn!.deadline = null;
      return this.broadcast();
    }
    this.applyBonusVerdict(verdict, given);
  }

  private applyBonusVerdict(verdict: Verdict, given: string) {
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
      category: bn.q.category, given, correct, overridden: false, points: correct ? this.s.settings.bonusPartValue : 0, partIndex: bn.current,
    });
    bn.results[bn.current] = { given, correct };
    bn.revealing = true;
    bn.deadline = null;
    this.setTimer('bonusReveal', TIMING.partRevealMs, () => {
      bn.current++;
      if (bn.current >= bn.q.parts.length) { bn.done = true; bn.revealing = false; bn.current = bn.q.parts.length - 1; this.broadcast(); }
      else this.startBonusPart();
    });
    this.broadcast();
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
    const pr = this.s.protests.find((x) => x.id === protestId && !x.resolved) ?? fail('No open protest.');
    pr!.resolved = true;
    if (accept) this.flipRuling(pr!.rulingId);
    this.system(`Protest ${accept ? 'upheld; ruling reversed' : 'denied'}.`);
    this.broadcast();
  }

  override(by: string, rulingId: string) {
    if (!this.isController(by)) fail('Only the host or reader can override.');
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
    const teamId = this.teamOf(playerId) ?? fail('That player is not playing.');
    const d = clamp(delta, -50, 50, 0);
    if (!d) return;
    this.s.adjustments.push({ playerId, teamId: teamId!, delta: d });
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
    const players = this.s.players.map((p) => ({ id: p.id, name: p.name, online: p.online, teamId: this.teamOf(p.id), stats: stats[p.id] }));
    // FFA bonus totals live on each player's "team" (themselves).
    const ffaTeams = this.s.settings.mode === 'ffa'
      ? this.s.players.map((p) => ({ id: p.id, name: p.name, playerIds: [p.id], captainId: p.id, ...computeTeamTotals(p.id, this.s.rulings, this.s.adjustments) }))
      : [];
    return { players, teams: teams.length ? teams : ffaTeams };
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
    };
  }

  chatHistory(viewer: string) {
    void viewer;
    return this.s.chat;
  }
}
