import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room, type RoomIO, type SurvivalOutcome } from '../src/server/rooms/room';
import { botsFor } from '../src/server/rooms/bots';
import { FileSurvivalStore, PgSurvivalStore, type SurvivalRow, type SurvivalStore } from '../src/server/survival/store';
import { Survival, weekStart } from '../src/server/survival/survival';
import { SurvivalProvider, survivalDifficulties } from '../src/server/survival/questions';
import type { QuestionProvider, Tossup } from '../src/server/questions/types';
import type { Filters } from '../src/shared/types';

const io: RoomIO = { emitEach: () => {}, emitTo: () => {} };
const tu = (i: number): Tossup => ({
  id: `s${i}`, category: 'Science', subcategory: 'Biology',
  question: 'one two three four (*) five six seven eight', answer: `<b><u>answer${i}</u></b>`,
});
/** A QBReader stand-in that always has another tossup, and remembers the difficulties it was asked for. */
const okProvider = () => {
  let n = 0;
  const asked: number[][] = [];
  const p: QuestionProvider = { nextTossup: async (f: Filters) => { asked.push(f.difficulties); return tu(++n); }, nextBonus: async () => null };
  return { p, asked };
};

describe('survival room', () => {
  beforeEach(() => { vi.useFakeTimers(); SurvivalProvider.qbreaderDownUntil = 0; });
  afterEach(() => vi.useRealTimers());

  function startRun(account?: { id: string; username: string }, records: unknown[] = []) {
    const { p, asked } = okProvider();
    const room = new Room('SURV', { ...io, gameOver: (r) => records.push(...r) }, { qbreader: p });
    const me = room.join('Hao', undefined, account).playerId;
    room.makeSurvival('g:abcdef123456');
    const done: SurvivalOutcome[] = [];
    room.onSurvivalDone = (o) => done.push(o);
    room.start(me);
    return { room, me, done, asked };
  }
  const waitFor = async (room: Room, phase: string) => { for (let i = 0; i < 400 && room.s.phase !== phase; i++) await vi.advanceTimersByTimeAsync(50); };
  const buzzAt = async (room: Room, me: string, words: number, answer: string) => {
    await waitFor(room, 'reading');
    while ((room.s.tossup?.revealed ?? 0) < words) await vi.advanceTimersByTimeAsync(20);
    room.buzz(me, words);
    await waitFor(room, 'buzz');
    room.submitAnswer(me, answer);
  };
  const lives = (room: Room) => room.snapshot(null).survival!.lives;

  it('takes a life for a neg, a dead tossup and a wrong answer at the end, but not for a correct one', async () => {
    const { room, me, done } = startRun();
    expect(lives(room)).toBe(3);
    await buzzAt(room, me, 2, 'answer1'); // power
    expect(room.s.phase).toBe('tossupEnd');
    expect(lives(room)).toBe(3);

    room.next(me);
    await buzzAt(room, me, 3, 'nope'); // neg
    expect(room.s.phase).toBe('tossupEnd');
    expect(lives(room)).toBe(2);

    room.next(me);
    await waitFor(room, 'reading');
    await waitFor(room, 'tossupEnd'); // nobody buzzed: dead
    expect(lives(room)).toBe(1);
    expect(done).toHaveLength(0);

    room.next(me);
    await buzzAt(room, me, 8, 'answer4'); // after the end: a ten
    room.next(me);
    await buzzAt(room, me, 8, 'wrong'); // wrong at the end, no neg: last life
    expect(room.s.phase).toBe('tossupEnd');
    const snap = room.snapshot(me).survival!;
    expect(snap).toMatchObject({ lives: 0, done: true, tossups: 5, correct: 2, marks: 'PN-TZ' });
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ tossups: 5, correct: 2, powers: 1, tens: 1, negs: 1, points: 15 + 10 - 5, marks: 'PN-TZ', playerKey: 'g:abcdef123456' });

    // The answer stays up until they move on; then the results.
    room.next(me);
    expect(room.s.phase).toBe('gameOver');
    expect(done).toHaveLength(1);
    expect(() => room.start(me)).toThrow('run is over');
  });

  it('saves the game to the profile, once, as a survival game', async () => {
    const records: { game: { survival?: boolean; tossups: number } }[] = [];
    const { room, me } = startRun({ id: 'acct-hao', username: 'hao' }, records);
    for (let i = 0; i < 3; i++) {
      if (i) room.next(me);
      await buzzAt(room, me, 3, 'nope');
    }
    expect(room.s.survival!.done).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0].game).toMatchObject({ survival: true, tossups: 3 });
    room.next(me);
    expect(records).toHaveLength(1);
  });

  it('can’t skip a tossup to dodge a miss', async () => {
    const { room, me } = startRun();
    await waitFor(room, 'reading');
    expect(() => room.next(me)).toThrow('Every tossup counts');
    while ((room.s.tossup?.revealed ?? 0) < 2) await vi.advanceTimersByTimeAsync(20);
    room.buzz(me, 2);
    await waitFor(room, 'buzz');
    expect(() => room.next(me)).toThrow('Every tossup counts');
  });

  it('keeps playing while the player is away, so a reload can’t dodge a miss', async () => {
    const { room, me } = startRun();
    await waitFor(room, 'reading');
    room.disconnect(me);
    await waitFor(room, 'tossupEnd');
    expect(lives(room)).toBe(2);
    room.join('Hao', room.s.players[0].token);
    expect(lives(room)).toBe(2);
  });

  it('giving up or walking away ends the run where it stands', async () => {
    const a = startRun();
    await buzzAt(a.room, a.me, 2, 'answer1');
    a.room.end(a.me);
    expect(a.done).toHaveLength(1);
    expect(a.done[0]).toMatchObject({ tossups: 1, correct: 1 });

    const b = startRun();
    await buzzAt(b.room, b.me, 2, 'answer1');
    b.room.next(b.me);
    await waitFor(b.room, 'reading');
    b.room.disconnect(b.me);
    b.room.recordIfUnfinished(); // idle room cleanup
    expect(b.done).toHaveLength(1);
    expect(b.done[0]).toMatchObject({ tossups: 1, correct: 1 });
    b.room.recordIfUnfinished();
    expect(b.done).toHaveLength(1);
  });

  it('locks everything that could change a score', async () => {
    const { room, me } = startRun();
    await buzzAt(room, me, 3, 'nope');
    const ruling = room.s.rulings[0].id;
    expect(() => room.updateSettings(me, { wpm: 100 })).toThrow('same settings');
    expect(() => room.adjust(me, me, 10)).toThrow('survival');
    expect(() => room.override(me, ruling)).toThrow('survival');
    expect(() => room.protest(me, ruling, 'it was right')).toThrow('survival');
    expect(() => room.setReader(me, me)).toThrow('no reader');
    expect(() => room.join('Friend')).toThrow('solo');
    expect(() => botsFor(room).add(me, 'easy')).toThrow('solo');
    expect(() => room.upload(me, [{ question: 'q', answer: 'a' }])).toThrow('same questions');
    room.next(me);
    await waitFor(room, 'reading');
    expect(() => room.pauseGame(me, true)).toThrow('paused');
    expect(() => room.setPaused(me, true)).toThrow('paused');
    expect(room.s.settings).toMatchObject({ mode: 'ffa', bonuses: false, topicVote: false });
  });

  it('asks for harder questions as the run goes on, and falls back to the built-in questions offline', async () => {
    expect(survivalDifficulties(1)).toEqual([2]);
    expect(survivalDifficulties(15)).toEqual([2, 3]);
    expect(survivalDifficulties(60)).toEqual([4, 5]);
    const { room, me, asked } = startRun();
    await waitFor(room, 'reading');
    expect(asked[0]).toEqual([2]);
    room.disconnect(me);

    const down: QuestionProvider = { nextTossup: async () => { throw new Error('offline'); }, nextBonus: async () => null };
    const off = new Room('OFFL', io, { qbreader: down });
    const p = off.join('Hao').playerId;
    off.makeSurvival('g:abcdef123456');
    off.start(p);
    await waitFor(off, 'reading');
    expect(off.s.tossup?.q.id).toBeTruthy();
    expect(off.s.tossup?.q.id.startsWith('sample-')).toBe(false); // the built-in catalog, not the old sample packet
  });

  it('comes back from a restart paused, with its lives and questions', async () => {
    const { room, me } = startRun();
    await buzzAt(room, me, 3, 'nope');
    room.next(me);
    await waitFor(room, 'reading');
    const saved = JSON.parse(JSON.stringify(room.toJSON()));
    room.dispose();
    const { p } = okProvider();
    const back = Room.restore(saved, io, { qbreader: p });
    expect(back.s.paused).toBe(true);
    expect(back.snapshot(null).survival).toMatchObject({ lives: 2, done: false, tossups: 1 });
    expect(() => back.updateSettings(me, { wpm: 100 })).toThrow('same settings');
    back.join('Hao', saved.players[0].token);
    back.pauseGame(me, false);
    await waitFor(back, 'tossupEnd');
    expect(back.snapshot(null).survival!.lives).toBe(1);
    back.next(me);
    await waitFor(back, 'reading');
    expect(back.s.seenTossups.size).toBe(3);
    back.dispose();
  });
});

describe('survival leaderboard', () => {
  const T = Date.parse('2026-11-18T15:00:00Z'); // a Wednesday
  const run = (key: string, correct: number, points: number, day: string, at = T): SurvivalRow => ({
    playerKey: key, name: key, day, correct, tossups: correct + 3, points, powers: 0, tens: correct, negs: 0, marks: '', createdAt: at,
  });

  it('starts weeks on Monday', () => {
    expect(weekStart('2026-11-18')).toBe('2026-11-16');
    expect(weekStart('2026-11-16')).toBe('2026-11-16');
    expect(weekStart('2026-11-22')).toBe('2026-11-16');
  });

  it('ranks each player by their best run: correct, then points, then who got there first', async () => {
    const s = new FileSurvivalStore(null);
    await s.addRun(run('a', 10, 100, '2026-11-10'));
    await s.addRun(run('a', 4, 40, '2026-11-17')); // a's worse run doesn't replace the best
    await s.addRun(run('b', 10, 120, '2026-11-11'));
    await s.addRun(run('c', 12, 90, '2026-11-12'));
    await s.addRun(run('d', 10, 100, '2026-11-12', T + 5)); // same as a, but later
    expect((await s.top(null, 10)).map((r) => r.playerKey)).toEqual(['c', 'b', 'a', 'd']);
    expect(await s.count(null)).toBe(4);
    expect(await s.rankOf((await s.best('a', null))!, null)).toBe(3);
    expect(await s.runs('a')).toBe(2);
  });

  it('this week’s board only counts runs since Monday', async () => {
    const s = new FileSurvivalStore(null);
    const sv = new Survival(s);
    await s.addRun(run('old', 30, 300, '2026-11-15')); // last Sunday
    await s.addRun(run('me', 20, 200, '2026-11-10'));
    await s.addRun(run('me', 5, 50, '2026-11-17'));
    await s.addRun(run('new', 8, 80, '2026-11-18'));
    const st = await sv.status('me', false, new Date('2026-11-19T15:00:00Z'));
    expect(st.weekStart).toBe('2026-11-16');
    expect(st.allTime.entries.map((e) => e.name)).toEqual(['old', 'me', 'new']);
    expect(st.week.entries.map((e) => e.name)).toEqual(['new', 'me']);
    expect(st.allTime.me).toMatchObject({ rank: 2, correct: 20 });
    expect(st.week.me).toMatchObject({ rank: 2, correct: 5 });
    expect(st.week.players).toBe(2);
    expect((await sv.status(null)).allTime.me).toBeNull();
  });

  it('records a finished run once per run and builds the profile', async () => {
    const s = new FileSurvivalStore(null);
    const sv = new Survival(s);
    sv.active.set('a:u1', 'ROOM');
    const o: SurvivalOutcome = { code: 'ROOM', playerKey: 'a:u1', playerId: 'p', name: 'Hao', tossups: 9, correct: 6, points: 70, powers: 2, tens: 4, negs: 1, marks: 'PPTTTTN-Z' };
    await sv.record(o, 'hao');
    expect(sv.active.has('a:u1')).toBe(false);
    await sv.record({ ...o, tossups: 0, correct: 0, marks: '' }); // ended before any tossup: not ranked
    const p = (await sv.profile('a:u1'))!;
    expect(p).toMatchObject({ runs: 1, rank: 1, players: 1, best: { correct: 6, tossups: 9, points: 70 } });
    expect((await s.top(null, 5))[0]).toMatchObject({ name: 'hao', username: 'hao' });
    expect(await sv.profile('nobody')).toBeNull();
  });
});

// The Postgres store runs too when TEST_DATABASE_URL points at a scratch database.
const pgUrl = process.env.TEST_DATABASE_URL;
const stores: [string, () => SurvivalStore][] = [['file', () => new FileSurvivalStore(null)]];
if (pgUrl) stores.push(['postgres', () => new PgSurvivalStore(pgUrl)]);
const opened: SurvivalStore[] = [];
afterAll(async () => { for (const s of opened) await (s as any).pool?.end(); });

describe.each(stores)('survival store (%s)', (_name, make) => {
  it('follows an account to its new username', async () => {
    const store = make();
    opened.push(store);
    await store.init();
    const key = `a:rename-${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const day = '0001-01-01'; // before every board's start, so it can't show up in other tests' boards
    await store.addRun({ playerKey: key, name: 'old_name', username: 'old_name', day, correct: 5, tossups: 8, points: 50, powers: 0, tens: 5, negs: 0, marks: '', createdAt: 1 });
    await store.rename(key, 'new_name');
    expect(await store.best(key, null)).toMatchObject({ name: 'new_name', username: 'new_name' });
  });

  it('keeps one best run per player on each board', async () => {
    const store = make();
    opened.push(store);
    await store.init();
    const tag = `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const t = 1_700_000_000_000;
    // A made-up year that only grows keeps these rows apart from earlier test runs in a shared database.
    const y = String(t + Date.now());
    const row = (key: string, correct: number, points: number, day: string, at: number): SurvivalRow =>
      ({ playerKey: `${tag}:${key}`, name: key, day, correct, tossups: correct + 3, points, powers: 0, tens: correct, negs: 0, marks: '', createdAt: at });
    await store.addRun(row('ann', 7, 70, `${y}-01-04`, t + 1));
    await store.addRun(row('ann', 9, 60, `${y}-01-01`, t + 2));
    await store.addRun(row('bob', 9, 60, `${y}-01-05`, t + 3));
    await store.addRun(row('cy', 3, 30, `${y}-01-06`, t + 4));
    const week = `${y}-01-04`;
    expect((await store.top(week, 10)).map((r) => r.name)).toEqual(['bob', 'ann', 'cy']);
    expect((await store.best(`${tag}:ann`, week))!.correct).toBe(7);
    expect((await store.best(`${tag}:ann`, null))!.correct).toBe(9);
    expect(await store.count(week)).toBe(3);
    expect(await store.rankOf((await store.best(`${tag}:bob`, null))!, `${y}-01-01`)).toBe(2); // ann's 9 came first
    expect(await store.rankOf((await store.best(`${tag}:ann`, week))!, week)).toBe(2);
    expect(await store.runs(`${tag}:ann`)).toBe(2);
  });
});
