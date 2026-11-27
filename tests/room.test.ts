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

  it('sizes the lag window to the buzzer\'s measured connection, so a fast one cannot rewind a whole second', async () => {
    const { room, ids } = await setup();
    room.setPing(ids[0], 40); // honest, fast connection
    room.setPing(ids[1], 40); // fast connection that lies about its word count
    await readTo(room, 8);
    const now = Date.now();
    // What a 40 ms connection may honestly claim: words revealed within 1.5 round trips + margin (at least the floor).
    const allowed = Math.max(TIMING.lagFloorMs, 40 * 1.5 + TIMING.lagMarginMs);
    let honest = 8;
    while (honest > 0 && now - room.s.tossup!.revealTimes[honest - 1] <= allowed) honest--;
    room.buzz(ids[0], 8); // pressed now
    room.buzz(ids[1], 0); // pressed a moment later, claims it saw nothing
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    expect(room.s.buzz!.wordIndex).toBeGreaterThanOrEqual(honest); // clamped to its own window, not the full 1.2 s
    expect(room.s.buzz!.wordIndex).toBeGreaterThan(0); // the lie bought at most a few words, not the whole question
  });

  it('refuses a buzz before the first word is read', async () => {
    const { room, ids } = await setup();
    expect(room.s.tossup!.revealed).toBe(0);
    expect(() => room.buzz(ids[0], 0)).toThrow(/first word|cannot buzz/);
  });

  it('keeps the whole answer clock when reading resumes during the buzz grace period', async () => {
    const { room, ids } = await setup();
    const t = room.s.tossup!;
    while (t.revealed < t.words.length) await vi.advanceTimersByTimeAsync(20);
    room.setPaused(ids[0], true);
    room.buzz(ids[1], t.revealed);
    room.setPaused(ids[0], false); // resumed inside the grace period: used to leave a dead-window timer running
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    expect(room.s.phase).toBe('buzz');
    await vi.advanceTimersByTimeAsync(room.s.settings.deadSeconds * 1000 + 200);
    expect(room.s.phase).toBe('buzz'); // still answering: the tossup didn't end under them
    expect(room.s.buzz?.playerId).toBe(ids[1]);
  });

  it('changes nothing when a settings update is refused', async () => {
    const { room, ids } = await setup();
    const wpm = room.s.settings.wpm;
    expect(() => room.updateSettings(ids[0], { wpm: 555, answerSeconds: 3, source: 'upload' })).toThrow(/Upload a packet/);
    expect(room.s.settings.wpm).toBe(wpm);
    expect(room.s.settings.answerSeconds).not.toBe(3);
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

  it('asks once to check the spelling of a near miss, with the typed answer kept', async () => {
    const { room, ids } = await setup();
    await readTo(room, 7);
    room.buzz(ids[0], 7);
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    room.submitAnswer(ids[0], 'motocondira');
    expect(room.s.phase).toBe('buzz');
    expect(room.snapshot(ids[0]).buzz).toMatchObject({ prompts: 1, spelling: 'motocondira' });
    room.submitAnswer(ids[0], 'mitocondira');
    expect(room.s.rulings[0]).toMatchObject({ correct: true, correctedTo: 'mitochondria' });
  });

  it('gives only one spelling check per answer', async () => {
    const { room, ids } = await setup();
    await readTo(room, 7);
    room.buzz(ids[0], 7);
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    room.submitAnswer(ids[0], 'motocondira');
    room.submitAnswer(ids[0], 'mitocxadria');
    expect(room.s.rulings[0]).toMatchObject({ correct: false });
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

describe('changing settings mid-match', () => {
  it('stretches a running answer clock and tells everyone', async () => {
    const { room, ids } = await setup();
    await readTo(room, 3);
    room.buzz(ids[1], 3);
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    const deadline = room.s.buzz!.deadline!;
    room.updateSettings(ids[0], { answerSeconds: 18 });
    expect(room.s.buzz!.deadline!).toBe(deadline + 8_000);
    expect(room.s.chat.at(-1)?.text).toBe('Ann changed answer time to 18 s.');
    await vi.advanceTimersByTimeAsync(13_000); // past the old 10 s limit
    expect(room.s.phase).toBe('buzz');
    room.submitAnswer(ids[1], 'mitochondria');
    expect(room.s.rulings[0]).toMatchObject({ kind: 'power' });
  });

  it('shortens a running clock but leaves at least a second', async () => {
    const { room, ids } = await setup();
    await readTo(room, 3);
    room.buzz(ids[1], 3);
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    await vi.advanceTimersByTimeAsync(4_000);
    room.updateSettings(ids[0], { answerSeconds: 2 });
    expect(room.s.buzz!.deadline! - Date.now()).toBe(1_000);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(room.s.phase).not.toBe('buzz');
  });

  it('stretches the buzz window after the last word', async () => {
    const { room, ids } = await setup();
    await readTo(room, 10);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(room.s.tossup!.deadline).toBeTruthy();
    room.updateSettings(ids[0], { deadSeconds: 10 });
    await vi.advanceTimersByTimeAsync(6_000); // past the old 5 s window
    expect(room.s.phase).toBe('reading');
    room.buzz(ids[0], 10);
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    expect(room.s.phase).toBe('buzz');
  });

  it('lists several changes in one chat note and stays quiet in the lobby', async () => {
    const room = new Room('TEST', io, { qbreader: fakeProvider() });
    const host = room.join('Ann').playerId;
    room.updateSettings(host, { answerSeconds: 10 });
    expect(room.s.chat.filter((m) => m.system && m.text.includes('changed'))).toHaveLength(0);
    room.start(host);
    await flush();
    room.updateSettings(host, { negs: false, powerValue: 20, wpm: 300 });
    expect(room.s.chat.at(-1)?.text).toBe('Ann changed reading speed to 300 wpm, negs off, power value to 20.');
  });
});

describe('game pause', () => {
  it('freezes the answer clock and shifts the deadline on resume', async () => {
    const { room, ids } = await setup();
    await readTo(room, 3);
    room.buzz(ids[1], 3);
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    const deadline = room.s.buzz!.deadline!;
    room.pauseGame(ids[0], true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(room.s.phase).toBe('buzz'); // the answer timer did not fire
    expect(() => room.submitAnswer(ids[1], 'mitochondria')).toThrow(/paused/);
    room.pauseGame(ids[0], false);
    expect(room.s.buzz!.deadline!).toBeGreaterThanOrEqual(deadline + 60_000);
    room.submitAnswer(ids[1], 'mitochondria');
    expect(room.s.phase).toBe('tossupEnd');
  });

  it('keeps a changed answer time when the game is paused', async () => {
    const { room, ids } = await setup();
    await readTo(room, 3);
    room.buzz(ids[1], 3);
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    room.pauseGame(ids[0], true);
    const deadline = room.s.buzz!.deadline!;
    room.updateSettings(ids[0], { answerSeconds: 23 });
    expect(room.s.buzz!.deadline!).toBe(deadline + 13_000);
    room.pauseGame(ids[0], false);
    await vi.advanceTimersByTimeAsync(18_000);
    expect(room.s.phase).toBe('buzz');
    await vi.advanceTimersByTimeAsync(6_000);
    expect(room.s.phase).not.toBe('buzz');
  });

  it('only lets the host or reader pause', async () => {
    const { room, ids } = await setup();
    expect(() => room.pauseGame(ids[1], true)).toThrow();
  });
});

describe('saving and restoring', () => {
  it('comes back paused mid-tossup with scores and tokens intact', async () => {
    const { room, ids } = await setup();
    await readTo(room, 3);
    room.buzz(ids[0], 3);
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    room.submitAnswer(ids[0], 'mitochondria');
    room.next(ids[0]);
    await flush();
    await readTo(room, 2);
    const token = room.s.players[0].token;
    const saved = JSON.parse(JSON.stringify(room.toJSON()));
    room.dispose();

    const back = Room.restore(saved, io, { qbreader: fakeProvider() });
    expect(back.s.phase).toBe('reading');
    expect(back.s.paused).toBe(true);
    expect(back.s.players.every((p) => !p.online)).toBe(true);
    expect(back.s.seenTossups.size).toBe(2);
    expect(back.snapshot(ids[0]).players.find((p) => p.id === ids[0])!.stats.points).toBe(15);
    expect(back.join('Ann', token).playerId).toBe(ids[0]);
    back.pauseGame(ids[0], false);
    const before = back.s.tossup!.revealed;
    await vi.advanceTimersByTimeAsync(1000);
    expect(back.s.tossup!.revealed).toBeGreaterThan(before);
    back.dispose();
  });
});

describe('history and streaks', () => {
  it('tracks running totals and streaks at game over', async () => {
    const { room, ids } = await setup();
    for (let i = 0; i < 2; i++) {
      await readTo(room, 3);
      room.buzz(ids[0], 3);
      await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
      room.submitAnswer(ids[0], 'mitochondria');
      room.next(ids[0]);
      await flush();
    }
    expect(room.snapshot(ids[0]).players.find((p) => p.id === ids[0])!.streak).toBe(2);
    room.end(ids[0]);
    const snap = room.snapshot(ids[0]);
    expect(snap.history.map((h) => h.totals[ids[0]])).toEqual([0, 15, 30]);
    expect(snap.highlights.map((h) => h.title)).toContain('Longest streak');
  });
});

describe('host seat after a restart', () => {
  it('keeps the seat for the old host for a while', async () => {
    const { room, ids } = await setup();
    const saved = JSON.parse(JSON.stringify(room.toJSON()));
    room.dispose();
    const back = Room.restore(saved, io, { qbreader: fakeProvider() });
    const late = back.join('Newcomer').playerId;
    expect(back.s.hostId).toBe(ids[0]);
    expect(() => back.pauseGame(late, false)).toThrow();
    back.join('Ann', saved.players[0].token);
    expect(back.s.hostId).toBe(ids[0]);
    back.dispose();
  });
});

describe('reader as game master', () => {
  function filterProvider(calls: string[][]): QuestionProvider {
    let n = 0;
    return {
      nextTossup: async (f) => { calls.push([...f.categories]); return { ...TOSSUP, id: `t${++n}`, category: f.categories[0] ?? 'Science' }; },
      nextBonus: async () => ({ ...BONUS, id: `b${++n}` }),
    };
  }

  it('changes the questions mid-match: the current tossup stays, the next one uses the new filters', async () => {
    const calls: string[][] = [];
    const room = new Room('TEST', io, { qbreader: filterProvider(calls) });
    const host = room.join('Host').playerId;
    const reader = room.join('Reader').playerId;
    room.setReader(reader, reader);
    room.start(reader);
    await flush();
    await readTo(room, 2);
    const current = room.s.tossup!.q.id;

    expect(() => room.updateSettings(room.join('Player').playerId, { filters: { ...room.s.settings.filters, categories: ['History'] } })).toThrow(/host or reader/);
    room.updateSettings(reader, { filters: { ...room.s.settings.filters, categories: ['History'] } });
    await flush();
    expect(room.s.tossup!.q.id).toBe(current);
    expect(current).toBeTruthy();
    expect(room.s.chat.at(-1)?.text).toMatch(/Reader changed the questions to QBReader: History\. They start with the next tossup\./);
    expect(room.snapshot(reader).upcoming!.every((q) => q.category === 'History')).toBe(true);

    room.next(reader); // skip ahead
    await flush();
    room.next(reader);
    await flush();
    expect(room.s.tossup!.q.category).toBe("History");

    // Saving the same questions again does not post another note.
    const notes = room.s.chat.length;
    room.updateSettings(reader, { filters: { ...room.s.settings.filters } });
    expect(room.s.chat.length).toBe(notes);
    void host;
  });

  it('lets the reader manage teams and captains like the host', async () => {
    const room = new Room('TEST', io, { qbreader: fakeProvider() });
    const host = room.join('Host').playerId;
    const a = room.join('A').playerId;
    const b = room.join('B').playerId;
    const reader = room.join('Reader').playerId;
    room.updateSettings(host, { mode: 'teams' });
    room.setReader(reader, reader);

    room.createTeam(reader, 'Gamma');
    const gamma = room.s.teams.find((t) => t.name === 'Gamma')!;
    room.renameTeam(reader, gamma.id, 'Delta');
    expect(gamma.name).toBe('Delta');
    room.movePlayer(reader, a, gamma.id);
    room.movePlayer(reader, b, gamma.id);
    expect(gamma.playerIds).toEqual([a, b]);
    room.makeCaptain(reader, b);
    expect(gamma.playerIds[0]).toBe(b);
    expect(() => room.movePlayer(reader, reader, gamma.id)).toThrow(/reader is not on a team/);
    expect(() => room.movePlayer(a, b, null)).toThrow(/host or reader/);
    room.movePlayer(reader, b, null);
    expect(room.s.players.find((p) => p.id === b)!.teamId).toBeNull();
    room.removeTeam(reader, gamma.id);
    expect(room.s.teams.some((t) => t.id === gamma.id)).toBe(false);
  });

  it('lets the reader hand the seat to someone else', () => {
    const room = new Room('TEST', io, { qbreader: fakeProvider() });
    const host = room.join('Host').playerId;
    const reader = room.join('Reader').playerId;
    const next = room.join('Next').playerId;
    room.setReader(reader, reader);
    expect(() => room.setReader(host, next)).toThrow(/already reading/);
    room.setReader(reader, next);
    expect(room.s.readerId).toBe(next);
  });
});

describe('seats survive a dropped connection', () => {
  async function readerGame(mode: 'ffa' | 'teams' = 'ffa') {
    const room = new Room('SEAT', io, { qbreader: fakeProvider() });
    const host = room.join('Hao');
    const ann = room.join('Ann');
    const bob = room.join('Bob');
    if (mode === 'teams') room.updateSettings(host.playerId, { mode: 'teams' });
    room.setReader(host.playerId, host.playerId);
    room.start(host.playerId);
    await flush();
    return { room, host, ann, bob };
  }

  it('gives the reader seat back on reconnect mid-match', async () => {
    const { room, host } = await readerGame();
    await readTo(room, 2);
    room.disconnect(host.playerId);
    expect(room.s.readerId).toBeNull();
    expect(room.s.hostId).not.toBe(host.playerId);
    room.join('Hao', host.token);
    expect(room.s.readerId).toBe(host.playerId);
    expect(room.s.hostId).toBe(host.playerId);
    expect(() => room.buzz(host.playerId, 2)).toThrow(/reader cannot buzz/);
    room.dispose();
  });

  it('keeps the reader off a team after coming back in teams mode', async () => {
    const { room, host } = await readerGame('teams');
    room.disconnect(host.playerId);
    room.join('Hao', host.token);
    expect(room.s.readerId).toBe(host.playerId);
    expect(room.s.teams.some((t) => t.playerIds.includes(host.playerId))).toBe(false);
    room.dispose();
  });

  it('lets the seat go after the hold runs out', async () => {
    const { room, host } = await readerGame();
    room.disconnect(host.playerId);
    await vi.advanceTimersByTimeAsync(TIMING.seatHoldMs + 1000);
    room.join('Hao', host.token);
    expect(room.s.readerId).toBeNull();
    room.dispose();
  });

  it('does not take the seat back from a new reader', async () => {
    const { room, host, ann } = await readerGame();
    room.disconnect(host.playerId);
    room.next(ann.playerId); // skip to between questions
    room.setReader(ann.playerId, ann.playerId);
    room.join('Hao', host.token);
    expect(room.s.readerId).toBe(ann.playerId);
    room.dispose();
  });
});

describe('admin room controls', () => {
  it('lets an admin set the host and reader mid-match', async () => {
    const room = new Room('ADMN', io, { qbreader: fakeProvider() });
    const ann = room.join('Ann');
    const admin = room.join('Hao', undefined, { id: 'acc1', username: 'Hao', admin: true });
    const bob = room.join('Bob');
    room.start(ann.playerId);
    await flush();
    await readTo(room, 2);
    expect(() => room.setReader(admin.playerId, admin.playerId)).toThrow(/between questions/);
    room.adminSetReader(admin.playerId, bob.playerId);
    expect(room.s.readerId).toBe(bob.playerId);
    room.adminSetReader(admin.playerId, admin.playerId);
    expect(room.s.readerId).toBe(admin.playerId);
    room.adminSetHost(admin.playerId, bob.playerId);
    expect(room.s.hostId).toBe(bob.playerId);
    room.adminSetReader(admin.playerId, null);
    expect(room.s.readerId).toBeNull();
    room.dispose();
  });

  it('refuses non-admins', async () => {
    const room = new Room('ADMN', io, { qbreader: fakeProvider() });
    const ann = room.join('Ann');
    const bob = room.join('Bob');
    expect(() => room.adminSetHost(bob.playerId, bob.playerId)).toThrow(/admins/);
    expect(() => room.adminSetReader(bob.playerId, bob.playerId)).toThrow(/admins/);
    expect(room.s.hostId).toBe(ann.playerId);
  });

  it('will not seat someone who is answering', async () => {
    const room = new Room('ADMN', io, { qbreader: fakeProvider() });
    const admin = room.join('Hao', undefined, { id: 'acc1', username: 'Hao', admin: true });
    const ann = room.join('Ann');
    room.start(admin.playerId);
    await flush();
    await readTo(room, 3);
    room.buzz(ann.playerId, 3);
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    expect(() => room.adminSetReader(admin.playerId, ann.playerId)).toThrow(/answering/);
    room.dispose();
  });
});

describe('moderation and admin extras', () => {
  const ADMIN = { id: 'acc1', username: 'Hao', admin: true };

  async function withAdmin() {
    const room = new Room('TEST', io, { qbreader: fakeProvider() });
    const ann = room.join('Ann').playerId; // host
    const bob = room.join('Bob');
    const admin = room.join('Hao', undefined, ADMIN).playerId;
    room.updateSettings(ann, { wpm: 600 });
    return { room, ann, bob: bob.playerId, bobToken: bob.token, admin };
  }

  it('lets the host kick, and a ban keeps the seat and account out', async () => {
    const { room, ann, bob, bobToken } = await withAdmin();
    room.kick(ann, bob);
    expect(room.s.players.some((p) => p.id === bob)).toBe(false);
    const back = room.join('Bob', bobToken); // a plain kick can come back
    room.kick(ann, back.playerId, true);
    expect(() => room.join('Bob', back.token)).toThrow(/banned/);
    const carl = room.join('Carl', undefined, { id: 'acc9', username: 'carl' }).playerId;
    room.kick(ann, carl, true);
    expect(() => room.join('Carl again', undefined, { id: 'acc9', username: 'carl' })).toThrow(/banned/);
  });

  it('refuses moderation from regular players and on the admin', async () => {
    const { room, ann, bob, admin } = await withAdmin();
    expect(() => room.kick(bob, ann)).toThrow(/host or reader/);
    expect(() => room.kick(ann, admin)).toThrow(/creator/);
    expect(() => room.mute(ann, admin, true)).toThrow(/creator/);
    room.kick(admin, ann); // the admin can, in any room
    expect(room.s.hostId).not.toBe(ann);
  });

  it('mutes and unmutes chat', async () => {
    const { room, ann, bob } = await withAdmin();
    room.mute(ann, bob, true);
    expect(() => room.chat(bob, 'hi', 'all')).toThrow(/muted/);
    expect(room.snapshot(ann).players.find((p) => p.id === bob)?.muted).toBe(true);
    room.mute(ann, bob, false);
    expect(() => room.chat(bob, 'hi', 'all')).not.toThrow();
  });

  it('gives a locked-out player their buzz back', async () => {
    const { room, ann, bob } = await withAdmin();
    room.start(ann);
    await flush();
    await readTo(room, 3);
    room.buzz(bob, 3);
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    room.submitAnswer(bob, 'golgi');
    expect(() => room.buzz(bob, 4)).toThrow(/already buzzed/);
    room.allowRebuzz(ann, bob);
    await readTo(room, 5);
    room.buzz(bob, 5);
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    expect(room.s.buzz?.playerId).toBe(bob);
  });

  it('a frozen buzzer silently does nothing, for one tossup or until unfrozen', async () => {
    const { room, ann, bob, admin } = await withAdmin();
    expect(() => room.freeze(ann, bob, 'always')).toThrow(/admins/);
    room.start(ann);
    await flush();
    room.freeze(admin, bob, 'tossup');
    await readTo(room, 3);
    expect(() => room.buzz(bob, 3)).not.toThrow();
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    expect(room.s.phase).toBe('reading');
    // Nobody but the admin can tell.
    expect(JSON.stringify(room.snapshot(bob))).not.toMatch(/frozen/);
    expect(room.snapshot(admin).admin?.frozen).toEqual([{ id: bob, always: false }]);
    room.next(ann);
    room.next(ann);
    await flush();
    await readTo(room, 2);
    room.buzz(bob, 2); // next tossup: thawed
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    expect(room.s.buzz?.playerId).toBe(bob);
  });

  it('a slowed buzzer counts two words late, so a close race goes to the other player', async () => {
    const { room, ann, bob, admin } = await withAdmin();
    expect(() => room.setSlowed(ann, bob, true)).toThrow(/admins/);
    room.start(ann);
    await flush();
    room.setSlowed(admin, bob, true);
    await readTo(room, 6);
    room.buzz(bob, 4); // two words earlier than Ann, but counted as 6
    room.buzz(ann, 5);
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    expect(room.s.buzz?.playerId).toBe(ann);
    expect(room.snapshot(admin).admin?.slowed).toEqual([bob]);
    expect(JSON.stringify(room.snapshot(bob))).not.toMatch(/slowed/);
  });

  it('force-buzzes someone in, and whispers and shakes only who it should', async () => {
    const sent: { to: string[]; event: string; payload: any }[] = [];
    const room = new Room('TEST', { emitEach: () => {}, emitTo: (to, event, payload) => sent.push({ to, event, payload }) }, { qbreader: fakeProvider() });
    const ann = room.join('Ann').playerId;
    const bob = room.join('Bob').playerId;
    const admin = room.join('Hao', undefined, ADMIN).playerId;
    room.updateSettings(ann, { wpm: 600 });
    expect(() => room.forceBuzz(ann, bob)).toThrow(/admins/);
    expect(() => room.forceBuzz(admin, bob)).toThrow(/being read/);
    room.start(ann);
    await flush();
    await readTo(room, 3);
    room.forceBuzz(admin, bob);
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    expect(room.s.phase).toBe('buzz');
    expect(room.s.buzz?.playerId).toBe(bob);

    room.whisper(admin, ann, '  psst  ');
    expect(sent.filter((x) => x.event === 'announce')).toEqual([{ to: [ann], event: 'announce', payload: expect.objectContaining({ text: 'psst' }) }]);
    room.shake(admin, bob);
    room.shake(admin, null);
    const shakes = sent.filter((x) => x.event === 'shake').map((x) => x.to);
    expect(shakes[0]).toEqual([bob]);
    expect(shakes[1]).toEqual(expect.arrayContaining([ann, bob]));
    expect(shakes[1]).not.toContain(admin);
    expect(() => room.whisper(ann, bob, 'hi')).toThrow(/admins/);
    room.dispose();
  });

  it('keeps the new tricks out of the daily challenge', () => {
    const room = new Room('DAY', io, {});
    const me = room.join('Hao', undefined, ADMIN).playerId;
    room.makeDaily({ day: '2026-11-23', number: 5, playerKey: 'a:acc1' }, [TOSSUP]);
    for (const f of [() => room.shake(me, null), () => room.whisper(me, me, 'x'), () => room.setSlowed(me, me, true), () => room.forceBuzz(me, me)]) {
      expect(f).toThrow(/daily challenge or survival/);
    }
    room.dispose();
  });

  it('shows the answer only to a peeking admin', async () => {
    const { room, ann, bob, admin } = await withAdmin();
    room.start(ann);
    await flush();
    expect(() => room.setPeek(bob, true)).toThrow(/admins/);
    expect(room.snapshot(admin).peek).toBeUndefined();
    room.setPeek(admin, true);
    expect(room.snapshot(admin).peek?.tossup).toMatch(/mitochondria/);
    for (const v of [ann, bob]) {
      expect(room.snapshot(v).peek).toBeUndefined();
      expect(room.snapshot(v).admin).toBeUndefined();
      expect(room.snapshot(v).tossup?.answerHtml).toBeUndefined();
    }
  });

  it('lets only the admin rename others, announce, and skip in any room', async () => {
    const emitted: { ids: string[]; event: string; payload: unknown }[] = [];
    const room = new Room('TEST', { emitEach: () => {}, emitTo: (ids, event, payload) => emitted.push({ ids, event, payload }) }, { qbreader: fakeProvider() });
    const ann = room.join('Ann').playerId;
    const bob = room.join('Bob').playerId;
    const admin = room.join('Hao', undefined, ADMIN).playerId;
    expect(() => room.adminRename(ann, bob, 'x')).toThrow(/admins/);
    room.adminRename(admin, bob, 'Bobby Tables');
    expect(room.s.players.find((p) => p.id === bob)?.name).toBe('Bobby Tables');
    expect(() => room.announce(ann, 'hi')).toThrow(/admins/);
    room.announce(admin, 'SUDDEN DEATH');
    expect(emitted.find((e) => e.event === 'announce')).toMatchObject({ payload: { text: 'SUDDEN DEATH' } });
    room.setReader(ann, ann);
    room.start(ann);
    await flush();
    expect(() => room.next(bob)).toThrow();
    room.next(admin);
    expect(room.s.phase).toBe('tossupEnd');
  });
});

describe('kicking', () => {
  it('tells the kicked player and detaches them before anyone gets the new state', async () => {
    const order: string[] = [];
    const room = new Room('TEST', {
      emitEach: (event) => order.push(`each:${event}`),
      emitTo: (ids, event) => order.push(`to:${event}`),
      remove: (id) => order.push(`remove:${id}`),
    }, { qbreader: fakeProvider() });
    const ann = room.join('Ann').playerId;
    const bob = room.join('Bob').playerId;
    order.length = 0;
    room.kick(ann, bob);
    expect(order.slice(0, 2)).toEqual(['to:kicked', `remove:${bob}`]);
    expect(order.indexOf('each:state')).toBeGreaterThan(1);
  });
});
