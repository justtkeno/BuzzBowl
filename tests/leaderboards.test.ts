import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileAccountStore, type GameTotal } from '../src/server/accounts/store';
import { FileDailyStore, type DailyTotal } from '../src/server/daily/store';
import { Leaderboards, easternMidnight, periodStart, type Person } from '../src/server/leaderboards/leaderboards';
import { Room, TIMING, type RoomIO } from '../src/server/rooms/room';
import type { GameRecord } from '../src/shared/accounts';
import type { QuestionProvider, Tossup } from '../src/server/questions/types';

const TOSSUP: Tossup = { id: 't1', category: 'Science', subcategory: 'Biology', question: 'w1 w2 w3 w4 (*) w5 w6 w7 w8 w9 w10', answer: '<b><u>mitochondria</u></b>' };
const provider = (): QuestionProvider => {
  let n = 0;
  return { nextTossup: async () => ({ ...TOSSUP, id: `t${++n}` }), nextBonus: async () => null };
};

/** Ann answers the first tossup right; the game ends. `setup` runs between joining and starting. */
async function play(setup: (room: Room, ann: string, other: string) => void = () => {}, otherIsBot = false) {
  const records: { accountId: string; game: GameRecord }[] = [];
  const io: RoomIO = { emitEach: () => {}, emitTo: () => {}, gameOver: (r) => records.push(...r) };
  const room = new Room('TEST', io, { qbreader: provider() });
  const ann = room.join('Ann', undefined, { id: 'acct-ann', username: 'ann' }).playerId;
  const other = room.join('Bob', undefined, otherIsBot ? undefined : { id: 'acct-bob', username: 'bob' }).playerId;
  if (otherIsBot) room.s.players.find((p) => p.id === other)!.bot = 'medium';
  room.updateSettings(ann, { wpm: 600 });
  setup(room, ann, other);
  room.start(ann);
  await vi.advanceTimersByTimeAsync(0);
  while ((room.s.tossup?.revealed ?? 0) < 3) await vi.advanceTimersByTimeAsync(20);
  room.buzz(ann, 3);
  await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
  room.submitAnswer(ann, 'mitochondria');
  return { room, ann, other, records, finish: () => { room.end(ann); return records.find((r) => r.accountId === 'acct-ann')!.game; } };
}

describe('which games count', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('counts a win against another person', async () => {
    const g = await play();
    const ann = g.finish();
    expect(ann).toMatchObject({ ranked: true, versus: true, won: true });
    const bob = g.records.find((r) => r.accountId === 'acct-bob')!.game;
    expect(bob).toMatchObject({ ranked: true, versus: true });
    expect(bob.won).toBeUndefined();
  });

  it('beating only bots counts correct answers but not a win', async () => {
    const ann = (await play(() => {}, true)).finish();
    expect(ann.ranked).toBe(true);
    expect(ann.versus).toBeUndefined();
    expect(ann.won).toBeUndefined();
    expect(ann.powers + ann.tens).toBe(1);
  });

  it('a score changed by hand takes the game off the boards', async () => {
    const g = await play();
    g.room.adjust(g.ann, g.other, -5);
    const ann = g.finish();
    expect(ann.ranked).toBeUndefined();
    expect(ann.won).toBeUndefined();
  });

  it('a reversed ruling takes the game off the boards', async () => {
    const g = await play();
    g.room.override(g.ann, g.room.s.rulings[0].id);
    expect(g.finish().ranked).toBeUndefined();
  });

  it('starts fresh for the next game in the same room', async () => {
    const g = await play();
    g.room.adjust(g.ann, g.other, 5);
    g.finish();
    g.room.start(g.ann);
    expect(g.room.s.unranked).toBe(false);
  });

  it('a tie for first with no points is not a win', async () => {
    const records: { accountId: string; game: GameRecord }[] = [];
    const room = new Room('TEST', { emitEach: () => {}, emitTo: () => {}, gameOver: (r) => records.push(...r) }, { qbreader: provider() });
    const ann = room.join('Ann', undefined, { id: 'acct-ann', username: 'ann' }).playerId;
    room.join('Bob', undefined, { id: 'acct-bob', username: 'bob' });
    room.updateSettings(ann, { wpm: 600 });
    room.start(ann);
    await vi.advanceTimersByTimeAsync(0);
    while (room.s.phase !== 'tossupEnd') await vi.advanceTimersByTimeAsync(200); // nobody buzzes
    room.end(ann);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.game.won)).toEqual([undefined, undefined]);
  });
});

describe('periods', () => {
  it('starts days, weeks and months at midnight US Eastern', () => {
    const now = new Date('2026-11-25T15:00:00Z'); // a Wednesday
    expect(periodStart('day', now)).toBe('2026-11-25');
    expect(periodStart('week', now)).toBe('2026-11-23');
    expect(periodStart('month', now)).toBe('2026-11-01');
    expect(periodStart('all', now)).toBeNull();
    expect(new Date(easternMidnight('2026-11-25')).toISOString()).toBe('2026-11-25T05:00:00.000Z'); // EST
    expect(new Date(easternMidnight('2026-07-04')).toISOString()).toBe('2026-07-04T04:00:00.000Z'); // EDT
  });
});

describe('ranking', () => {
  const people: Record<string, Person> = {
    a: { username: 'ann', displayName: 'Ann', public: true },
    b: { username: 'bob', displayName: 'Bob', public: true },
    c: { username: 'cat', displayName: 'Cat', public: false },
    d: { username: 'dan', displayName: 'Dan', public: true },
  };
  const totals: GameTotal[] = [
    { userId: 'a', versus: 5, wins: 3, correct: 40, powers: 10 },
    { userId: 'b', versus: 4, wins: 3, correct: 40, powers: 12 },
    { userId: 'c', versus: 9, wins: 9, correct: 90, powers: 30 },
    { userId: 'd', versus: 4, wins: 3, correct: 2, powers: 0 },
  ];
  const daily: DailyTotal[] = [{ playerKey: 'a:a', days: 2, points: 150, powers: 3 }, { playerKey: 'a:b', days: 1, points: 150, powers: 2 }];
  const gameTotals = vi.fn(async (_from: number | null) => totals);
  const boards = new Leaderboards({
    gameTotals,
    dailyTotals: async () => daily,
    people: async (ids) => new Map(ids.filter((id) => people[id]).map((id) => [id, people[id]])),
    looks: async (ids) => new Map(ids.map((id) => [id, { color: 'orange', frame: 'none', ...(id === 'a' ? { title: 'VIP' } : {}) }])),
  }, () => new Date('2026-11-25T15:00:00Z'));

  it('ranks wins, breaking ties by fewer games, with ties sharing a place', async () => {
    const v = await boards.view('wins', 'all', 'a');
    expect(v.entries.map((e) => [e.username, e.rank])).toEqual([['bob', 1], ['dan', 1], ['ann', 3]]);
    expect(v.me).toMatchObject({ username: 'ann', rank: 3, value: 3, extra: 5, title: 'VIP' });
    expect(v.players).toBe(3);
  });

  it('leaves out private profiles, and tells them why', async () => {
    const v = await boards.view('correct', 'all', 'c');
    expect(v.entries.map((e) => e.username)).toEqual(['bob', 'ann', 'dan']);
    expect(v.me).toBeNull();
    expect(v.meNote).toBe('private');
    expect((await boards.view('correct', 'all', null)).meNote).toBe('guest');
    expect((await boards.view('correct', 'all', 'nobody')).meNote).toBe('none');
  });

  it('adds up the daily challenge per account; fewer days ranks higher on a tie', async () => {
    const v = await boards.view('daily', 'week', 'a');
    expect(v.entries.map((e) => [e.username, e.rank, e.value, e.extra])).toEqual([['bob', 1, 150, 1], ['ann', 2, 150, 2]]);
    expect(v.from).toBe('2026-11-23');
  });

  it('asks the store for games since the start of the period', async () => {
    gameTotals.mockClear();
    await boards.view('wins', 'month', null);
    expect(gameTotals).toHaveBeenCalledWith(Date.parse('2026-11-01T04:00:00Z'));
  });
});

describe('store totals', () => {
  it('adds up ranked games per account since a time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-lb-'));
    const store = new FileAccountStore(join(dir, 'a.json'));
    await store.init();
    const g = (at: number, x: Partial<GameRecord>): GameRecord => ({
      at, room: 'R', mode: 'ffa', sides: 2, rank: 1, standings: [], tossups: 5, points: 0, powers: 1, tens: 2, negs: 0, buzzes: 3, heard: 5,
      correctDepthSum: 0, bestStreak: 0, bonusPoints: 0, bonusesHeard: 0, categories: {}, ...x,
    });
    await store.addGames([
      { userId: 'u', game: g(100, { ranked: true, versus: true, won: true }) },
      { userId: 'u', game: g(200, { ranked: true }) },
      { userId: 'u', game: g(300, {}) }, // not ranked
      { userId: 'v', game: g(50, { ranked: true, versus: true, won: true }) },
    ]);
    expect((await store.gameTotals(null)).sort((a, b) => a.userId.localeCompare(b.userId))).toEqual([
      { userId: 'u', versus: 1, wins: 1, correct: 6, powers: 2 },
      { userId: 'v', versus: 1, wins: 1, correct: 3, powers: 1 },
    ]);
    expect(await store.gameTotals(150)).toEqual([{ userId: 'u', versus: 0, wins: 0, correct: 3, powers: 1 }]);

    const daily = new FileDailyStore(join(dir, 'd.json'));
    const row = (day: string, playerKey: string, points: number) => ({ day, playerKey, name: 'x', points, powers: 1, tens: 0, negs: 0, marks: '', depth: null, createdAt: 1 });
    await daily.addResult(row('2026-11-20', 'a:u', 50));
    await daily.addResult(row('2026-11-24', 'a:u', 30));
    await daily.addResult(row('2026-11-24', 'g:guestkey12345', 90)); // guests aren't ranked
    expect(await daily.totals('2026-11-23')).toEqual([{ playerKey: 'a:u', days: 1, points: 30, powers: 1 }]);
    expect(await daily.totals(null)).toEqual([{ playerKey: 'a:u', days: 2, points: 80, powers: 2 }]);
    rmSync(dir, { recursive: true, force: true });
  });
});
