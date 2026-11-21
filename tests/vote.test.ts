import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room, TIMING, type RoomIO } from '../src/server/rooms/room';
import type { Filters } from '../src/shared/types';
import type { QuestionProvider, Tossup } from '../src/server/questions/types';

const io: RoomIO = { emitEach: () => {}, emitTo: () => {} };
const flush = () => vi.advanceTimersByTimeAsync(0);

/** Hands out a tossup in whatever category was asked for, and remembers each request's filters. */
function recordingProvider(empty: string[] = []) {
  const asked: Filters[] = [];
  let n = 0;
  const provider: QuestionProvider = {
    nextTossup: async (f) => {
      asked.push(structuredClone(f));
      const category = f.categories[0] ?? 'Science';
      if (empty.includes(category)) return null;
      return { id: `t${++n}`, category, subcategory: '', question: 'w1 w2 (*) w3 w4', answer: '<b><u>alpha</u></b>' } satisfies Tossup;
    },
    nextBonus: async () => null,
  };
  return { provider, asked };
}

async function setup(opts: { players?: string[]; empty?: string[]; filters?: Partial<Filters> } = {}) {
  const { provider, asked } = recordingProvider(opts.empty);
  const room = new Room('VOTE', io, { qbreader: provider });
  const ids = (opts.players ?? ['Ann', 'Bob']).map((n) => room.join(n).playerId);
  room.updateSettings(ids[0], { wpm: 600, topicVote: true, readAloud: true, ...(opts.filters ? { filters: { categories: [], subcategories: [], difficulties: [], ...opts.filters } } : {}) });
  room.start(ids[0]);
  await flush();
  return { room, ids, asked };
}

/** Answer the current tossup correctly so it ends. */
async function finishTossup(room: Room, by: string) {
  while ((room.s.tossup?.revealed ?? 0) < 1) await vi.advanceTimersByTimeAsync(20);
  room.buzz(by, room.s.tossup!.revealed);
  await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
  room.submitAnswer(by, 'alpha');
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('topic vote', () => {
  it('opens after a tossup with three different categories, avoiding the one just played', async () => {
    const { room, ids } = await setup();
    await finishTossup(room, ids[0]);
    expect(room.s.phase).toBe('tossupEnd');
    const v = room.snapshot(ids[0]).vote!;
    expect(v.options).toHaveLength(3);
    expect(new Set(v.options).size).toBe(3);
    expect(v.options).not.toContain('Science');
    expect(v).toMatchObject({ voters: 2, voted: 0, mine: null });
    room.dispose();
  });

  it('starts the next tossup in the winning category once everyone has voted', async () => {
    const { room, ids, asked } = await setup();
    await finishTossup(room, ids[0]);
    const [a, b] = room.s.vote!.options;
    room.castVote(ids[0], b);
    expect(room.snapshot(ids[0]).vote).toMatchObject({ mine: b, voted: 1, counts: { [b]: 1 } });
    expect(room.snapshot(ids[1]).vote!.mine).toBeNull();
    room.castVote(ids[1], b);
    await flush();
    expect(room.s.vote).toBeNull();
    expect(room.s.tossup!.q.category).toBe(b);
    expect(asked.at(-1)!.categories).toEqual([b]);
    expect(room.s.settings.filters.categories).toEqual([]); // the room's own filters are untouched
    expect(a).not.toBe(b);
    room.dispose();
  });

  it('closes when time runs out, going with the votes that came in', async () => {
    const { room, ids } = await setup();
    await finishTossup(room, ids[0]);
    const pick = room.s.vote!.options[2];
    room.castVote(ids[1], pick);
    await vi.advanceTimersByTimeAsync(TIMING.voteMs - 100);
    expect(room.s.phase).toBe('tossupEnd');
    await vi.advanceTimersByTimeAsync(200);
    expect(room.s.tossup!.q.category).toBe(pick);
    room.dispose();
  });

  it('lets anyone start right away with Next, and players can change their vote', async () => {
    const { room, ids } = await setup();
    await finishTossup(room, ids[0]);
    const [a, b] = room.s.vote!.options;
    room.castVote(ids[1], a);
    room.castVote(ids[1], b);
    expect(room.snapshot(ids[1]).vote!.counts).toMatchObject({ [a]: 0, [b]: 1 });
    room.next(ids[1]);
    await flush();
    expect(room.s.tossup!.q.category).toBe(b);
    room.dispose();
  });

  it('rejects topics that are not on the ballot and votes from the reader', async () => {
    const { room, ids } = await setup({ players: ['Ann', 'Bob', 'Cy'] });
    await finishTossup(room, ids[0]);
    const off = ['Science', 'Literature', 'History', 'Fine Arts'].find((c) => !room.s.vote!.options.includes(c))!;
    expect(() => room.castVote(ids[0], off)).toThrow(/ballot/);
    room.end(ids[0]);
    room.setReader(ids[2], ids[2]);
    room.start(ids[2]);
    await flush();
    expect(room.s.tossup).toBeTruthy();
    await finishTossup(room, ids[0]);
    room.rule(ids[2], 'correct'); // the reader rules on answers
    expect(room.s.phase).toBe('tossupEnd');
    expect(room.s.vote).toBeFalsy(); // a reader runs the game, so no vote
    expect(() => room.castVote(ids[0], 'Science')).toThrow(/no vote/);
    room.dispose();
  });

  it('only offers the categories the room is filtered to, and skips the vote when there is just one', async () => {
    const { room, ids } = await setup({ filters: { categories: ['History', 'Geography'] } });
    await finishTossup(room, ids[0]);
    expect([...room.s.vote!.options].sort()).toEqual(['Geography', 'History']);
    room.end(ids[0]);
    room.updateSettings(ids[0], { filters: { categories: ['History'], subcategories: [], difficulties: [] } });
    room.start(ids[0]);
    await flush();
    await finishTossup(room, ids[0]);
    expect(room.s.vote).toBeFalsy();
    room.dispose();
  });

  it('falls back to the room filters when the voted category has nothing left', async () => {
    const { room, ids, asked } = await setup({ players: ['Ann'], empty: ['History', 'Geography', 'Literature', 'Mythology', 'Philosophy', 'Religion', 'Fine Arts', 'Social Science', 'Current Events', 'Other Academic', 'Pop Culture'] });
    await finishTossup(room, ids[0]);
    const pick = room.s.vote!.options[0];
    room.castVote(ids[0], pick); // solo: the only vote closes it
    await flush();
    expect(asked.at(-2)!.categories).toEqual([pick]);
    expect(asked.at(-1)!.categories).toEqual([]);
    expect(room.s.phase).toBe('reading');
    room.dispose();
  });

  it('freezes the vote clock while the game is paused', async () => {
    const { room, ids } = await setup();
    await finishTossup(room, ids[0]);
    const before = room.s.vote!.deadline;
    room.pauseGame(ids[0], true);
    await vi.advanceTimersByTimeAsync(TIMING.voteMs * 2);
    expect(room.s.vote).toBeTruthy();
    expect(() => room.castVote(ids[0], room.s.vote!.options[0])).toThrow(/paused/);
    room.pauseGame(ids[0], false);
    expect(room.s.vote!.deadline).toBeGreaterThan(before);
    await vi.advanceTimersByTimeAsync(TIMING.voteMs + 50);
    expect(room.s.vote).toBeNull();
    expect(room.s.phase).toBe('reading');
    room.dispose();
  });

  it('switching the vote off mid-vote leaves the room waiting for Next', async () => {
    const { room, ids } = await setup();
    await finishTossup(room, ids[0]);
    room.updateSettings(ids[0], { topicVote: false });
    expect(room.s.vote).toBeNull();
    await vi.advanceTimersByTimeAsync(TIMING.voteMs * 2);
    expect(room.s.phase).toBe('tossupEnd');
    room.dispose();
  });

  it('never runs in the daily challenge', async () => {
    const room = new Room('DAY1', io);
    const { playerId } = room.join('Ann');
    const tossups: Tossup[] = [1, 2].map((i) => ({ id: `d${i}`, category: 'Science', subcategory: '', question: 'w1 w2 w3', answer: '<b><u>alpha</u></b>' }));
    room.makeDaily({ day: '2026-11-21', number: 1, playerKey: 'k' }, tossups);
    expect(() => room.updateSettings(playerId, { topicVote: true })).toThrow();
    expect(room.s.settings.topicVote).toBe(false);
    expect(room.s.settings.readAloud).toBe(false);
    room.dispose();
  });
});
