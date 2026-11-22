import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Stats, daysBefore, modeLabel } from '../src/server/stats/stats';
import { FileStatsStore } from '../src/server/stats/store';
import { Room, TIMING, type RoomIO } from '../src/server/rooms/room';
import type { GameSummary } from '../src/shared/stats';
import type { QuestionProvider, Tossup } from '../src/server/questions/types';

const game = (day: string, over: Partial<GameSummary> = {}): GameSummary => ({
  at: Date.parse(`${day}T18:00:00Z`), day, kind: 'room', mode: 'ffa', party: false, source: 'qbreader', players: 3, bots: 0,
  reader: false, tossups: 12, bonuses: 0, bounty: false, length: 0, abandoned: false, ...over,
});

describe('owner stats', () => {
  it('counts each device once a day, and once across a week', async () => {
    const stats = new Stats(new FileStatsStore(null));
    const day1 = new Date('2026-11-20T18:00:00Z'), day2 = new Date('2026-11-21T18:00:00Z');
    await stats.visit('g:aaa', day1); await stats.visit('g:aaa', day1); await stats.visit('g:bbb', day1);
    await stats.visit('g:aaa', day2); await stats.visit(null, day2);
    const v = await stats.view(day2, 3);
    expect(v.days.map((d) => d.visitors)).toEqual([0, 2, 1]);
    expect(v.last7.visitors).toBe(2); // aaa came both days but counts once
  });

  it('adds up games, players and modes over 7 and 30 days', async () => {
    const stats = new Stats(new FileStatsStore(null));
    const now = new Date('2026-11-22T18:00:00Z');
    await stats.recordGame(game('2026-11-22', { players: 4 }));
    await stats.recordGame(game('2026-11-22', { kind: 'daily', players: 1 }));
    await stats.recordGame(game('2026-11-18', { mode: 'teams', players: 8, bots: 1 }));
    await stats.recordGame(game('2026-11-01', { party: true, players: 5, abandoned: true }));
    await stats.recordGame(game('2026-09-01')); // too old for the 30-day numbers
    const v = await stats.view(now);
    expect(v.today).toMatchObject({ day: '2026-11-22', games: 2, players: 5 });
    expect(v.last7).toMatchObject({ games: 3, players: 13 });
    expect(v.last30).toMatchObject({ games: 4, players: 18, finished: 3, abandoned: 1, avgPlayers: 4.5, withBots: 1 });
    expect(v.modes.map((m) => m.label).sort()).toEqual(['Daily challenge', 'Free-for-all', 'Party', 'Teams']);
    expect(v.allTime.games).toBe(5);
    expect(v.days).toHaveLength(14);
    expect(v.days.at(-1)!.day).toBe('2026-11-22');
  });

  it('names modes the way the owner thinks of them', () => {
    expect(modeLabel(game('d', { players: 1 }))).toBe('Solo practice');
    expect(modeLabel(game('d', { players: 1, bots: 2 }))).toBe('Solo with bots');
    expect(modeLabel(game('d', { source: 'lightning' }))).toBe('Lightning round');
    expect(modeLabel(game('d', { kind: 'survival' }))).toBe('Survival');
    expect(modeLabel(game('d', { reader: true, mode: 'teams' }))).toBe('Teams with a reader');
    expect(daysBefore('2026-03-01', 1)).toBe('2026-02-28');
  });
});

describe('rooms report a summary when a game ends', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends one anonymous summary per game', async () => {
    const summaries: GameSummary[] = [];
    const io: RoomIO = { emitEach: () => {}, emitTo: () => {}, gameSummary: (g) => summaries.push(g) };
    let n = 0;
    const provider: QuestionProvider = {
      nextTossup: async () => ({ id: `t${++n}`, category: 'Science', subcategory: '', question: 'w1 w2 (*) w3 w4', answer: '<b><u>alpha</u></b>' }) satisfies Tossup,
      nextBonus: async () => null,
    };
    const room = new Room('STAT', io, { qbreader: provider });
    const [ann, bob] = ['Ann', 'Bob'].map((x) => room.join(x).playerId);
    room.updateSettings(ann, { wpm: 600, gameLength: 2, bounty: true });
    room.start(ann);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 2; i++) {
      while ((room.s.tossup?.revealed ?? 0) < 1) await vi.advanceTimersByTimeAsync(20);
      room.buzz(bob, room.s.tossup!.revealed);
      await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
      room.submitAnswer(bob, 'alpha');
      room.next(ann);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(room.s.phase).toBe('gameOver');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ kind: 'room', mode: 'ffa', tossups: 2, length: 2, bounty: true, abandoned: false, bots: 0 });
    expect(summaries[0].players).toBe(2);
    expect(JSON.stringify(summaries[0])).not.toMatch(/Ann|Bob/); // no names
    room.dispose();
  });
});
