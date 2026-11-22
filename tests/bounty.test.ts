import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room, TIMING, bountyRandom, type RoomIO } from '../src/server/rooms/room';
import type { QuestionProvider, Tossup } from '../src/server/questions/types';

const io: RoomIO = { emitEach: () => {}, emitTo: () => {} };
const flush = () => vi.advanceTimersByTimeAsync(0);

// 10 words, power mark after word 4.
function provider(): QuestionProvider {
  let n = 0;
  return {
    nextTossup: async () => ({ id: `t${++n}`, category: 'Science', subcategory: '', question: 'w1 w2 w3 w4 (*) w5 w6 w7 w8 w9 w10', answer: '<b><u>alpha</u></b>' }) satisfies Tossup,
    nextBonus: async () => null,
  };
}

async function setup(settings: Record<string, unknown> = { bounty: true }) {
  const room = new Room('BNTY', io, { qbreader: provider() });
  const ids = ['Ann', 'Bob'].map((n) => room.join(n).playerId);
  room.updateSettings(ids[0], { wpm: 600, ...settings });
  room.start(ids[0]);
  await flush();
  return { room, ids };
}

async function readTo(room: Room, count: number) {
  while ((room.s.tossup?.revealed ?? 0) < count) await vi.advanceTimersByTimeAsync(20);
}

/** Let tossups go dead and move on until tossup `num` is up. */
async function goTo(room: Room, by: string, num: number) {
  while (room.s.tossup!.num < num) {
    while (room.s.phase === 'reading') await vi.advanceTimersByTimeAsync(200);
    room.next(by);
    await flush();
  }
}

async function answer(room: Room, by: string, atWord: number, text: string) {
  await readTo(room, atWord);
  room.buzz(by, atWord);
  await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
  room.submitAnswer(by, text);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('bounty tossups', () => {
  it('spaces bounties out: never the first, at least 3 apart', async () => {
    vi.spyOn(bountyRandom, 'next').mockReturnValue(0); // every eligible tossup would be a bounty
    const { room, ids } = await setup();
    const bounties: number[] = [];
    for (let n = 1; n <= 12; n++) {
      await goTo(room, ids[0], n);
      if (room.snapshot(ids[1]).tossup!.bounty) bounties.push(n);
    }
    expect(bounties).toEqual([4, 8, 12]);
    room.dispose();
  });

  it('always has one within 8 tossups of the last, even on bad luck', async () => {
    vi.spyOn(bountyRandom, 'next').mockReturnValue(0.99);
    const { room, ids } = await setup();
    const bounties: number[] = [];
    for (let n = 1; n <= 16; n++) {
      await goTo(room, ids[0], n);
      if (room.s.tossup!.bounty) bounties.push(n);
    }
    expect(bounties).toEqual([8, 16]);
    room.dispose();
  });

  it('doubles a power and a ten, but not a neg, and shows it before the first word', async () => {
    vi.spyOn(bountyRandom, 'next').mockReturnValue(0);
    const { room, ids } = await setup();
    await goTo(room, ids[0], 4);
    expect(room.s.tossup!.revealed).toBe(0);
    expect(room.snapshot(ids[0]).tossup!.bounty).toBe(true);
    await answer(room, ids[1], 2, 'beta'); // neg
    await answer(room, ids[0], 3, 'alpha'); // power
    expect(room.s.rulings.slice(-2).map((r) => [r.kind, r.points, r.bounty])).toEqual([['neg', -5, true], ['power', 30, true]]);
    expect(room.s.review[0].bounty).toBe(true);
    await goTo(room, ids[0], 8);
    await answer(room, ids[0], 8, 'alpha'); // after the power mark: a ten
    expect(room.s.rulings.at(-1)).toMatchObject({ kind: 'ten', points: 20, bounty: true });
    room.dispose();
  });

  it('keeps the double when a ruling is overturned', async () => {
    vi.spyOn(bountyRandom, 'next').mockReturnValue(0);
    const { room, ids } = await setup();
    await goTo(room, ids[0], 4);
    await answer(room, ids[0], 2, 'gamma'); // ruled wrong: neg
    const neg = room.s.rulings.at(-1)!;
    expect(neg.points).toBe(-5);
    room.override(ids[0], neg.id); // the host rules it correct after all
    expect(room.s.rulings.find((r) => r.id === neg.id)).toMatchObject({ correct: true, kind: 'power', points: 30 });
    room.dispose();
  });

  it('plain tossups score normally, and nothing is a bounty with the option off', async () => {
    vi.spyOn(bountyRandom, 'next').mockReturnValue(0);
    const { room, ids } = await setup({ bounty: false });
    for (let n = 1; n <= 9; n++) {
      await goTo(room, ids[0], n);
      expect(room.snapshot(ids[0]).tossup!.bounty).toBeUndefined();
    }
    await answer(room, ids[0], 3, 'alpha');
    expect(room.s.rulings.at(-1)).toMatchObject({ kind: 'power', points: 15 });
    expect(room.s.rulings.at(-1)!.bounty).toBeUndefined();
    room.dispose();
  });

  it('turning it on mid-game announces it in chat', async () => {
    const { room, ids } = await setup({ bounty: false });
    room.updateSettings(ids[0], { bounty: true });
    expect(room.s.chat.at(-1)?.text).toMatch(/bounty tossups on/);
    room.dispose();
  });
});
