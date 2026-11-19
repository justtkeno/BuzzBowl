// Computer players the host can add to a room. Bots join like normal players and act through the
// same Room methods people use (buzz, typing, submitAnswer, bonusSubmit, chat). The server already
// knows each answer, so a bot's skill level decides how early it buzzes and how often it is right.

import { BOT_SKILLS, type BotSkill } from '../../shared/types';
import { checkAnswer } from '../game/answerCheck';
import { parseAnswerLine } from '../game/answerLine';
import { ActionError, type Room } from './room';

interface Profile {
  /** Chance of knowing a tossup. */
  knows: number;
  /** When it knows: fraction of the question read before buzzing. */
  depth: [number, number];
  /** When it doesn't know: chance of guessing early anyway (a likely neg). */
  reckless: number;
  /** Chance of getting a bonus part. */
  bonus: number;
  /** Seconds before it starts typing an answer. */
  think: [number, number];
  /** Chance of a typo in a correct answer (the checker usually forgives it). */
  typo: number;
}

export const PROFILES: Record<BotSkill, Profile> = {
  easy: { knows: 0.35, depth: [0.8, 1.0], reckless: 0.08, bonus: 0.35, think: [1.6, 2.6], typo: 0.25 },
  medium: { knows: 0.55, depth: [0.6, 1.0], reckless: 0.12, bonus: 0.55, think: [1.2, 2.0], typo: 0.15 },
  hard: { knows: 0.75, depth: [0.4, 0.95], reckless: 0.12, bonus: 0.72, think: [0.9, 1.6], typo: 0.1 },
  expert: { knows: 0.9, depth: [0.25, 0.85], reckless: 0.06, bonus: 0.88, think: [0.6, 1.2], typo: 0.05 },
};

export const MAX_BOTS = 8;
const NAMES = ['Ada', 'Ben', 'Cleo', 'Dev', 'Eli', 'Fay', 'Gus', 'Hana', 'Ivo', 'Juno', 'Kai', 'Lena'];
const DECOYS = [
  'Napoleon', 'Shakespeare', 'Mozart', 'photosynthesis', 'Egypt', 'Charles Darwin', 'the Nile', 'Zeus', 'Plato', 'Rome',
  'Abraham Lincoln', 'electron', 'Picasso', 'Buddhism', 'France', 'Isaac Newton', 'oxygen', 'Mars', 'Beethoven', 'Athena',
  'World War I', 'Tokyo', 'carbon', 'Jane Austen', 'Aristotle', 'the Amazon', 'Queen Victoria', 'gravity', 'Homer', 'Iron',
];

/** The bots' dice. Tests swap `botRandom.next` to make bots predictable. */
export const botRandom = { next: () => Math.random() };
const rand = (a: number, b: number) => a + botRandom.next() * (b - a);
const chance = (p: number) => botRandom.next() < p;
const pick = <T,>(xs: T[]) => xs[Math.floor(botRandom.next() * xs.length)];
const isSkill = (x: unknown): x is BotSkill => typeof x === 'string' && x in BOT_SKILLS;

/** The answer a player would naturally say: "mitochondria", "Leo Tolstoy". */
function sayAnswer(answerLine: string): string {
  const alt = parseAnswerLine(answerLine).accept[0];
  return alt?.display ?? alt?.full ?? '';
}
/** A wrong answer that the checker really does reject for this question. */
function wrongAnswer(answerLine: string): string {
  for (let i = 0; i < 8; i++) {
    const d = pick(DECOYS);
    if (checkAnswer(d, answerLine) === 'incorrect') return d;
  }
  return 'pass';
}
function typo(answer: string): string {
  const words = answer.split(' ');
  const i = words.reduce((best, w, j) => (w.length > words[best].length ? j : best), 0);
  const w = words[i];
  if (w.length < 6) return answer;
  const k = 1 + Math.floor(botRandom.next() * (w.length - 3));
  words[i] = w.slice(0, k) + w[k + 1] + w[k] + w.slice(k + 2);
  return words.join(' ');
}

interface TossupPlan { num: number; target: number; right: boolean; answer: string; correct: string; buzzed: boolean }

class BotBrain {
  plan: TossupPlan | null = null;
  handled = new Set<string>();
  constructor(readonly id: string) {}
}

/** Runs every bot in one room. `tick()` is called a few times a second. */
export class RoomBots {
  private brains = new Map<string, BotBrain>();
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private room: Room) {}

  private get s() { return this.room.s; }
  private bots() { return this.s.players.filter((p) => p.bot); }
  private brain(id: string) {
    let b = this.brains.get(id);
    if (!b) this.brains.set(id, (b = new BotBrain(id)));
    return b;
  }
  private isController(by: string) { return by === this.s.hostId || by === this.s.readerId; }
  private later(ms: number, fn: () => void) {
    const t = setTimeout(() => { this.timers.delete(t); try { fn(); } catch (e) { if (!(e instanceof ActionError)) console.error(e); } }, ms);
    this.timers.add(t);
  }

  // ---------- host actions ----------

  add(by: string, skill: unknown) {
    if (!this.isController(by)) throw new ActionError('Only the host can add bots.');
    if (this.s.daily) throw new ActionError('The daily challenge is played solo.');
    const level = isSkill(skill) ? skill : 'medium';
    if (this.bots().length >= MAX_BOTS) throw new ActionError(`A room can have up to ${MAX_BOTS} bots.`);
    const taken = new Set(this.s.players.map((p) => p.name.toLowerCase()));
    const name = NAMES.find((n) => !taken.has(n.toLowerCase())) ?? `Bot ${this.bots().length + 1}`;
    const { playerId } = this.room.join(name);
    const p = this.s.players.find((x) => x.id === playerId)!;
    p.bot = level;
    this.room.broadcast();
    return { playerId };
  }

  setSkill(by: string, botId: string, skill: unknown) {
    if (!this.isController(by)) throw new ActionError('Only the host can change bots.');
    const p = this.s.players.find((x) => x.id === botId && x.bot);
    if (!p) throw new ActionError('No such bot.');
    if (!isSkill(skill)) throw new ActionError('Unknown skill level.');
    p.bot = skill;
    this.brain(botId).plan = null;
    this.room.broadcast();
  }

  remove(by: string, botId: string) {
    if (!this.isController(by)) throw new ActionError('Only the host can remove bots.');
    const p = this.s.players.find((x) => x.id === botId && x.bot);
    if (!p) throw new ActionError('No such bot.');
    if (this.s.buzz?.playerId === botId) throw new ActionError(`${p.name} is answering. Remove it after this question.`);
    this.s.players = this.s.players.filter((x) => x.id !== botId);
    for (const t of this.s.teams) t.playerIds = t.playerIds.filter((id) => id !== botId);
    this.brains.delete(botId);
    (this.room as any).system?.(`${p.name} (bot) was removed.`);
    this.room.broadcast();
  }

  dispose() { for (const t of this.timers) clearTimeout(t); this.timers.clear(); }

  // ---------- playing ----------

  tick() {
    const bots = this.bots();
    if (!bots.length) return;
    const humansHere = this.s.players.some((p) => !p.bot && p.online);
    for (const b of bots) b.online = humansHere; // restored rooms come back offline; bots follow the people
    if (!humansHere) return;
    const host = this.s.players.find((p) => p.id === this.s.hostId);
    if (host?.bot) this.s.hostId = this.s.players.find((p) => !p.bot && p.online)?.id ?? this.s.hostId;

    if (this.s.phase === 'reading' || this.s.phase === 'buzz') this.tossupTick(bots);
    if (this.s.phase === 'bonus') this.bonusTick(bots);
  }

  private tossupTick(bots: { id: string; bot?: BotSkill }[]) {
    const t: any = this.s.tossup;
    if (!t || t.ended) return;
    const total: number = t.words.length;
    for (const p of bots) {
      const br = this.brain(p.id);
      const prof = PROFILES[p.bot!];
      if (br.plan?.num !== t.num) {
        const correct = sayAnswer(t.q.answer);
        let target: number;
        let right = false;
        if (chance(prof.knows)) { right = true; target = Math.round(rand(...prof.depth) * total); }
        else if (chance(prof.reckless)) target = Math.round(rand(0.3, 0.75) * total);
        else target = chance(0.3) ? total : Infinity; // a last-second guess, or sit it out
        br.plan = {
          num: t.num, target: Math.max(4, target), right, correct, buzzed: false,
          answer: right ? (chance(prof.typo) ? typo(correct) : correct) : wrongAnswer(t.q.answer),
        };
      }
      const plan = br.plan!;
      if (this.s.phase === 'reading' && !plan.buzzed && plan.target !== Infinity && t.revealed >= Math.min(plan.target, total)) {
        plan.buzzed = true;
        try { this.room.buzz(p.id, t.revealed); } catch { /* locked out, or someone beat us */ }
      }
    }
    // A bot that won the buzz answers (and answers a prompt properly).
    const b: any = this.s.buzz;
    const bot: { id: string; bot?: BotSkill } | undefined = b ? bots.find((x) => x.id === b.playerId) : undefined;
    if (!bot || b.awaiting) return;
    const br = this.brain(bot.id);
    const key = `t${t.num}-${b.prompts}`;
    if (br.handled.has(key) || !br.plan) return;
    br.handled.add(key);
    const prof = PROFILES[bot.bot!];
    const text = b.prompts ? (br.plan.right ? br.plan.correct : br.plan.answer) : br.plan.answer;
    this.typeThen(bot.id, text, rand(...prof.think) * 1000, () => this.room.submitAnswer(bot.id, text));
  }

  private bonusTick(bots: { id: string; bot?: BotSkill; teamId: string | null }[]) {
    const bn: any = this.s.bonus;
    if (!bn || bn.revealing || bn.done || bn.awaiting) return;
    const team = this.s.teams.find((t) => t.id === bn.teamId);
    const captainId = this.s.settings.mode === 'ffa'
      ? bn.teamId
      : team?.playerIds.find((id) => this.s.players.find((p) => p.id === id)?.online) ?? team?.playerIds[0];
    const key = `b${bn.num}-${bn.current}-${bn.prompts}`;
    const answerLine: string = bn.q.answers[bn.current];
    const correct = sayAnswer(answerLine);
    for (const p of bots) {
      const onTeam = this.s.settings.mode === 'ffa' ? p.id === bn.teamId : p.teamId === bn.teamId;
      if (!onTeam) continue;
      const br = this.brain(p.id);
      if (br.handled.has(key)) continue;
      br.handled.add(key);
      const prof = PROFILES[p.bot!];
      const knows = chance(prof.bonus);
      const guess = knows ? correct : wrongAnswer(answerLine);
      if (p.id === captainId) {
        const wait = bn.prompts ? rand(0.6, 1.2) : rand(4, 8);
        this.typeThen(p.id, guess, wait * 1000, () => this.room.bonusSubmit(p.id, guess));
      } else if (this.s.settings.mode === 'teams' && !bn.prompts && chance(0.6)) {
        // Help a teammate captain (human or bot) through team chat.
        const line = pick(knows ? ['I think it’s {a}', 'pretty sure {a}', 'go with {a}'] : ['{a}?', 'maybe {a}', 'no idea, {a}?']);
        this.later(rand(1500, 4000), () => this.room.chat(p.id, line.replace('{a}', guess), 'team'));
      }
    }
  }

  /** Wait, then type `text` a letter at a time so people can watch, then run `done`. */
  private typeThen(id: string, text: string, waitMs: number, done: () => void) {
    let i = 0;
    const step = () => {
      if (i < text.length) {
        this.room.typing(id, text.slice(0, ++i));
        this.later(rand(45, 110), step);
      } else this.later(200, done);
    };
    this.later(waitMs, step);
  }
}

const registry = new WeakMap<Room, RoomBots>();
export function botsFor(room: Room): RoomBots {
  let b = registry.get(room);
  if (!b) registry.set(room, (b = new RoomBots(room)));
  return b;
}
