import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Daily, DAILY_SIZE, dailyNumber, dayKey, playerKeyFor, secondsUntilNextDay } from '../src/server/daily/daily';
import { FileDailyStore, type DailyRow } from '../src/server/daily/store';
import { Room, type DailyOutcome, type RoomIO } from '../src/server/rooms/room';
import type { QuestionProvider, Tossup } from '../src/server/questions/types';

const io: RoomIO = { emitEach: () => {}, emitTo: () => {} };
const tu = (i: number): Tossup => ({
  id: `d${i}`, category: 'Science', subcategory: 'Biology',
  question: 'one two three four (*) five six seven eight', answer: `<b><u>answer${i}</u></b>`,
});
const okProvider = (): QuestionProvider => {
  let n = 0;
  return { nextTossup: async () => tu(++n), nextBonus: async () => null };
};
const downProvider: QuestionProvider = {
  nextTossup: async () => { throw new Error('offline'); },
  nextBonus: async () => null,
};

describe('days', () => {
  it('rolls over at midnight US Eastern and counts from launch', () => {
    expect(dayKey(new Date('2026-11-20T04:59:00Z'))).toBe('2026-11-19'); // 11:59 pm Eastern
    expect(dayKey(new Date('2026-11-20T05:01:00Z'))).toBe('2026-11-20');
    expect(dailyNumber('2026-11-19')).toBe(1);
    expect(dailyNumber('2026-12-01')).toBe(13);
    expect(secondsUntilNextDay(new Date('2026-11-20T04:00:00Z'))).toBeGreaterThan(3590);
    expect(secondsUntilNextDay(new Date('2026-11-20T04:00:00Z'))).toBeLessThanOrEqual(3600);
  });
  it('only accepts real guest keys', () => {
    expect(playerKeyFor('u1', undefined)).toBe('a:u1');
    expect(playerKeyFor(undefined, 'abcdef123456')).toBe('g:abcdef123456');
    expect(playerKeyFor(undefined, 'short')).toBeNull();
  });
});

describe('daily set', () => {
  it('picks 10 once and gives everyone the same set', async () => {
    const d = new Daily(new FileDailyStore(null), okProvider());
    const [a, b] = await Promise.all([d.set('2026-11-19'), d.set('2026-11-19')]);
    expect(a).toHaveLength(DAILY_SIZE);
    expect(b.map((t) => t.id)).toEqual(a.map((t) => t.id));
  });
  it('falls back to the sample packet, in the same order for everyone, when QBReader is down', async () => {
    const one = await new Daily(new FileDailyStore(null), downProvider).set('2026-11-19');
    const two = await new Daily(new FileDailyStore(null), downProvider).set('2026-11-19');
    expect(one).toHaveLength(DAILY_SIZE);
    expect(two.map((t) => t.id)).toEqual(one.map((t) => t.id));
  });
});

describe('leaderboard', () => {
  const row = (key: string, points: number, depth: number | null, at: number): DailyRow => ({
    day: '2026-11-19', playerKey: key, name: key, points, powers: 0, tens: 0, negs: 0, marks: '----------', depth, createdAt: at,
  });
  it('ranks by points, then earlier buzzes, then who finished first; one result per player', async () => {
    const s = new FileDailyStore(null);
    await s.addResult(row('a', 40, 0.6, 1));
    await s.addResult(row('b', 55, 0.8, 2));
    await s.addResult(row('c', 40, 0.4, 3));
    expect(await s.addResult(row('a', 100, 0.1, 4))).toBe(false);
    expect((await s.top('2026-11-19', 10)).map((r) => r.playerKey)).toEqual(['b', 'c', 'a']);
    expect(await s.rankOf((await s.result('2026-11-19', 'a'))!)).toBe(3);
  });
});

describe('daily room', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function playDaily() {
    const tossups = [tu(1), tu(2), tu(3)];
    const room = new Room('DAY1', io, {});
    const me = room.join('Hao').playerId;
    room.makeDaily({ day: '2026-11-19', number: 1, playerKey: 'g:abcdef123456' }, tossups);
    const done: DailyOutcome[] = [];
    room.onDailyDone = (o) => done.push(o);
    room.start(me);
    return { room, me, done };
  }
  const waitFor = async (room: Room, phase: string) => { for (let i = 0; i < 400 && room.s.phase !== phase; i++) await vi.advanceTimersByTimeAsync(50); };

  it('plays the fixed set in order and reports the result once', async () => {
    const { room, me, done } = await playDaily();
    await waitFor(room, 'reading');
    expect(room.s.tossup?.q.id).toBe('d1');
    while ((room.s.tossup?.revealed ?? 0) < 2) await vi.advanceTimersByTimeAsync(20);
    room.buzz(me, 2);
    await waitFor(room, 'buzz');
    room.submitAnswer(me, 'answer1'); // power
    for (const n of [2, 3]) {
      room.next(me);
      await waitFor(room, 'reading');
      expect(room.s.tossup?.q.id).toBe(`d${n}`);
      if (n === 2) {
        while ((room.s.tossup?.revealed ?? 0) < 3) await vi.advanceTimersByTimeAsync(20);
        room.buzz(me, 3);
        await waitFor(room, 'buzz');
        room.submitAnswer(me, 'wrong'); // neg
      }
      await waitFor(room, 'tossupEnd');
    }
    room.next(me); // after the last one: game over
    expect(room.s.phase).toBe('gameOver');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ marks: 'PN-', points: 10, powers: 1, negs: 1 });
    expect(() => room.start(me)).toThrow('played today');
  });

  it('locks everything that could change a score', async () => {
    const { room, me } = await playDaily();
    expect(() => room.updateSettings(me, { wpm: 100 })).toThrow('same settings');
    expect(() => room.adjust(me, me, 10)).toThrow('daily challenge');
    expect(() => room.setReader(me, me)).toThrow('no reader');
    expect(() => room.join('Friend')).toThrow('solo');
    expect(() => room.pauseGame(me, true)).toThrow('paused');
  });
});

describe('daily record on profiles', () => {
  const shift = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const row = (day: string, key: string, points: number, depth: number | null = 0.5): DailyRow => ({
    day, playerKey: key, name: key, points, powers: 0, tens: 0, negs: 0, marks: 'TT--------', depth, createdAt: Date.parse(`${day}T12:00:00Z`),
  });

  it('counts finished first places, podiums, streaks and recent days', async () => {
    const today = dayKey();
    const s = new FileDailyStore(null);
    const d = new Daily(s, okProvider());
    // 4 days ago: alone (played, but no win). 3 days ago: missed. 2 days ago: won a tie on earlier buzzes.
    // Yesterday: 3rd of 3. Today: leading, but today doesn't count as a win yet.
    await s.addResult(row(shift(today, -4), 'me', 30));
    await s.addResult(row(shift(today, -2), 'me', 40, 0.3));
    await s.addResult(row(shift(today, -2), 'rival', 40, 0.6));
    await s.addResult(row(shift(today, -1), 'me', 10));
    await s.addResult(row(shift(today, -1), 'rival', 50));
    await s.addResult(row(shift(today, -1), 'third', 20));
    await s.addResult(row(today, 'me', 60));
    await s.addResult(row(today, 'rival', 20));
    const p = (await d.profile('me'))!;
    expect(p).toMatchObject({ played: 4, wins: 1, podiums: 1, bestRank: 1, bestScore: 60, avgPoints: 35, streak: 3, longestStreak: 3, leadingToday: true });
    expect(p.recent.map((x) => [x.day, x.rank, x.players])).toEqual([
      [today, 1, 2], [shift(today, -1), 3, 3], [shift(today, -2), 1, 2], [shift(today, -4), 1, 1],
    ]);
    expect(await d.profile('nobody')).toBeNull();
  });

  it('keeps a streak alive until today is over', async () => {
    const today = dayKey();
    const s = new FileDailyStore(null);
    await s.addResult(row(shift(today, -2), 'me', 10));
    await s.addResult(row(shift(today, -1), 'me', 10));
    expect((await new Daily(s, okProvider()).profile('me'))!.streak).toBe(2);
  });
});
