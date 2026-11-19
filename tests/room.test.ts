import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room, TIMING, type RoomIO } from '../src/server/rooms/room';
import type { QuestionProvider, Tossup, Bonus } from '../src/server/questions/types';

// 10 words, power mark after word 4.
const TOSSUP: Tossup = {
  id: 't1', category: 'Science', subcategory: 'Biology',
  question: 'w1 w2 w3 w4 (*) w5 w6 w7 w8 w9 w10',
  answer: '<b><u>mitochondria</u></b> [prompt on <u>organelle</u>s]',
};
const BONUS: Bonus = {
  id: 'b1', category: 'Science', subcategory: 'Biology', leadin: 'For 10 points each:',
  parts: ['Part one', 'Part two', 'Part three'], answers: ['<b><u>alpha</u></b>', '<b><u>beta</u></b>', '<b><u>gamma</u></b>'],
};

function fakeProvider(): QuestionProvider {
  let n = 0;
  return {
    nextTossup: async () => ({ ...TOSSUP, id: `t${++n}` }),
    nextBonus: async () => ({ ...BONUS, id: `b${++n}` }),
  };
}

const io: RoomIO = { emitEach: () => {}, emitTo: () => {} };
const flush = () => vi.advanceTimersByTimeAsync(0);

/** Advance until exactly `count` words are revealed. */
async function readTo(room: Room, count: number) {
  while ((room.s.tossup?.revealed ?? 0) < count) await vi.advanceTimersByTimeAsync(20);
}

async function setup(players = ['Ann', 'Bob'], mode: 'ffa' | 'teams' = 'ffa') {
  const room = new Room('TEST', io, { qbreader: fakeProvider() });
  const ids = players.map((n) => room.join(n).playerId);
  if (mode === 'teams') room.updateSettings(ids[0], { mode: 'teams' });
  room.updateSettings(ids[0], { wpm: 600 });
  room.start(ids[0]);
  await flush();
  return { room, ids };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('tossup flow', () => {
  it('awards a power for a correct early buzz', async () => {
    const { room, ids } = await setup();
    await readTo(room, 3);
    room.buzz(ids[0], 3);
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    expect(room.s.phase).toBe('buzz');
    room.submitAnswer(ids[0], 'mitochondria');
    expect(room.s.phase).toBe('tossupEnd');
    expect(room.s.rulings[0]).toMatchObject({ kind: 'power', points: 15 });
  });

  it('pauses reading during a buzz and resumes after a neg', async () => {
    const { room, ids } = await setup();
    await readTo(room, 6);
    room.buzz(ids[0], 6);
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    const before = room.s.tossup!.revealed;
    await vi.advanceTimersByTimeAsync(2000);
    expect(room.s.tossup!.revealed).toBe(before);
    room.submitAnswer(ids[0], 'golgi');
    expect(room.s.rulings[0]).toMatchObject({ kind: 'neg', points: -5 });
    expect(room.s.phase).toBe('reading');
    expect(() => room.buzz(ids[0], 7)).toThrow(/already buzzed/);
    await vi.advanceTimersByTimeAsync(1500);
    expect(room.s.tossup!.revealed).toBeGreaterThan(before);
  });

  it('gives the buzz to whoever saw fewer words, within the lag window', async () => {
    const { room, ids } = await setup();
    await readTo(room, 5);
    room.buzz(ids[0], 5); // arrives first
    room.buzz(ids[1], 4); // arrives second but buzzed one word earlier on a laggy connection
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    expect(room.s.buzz?.playerId).toBe(ids[1]);
    expect(room.s.buzz?.wordIndex).toBe(4);
  });

  it('does not trust a word count older than the lag window', async () => {
    const { room, ids } = await setup();
    await readTo(room, 8);
    room.setPaused(ids[0], true); // host pauses, then every revealed word is older than the lag window
    await vi.advanceTimersByTimeAsync(TIMING.maxLagMs + 500);
    room.buzz(ids[0], 0); // claims to have seen nothing
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    expect(room.s.buzz!.wordIndex).toBe(8); // clamped to what was really on screen: not a power
    room.submitAnswer(ids[0], 'mitochondria');
    expect(room.s.rulings[0].kind).toBe('ten');
  });

  it('times out to a wrong answer and ends when everyone is locked out', async () => {
    const { room, ids } = await setup();
    await readTo(room, 10);
    room.buzz(ids[0], 10);
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    await vi.advanceTimersByTimeAsync(room.s.settings.answerSeconds * 1000 + 10);
    expect(room.s.rulings[0]).toMatchObject({ kind: 'zero', points: 0 });
    room.buzz(ids[1], 10);
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    room.submitAnswer(ids[1], 'nope');
    expect(room.s.phase).toBe('tossupEnd');
  });

  it('prompts, then accepts a better answer', async () => {
    const { room, ids } = await setup();
    await readTo(room, 7);
    room.buzz(ids[0], 7);
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    room.submitAnswer(ids[0], 'organelles');
    expect(room.s.phase).toBe('buzz');
    expect(room.s.buzz!.prompts).toBe(1);
    room.submitAnswer(ids[0], 'mitochondria');
    expect(room.s.rulings[0].kind).toBe('ten');
  });

  it('closes the tossup after the dead window', async () => {
    const { room } = await setup();
    await readTo(room, 10);
    await vi.advanceTimersByTimeAsync(room.s.settings.deadSeconds * 1000 + 10);
    expect(room.s.phase).toBe('tossupEnd');
    expect(room.s.heard).toHaveLength(1);
  });

  it('never repeats a question', async () => {
    const { room, ids } = await setup();
    room.next(ids[0]); // host skips
    room.next(ids[0]);
    await flush();
    expect(room.s.seenTossups.size).toBe(2);
    expect(room.s.tossup!.num).toBe(2);
  });
});

describe('teams and bonuses', () => {
  it('locks out the whole team after a neg and plays a bonus after a correct buzz', async () => {
    const { room, ids } = await setup(['Ann', 'Bob', 'Cy', 'Di'], 'teams');
    const [teamA, teamB] = room.s.teams;
    const a = teamA.playerIds;
    const b = teamB.playerIds;
    await readTo(room, 3);
    room.buzz(a[0], 3);
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    room.submitAnswer(a[0], 'wrong');
    expect(() => room.buzz(a[1], 4)).toThrow(/team already buzzed/);
    await readTo(room, 6);
    room.buzz(b[1], 6);
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    room.submitAnswer(b[1], 'mitochondria');
    expect(room.s.tossup!.bonusTeam).toBe(teamB.id);

    room.next(ids[0]);
    await flush();
    expect(room.s.phase).toBe('bonus');
    expect(() => room.bonusSubmit(b[1], 'alpha')).toThrow(/captain/);
    room.bonusSubmit(b[0], 'alpha');
    await vi.advanceTimersByTimeAsync(TIMING.partRevealMs + 1);
    room.bonusSubmit(b[0], 'nope');
    await vi.advanceTimersByTimeAsync(TIMING.partRevealMs + 1);
    room.bonusSubmit(b[0], 'gamma');
    await vi.advanceTimersByTimeAsync(TIMING.partRevealMs + 1);
    expect(room.s.bonus!.done).toBe(true);

    const snap = room.snapshot(ids[0]);
    const tb = snap.teams.find((t) => t.id === teamB.id)!;
    expect(tb).toMatchObject({ points: 30, bonusPoints: 20, bonusesHeard: 1 });
    expect(snap.teams.find((t) => t.id === teamA.id)!.points).toBe(-5);
  });
});

describe('reader seat', () => {
  it('hides text from players, shows it to the reader, and lets the reader rule', async () => {
    const room = new Room('TEST', io, { qbreader: fakeProvider() });
    const host = room.join('Host').playerId;
    const reader = room.join('Reader').playerId;
    room.setReader(reader, reader);
    room.start(reader);
    await flush();
    await readTo(room, 2);

    const playerView = room.snapshot(host);
    const readerView = room.snapshot(reader);
    expect(playerView.tossup!.revealed.every((w) => w === '')).toBe(true);
    expect(playerView.tossup!.words).toBeUndefined();
    expect(readerView.tossup!.words).toHaveLength(10);
    expect(readerView.tossup!.answerHtml).toContain('mitochondria');

    expect(() => room.buzz(reader, 2)).toThrow(/reader cannot buzz/);
    room.buzz(host, 2);
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    room.submitAnswer(host, 'mitochondrion thing');
    expect(room.s.buzz!.awaiting).toBeTruthy();
    expect(() => room.rule(host === room.s.hostId ? 'nobody' : host, 'correct')).toThrow();
    room.rule(reader, 'correct');
    expect(room.s.rulings[0]).toMatchObject({ kind: 'power', points: 15 });

    // Only the reader (or host) moves to the next question.
    const other = room.join('Other').playerId;
    expect(() => room.next(other)).toThrow(/reader decides/);
    room.next(reader);
  });

  it('pauses, resumes and jumps the cursor', async () => {
    const room = new Room('TEST', io, { qbreader: fakeProvider() });
    const p = room.join('P').playerId;
    const reader = room.join('R').playerId;
    room.setReader(reader, reader);
    room.start(reader);
    await flush();
    await readTo(room, 1);
    room.setPaused(reader, true);
    const at = room.s.tossup!.revealed;
    await vi.advanceTimersByTimeAsync(3000);
    expect(room.s.tossup!.revealed).toBe(at);
    room.revealTo(reader, 6);
    expect(room.s.tossup!.revealed).toBe(6);
    room.setPaused(reader, false);
    await vi.advanceTimersByTimeAsync(400);
    expect(room.s.tossup!.revealed).toBeGreaterThan(6);
    void p;
  });
});

describe('protests and overrides', () => {
  it('flips a neg to a correct answer and recomputes points', async () => {
    const { room, ids } = await setup();
    await readTo(room, 3);
    room.buzz(ids[0], 3);
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    room.submitAnswer(ids[0], 'mitochondira typo city');
    const ruling = room.s.rulings[0];
    expect(ruling.kind).toBe('neg');
    room.protest(ids[0], ruling.id, 'that was right');
    room.resolveProtest(ids[0], room.s.protests[0].id, true);
    expect(room.s.rulings[0]).toMatchObject({ kind: 'power', points: 15, overridden: true });
    expect(room.snapshot(ids[0]).players[0].stats.points).toBe(15);
  });
});

describe('protest on the current tossup', () => {
  it('awards the bonus when a reversed ruling makes the tossup live', async () => {
    const { room, ids } = await setup(['Ann', 'Bob'], 'teams');
    const [teamA] = room.s.teams;
    const a = teamA.playerIds[0];
    await readTo(room, 10);
    room.buzz(a, 10);
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    room.submitAnswer(a, 'nope');
    await vi.advanceTimersByTimeAsync(room.s.settings.deadSeconds * 1000 + 10);
    expect(room.s.phase).toBe('tossupEnd');
    expect(room.snapshot(a).tossup!.bonusTeamId).toBeNull();
    room.override(ids[0], room.s.rulings[0].id);
    expect(room.snapshot(a).tossup!.bonusTeamId).toBe(teamA.id);
    room.next(ids[0]);
    await flush();
    expect(room.s.phase).toBe('bonus');
  });
});

describe('players', () => {
  it('lets a player rename themselves and keeps the same seat on rejoin', () => {
    const room = new Room('TEST', io, { qbreader: fakeProvider() });
    const { playerId, token } = room.join('Swift Otter');
    room.renamePlayer(playerId, '  Alex  ');
    expect(room.s.players.find((p) => p.id === playerId)?.name).toBe('Alex');
    expect(() => room.renamePlayer(playerId, '   ')).toThrow('Pick a display name.');
    // Rejoining with the saved token (e.g. a page reload) must not add a second player.
    expect(room.join('Alex', token).playerId).toBe(playerId);
    expect(room.s.players).toHaveLength(1);
  });
});
