import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionError, Room, TIMING, bountyRandom, type RoomIO } from '../src/server/rooms/room';
import { botRandom, botsFor } from '../src/server/rooms/bots';
import { parseAnswerLine } from '../src/server/game/answerLine';
import { CATALOG_BONUSES, CATALOG_TOSSUPS } from '../src/server/questions/catalog';
import type { QuestionProvider } from '../src/server/questions/types';
import type { Settings } from '../src/shared/types';

/**
 * Plays short games across every combination of format, voting, reader seat, question source, bonuses,
 * bounty, powers/negs, game length, topic filters and bots, and checks the rules hold in all of them.
 */

const io: RoomIO = { emitEach: () => {}, emitTo: () => {} };

/** Stands in for QBReader with real built-in questions, honoring the category filter. */
function fakeQBReader(): QuestionProvider {
  return {
    nextTossup: async (f, seen) => CATALOG_TOSSUPS.find((q) => !seen.has(q.id) && (!f.categories.length || f.categories.includes(q.category))) ?? null,
    nextBonus: async (_f, seen) => CATALOG_BONUSES.find((b) => !seen.has(b.id)) ?? null,
  };
}

const PACKET = {
  tossups: CATALOG_TOSSUPS.slice(0, 12).map((q) => ({ question: q.question, answer: q.answer, category: q.category })),
  bonuses: CATALOG_BONUSES.slice(0, 6).map((b) => ({ leadin: b.leadin, parts: b.parts, answers: b.answers, category: b.category })),
};

const answerFor = (line: string) => { const a = parseAnswerLine(line).accept[0]; return a?.display ?? a?.full ?? 'x'; };

interface Combo {
  mode: 'ffa' | 'teams'; vote: boolean; reader: boolean; source: Settings['source']; bonuses: boolean; bounty: boolean;
  scoring: boolean; length: number; filter: 'none' | 'categories' | 'topic'; bots: boolean;
}

const combos: Combo[] = [];
for (const mode of ['ffa', 'teams'] as const)
  for (const vote of [false, true])
    for (const reader of [false, true])
      for (const source of ['qbreader', 'sample', 'lightning', 'upload'] as const)
        for (const bonuses of [false, true])
          for (const bounty of [false, true])
            for (const scoring of [true, false])
              for (const length of [0, 3])
                for (const filter of ['none', 'categories', 'topic'] as const)
                  for (const bots of [false, true])
                    combos.push({ mode, vote, reader, source, bonuses, bounty, scoring, length, filter, bots });

let seed = 1;
const seen: Record<string, number> = {};
const saw = (k: string) => { seen[k] = (seen[k] ?? 0) + 1; };
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

async function play(c: Combo): Promise<string[]> {
  const problems: string[] = [];
  const room = new Room('MIX1', io, { qbreader: fakeQBReader() });
  const host = room.join('Host').playerId;
  const ann = room.join('Ann').playerId;
  const bob = room.join('Bob').playerId;
  const cy = room.join('Cy').playerId;
  const players = [host, ann, bob, cy];
  if (c.mode === 'teams') room.updateSettings(host, { mode: 'teams' });
  if (c.bots) botsFor(room).add(host, 'medium');
  if (c.source === 'upload') room.upload(host, PACKET);
  room.updateSettings(host, {
    wpm: 800, topicVote: c.vote, bonuses: c.bonuses, bounty: c.bounty, powers: c.scoring, negs: c.scoring,
    gameLength: c.length, source: c.source,
    filters: { categories: c.filter === 'categories' ? ['History', 'Science'] : [], subcategories: [], difficulties: [], topics: c.filter === 'topic' ? ['space', 'memes'] : [] },
  });
  let reader: string | null = null;
  if (c.reader) { room.setReader(cy, cy); reader = cy; }
  const directors = reader ? [reader, host] : players;
  const s = room.s;
  const call = (what: string, fn: () => void) => {
    try { fn(); } catch (e) { if (!(e instanceof ActionError)) problems.push(`${what} threw ${(e as Error).message}`); }
  };
  call('start', () => room.start(reader ?? host));
  await vi.advanceTimersByTimeAsync(0);
  // Filters that match nothing in the chosen source: the room says so and stays in the lobby. That's correct.
  if (s.phase === 'lobby' && s.message) { room.dispose(); return ['SKIP: ' + s.message]; }

  let steps = 0;
  let lastChange = 0;
  let lastKey = '';
  while (s.phase !== 'gameOver' && steps < 900) {
    steps++;
    botsFor(room).tick();
    const t = s.tossup;
    // A seated reader pauses after a miss and resumes when ready (that's the reader's job).
    if (s.phase === 'reading' && t && t.paused && reader) call('reader resumes', () => room.setPaused(reader!, false));
    else if (s.phase === 'reading' && t && !t.ended && t.revealed > 0 && rand() < 0.08) {
      const who = players.filter((p) => p !== reader)[Math.floor(rand() * 3)];
      call('buzz', () => room.buzz(who, t.revealed));
    } else if (s.phase === 'buzz' && s.buzz) {
      if (s.buzz.awaiting) { saw('reader rulings'); call('rule', () => room.rule(reader!, rand() < 0.5 ? 'correct' : 'incorrect')); }
      else if (!s.buzz.typing) call('answer', () => room.submitAnswer(s.buzz!.playerId, rand() < 0.6 ? answerFor(t!.q.answer) : 'zzz wrong'));
    } else if (s.phase === 'bonus' && s.bonus && !s.bonus.done && !s.bonus.revealing) {
      const bn = s.bonus;
      if (bn.awaiting) call('rule bonus', () => room.rule(reader!, 'correct'));
      else call('bonus answer', () => room.bonusSubmit((room as any).captainOf(bn.teamId), rand() < 0.5 ? answerFor(bn.q.answers[bn.current]) : 'nope'));
    } else if (s.phase === 'tossupEnd' || (s.phase === 'bonus' && s.bonus?.done)) {
      if (s.vote) saw(`vote steps (${c.mode})`);
      if (s.vote && rand() < 0.7) call('vote', () => room.castVote(players.filter((p) => p !== reader)[Math.floor(rand() * 3)], s.vote!.options[Math.floor(rand() * s.vote!.options.length)]));
      else call('next', () => room.next(directors[Math.floor(rand() * directors.length)]));
    }
    await vi.advanceTimersByTimeAsync(120);

    // ---- the rules, checked after every step ----
    const key = `${s.phase}:${s.tossupNum}:${s.tossup?.revealed}:${s.bonus?.current}:${s.vote ? 1 : 0}`;
    if (key !== lastKey) { lastKey = key; lastChange = steps; }
    if (steps - lastChange > 120 && s.phase !== 'tossupEnd' && !(s.phase === 'bonus' && s.bonus?.done)) problems.push(`stuck in ${s.phase} (${key})`);
    if (s.vote && (!c.vote || reader)) problems.push('a topic vote opened when it should not');
    if (s.bonus && (!c.bonuses || c.source === 'lightning')) problems.push('a bonus was played when it should not');
    if (c.length && s.tossupNum > c.length) problems.push(`tossup ${s.tossupNum} played in a ${c.length}-tossup game`);
    if (!c.bounty && s.tossup?.bounty) problems.push('bounty tossup with bounty off');
    for (const viewer of players.filter((p) => p !== reader)) {
      const snap = room.snapshot(viewer);
      const st = snap.tossup;
      if (st && s.tossup && !s.tossup.ended) {
        if (st.answerHtml || st.words) problems.push('a player saw the answer or the full text before the tossup ended');
        if (st.revealed.length > s.tossup.revealed) problems.push('a player saw words before they were read');
      }
    }
    if (problems.length) break;
  }
  if (!problems.length && s.phase !== 'gameOver') {
    if (c.length && s.tossupNum >= 1 && steps >= 900) problems.push(`a ${c.length}-tossup game never finished (at tossup ${s.tossupNum}, ${s.phase})`);
  }
  if (c.length && s.phase === 'gameOver' && s.tossupNum !== c.length && !s.message) problems.push(`game ended after ${s.tossupNum} of ${c.length} tossups`);

  if (s.phase === 'gameOver' && c.length) saw('games finished by length');
  if (s.review.some((r) => r.bounty)) saw('games with a bounty');
  if (s.bonusNum) saw(`games with bonuses (${c.mode}${reader ? ', reader' : ''})`);
  if (c.bots && s.rulings.some((r) => s.players.find((p) => p.id === r.playerId)?.bot)) saw('games where a bot answered');
  for (const r of s.rulings) if (r.type === 'tossup' && r.kind) saw(`tossup ${r.kind}${r.bounty ? ' (bounty)' : ''}`);
  if (c.source === 'lightning' && s.tossupNum) saw('lightning games played');
  // ---- scoring rules over the whole game ----
  const byTossup = new Map<number, typeof s.rulings>();
  for (const r of s.rulings.filter((x) => x.type === 'tossup')) byTossup.set(r.num, [...(byTossup.get(r.num) ?? []), r]);
  for (const [num, rs] of byTossup) {
    if (rs.filter((r) => r.points > 0).length > 1) problems.push(`tossup ${num}: more than one answer scored`);
    for (const r of rs) {
      if (!c.scoring && r.kind === 'power') problems.push('a power with powers off');
      if (!c.scoring && r.points < 0) problems.push('a neg with negs off');
      if (r.points > 0 && !r.bounty && ![s.settings.powerValue, s.settings.tenValue].includes(r.points)) problems.push(`odd tossup points ${r.points}`);
      if (r.points > 0 && r.bounty && ![s.settings.powerValue * 2, s.settings.tenValue * 2].includes(r.points)) problems.push(`odd bounty points ${r.points}`);
    }
  }
  room.dispose();
  botsFor(room).tick();
  return problems;
}

beforeEach(() => { vi.useFakeTimers(); seed = 1; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

// The full matrix takes about a minute; normal runs play an even spread of it. FULL_COMBOS=1 npx vitest run tests/combos.test.ts
const FULL = !!process.env.FULL_COMBOS;
const picked = FULL ? combos : combos.filter((_, i) => i % 15 === 0);

describe('every combination of modes and settings', () => {
  it(`plays ${picked.length} of ${combos.length} combinations without breaking a rule`, async () => {
    vi.spyOn(bountyRandom, 'next').mockImplementation(rand);
    vi.spyOn(botRandom, 'next').mockImplementation(rand);
    const failures: string[] = [];
    let skipped = 0;
    for (const c of picked) {
      const problems = await play(c);
      if (problems[0]?.startsWith('SKIP')) { skipped++; continue; }
      if (problems.length) failures.push(`${JSON.stringify(c)}\n    ${[...new Set(problems)].slice(0, 3).join('\n    ')}`);
    }
    console.log(Object.entries(seen).sort().map(([k, v]) => `  ${k}: ${v}`).join('\n'));
    console.log(`${picked.length - skipped} combinations played, ${skipped} correctly had nothing to play (filters vs. a one-category packet)`);
    expect(failures.slice(0, 15).join('\n'), `${failures.length} of ${picked.length} combinations broke a rule`).toBe('');
  }, 600_000);
});
