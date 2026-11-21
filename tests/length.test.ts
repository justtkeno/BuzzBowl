import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room, TIMING, type RoomIO } from '../src/server/rooms/room';
import type { QuestionProvider, Tossup, Bonus } from '../src/server/questions/types';

const io: RoomIO = { emitEach: () => {}, emitTo: () => {} };
const flush = () => vi.advanceTimersByTimeAsync(0);

function provider(): QuestionProvider {
  let n = 0;
  return {
    nextTossup: async (f) => ({ id: `t${++n}`, category: f.categories[0] ?? 'Science', subcategory: '', question: 'w1 w2 (*) w3 w4', answer: '<b><u>alpha</u></b>' }) satisfies Tossup,
    nextBonus: async () => ({ id: `b${++n}`, category: 'Science', subcategory: '', leadin: 'For 10 points each:', parts: ['one', 'two', 'three'], answers: ['<b><u>a</u></b>', '<b><u>b</u></b>', '<b><u>c</u></b>'] }) satisfies Bonus,
  };
}

async function setup(settings: Record<string, unknown>, players = ['Ann', 'Bob']) {
  const room = new Room('LEN1', io, { qbreader: provider() });
  const ids = players.map((n) => room.join(n).playerId);
  room.updateSettings(ids[0], { wpm: 600, ...settings });
  room.start(ids[0]);
  await flush();
  return { room, ids };
}

/** Let the current tossup go dead (nobody buzzes). */
async function deadTossup(room: Room) {
  while (room.s.phase === 'reading' || room.s.phase === 'loading') await vi.advanceTimersByTimeAsync(200);
}

/** Get the current tossup right so it ends with a winner. */
async function convert(room: Room, by: string) {
  while ((room.s.tossup?.revealed ?? 0) < 1) await vi.advanceTimersByTimeAsync(20);
  room.buzz(by, room.s.tossup!.revealed);
  await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
  room.submitAnswer(by, 'alpha');
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('game length', () => {
  it('ends the game when moving on after the last tossup', async () => {
    const { room, ids } = await setup({ gameLength: 3 });
    for (let i = 1; i <= 3; i++) {
      expect(room.s.tossup!.num).toBe(i);
      await deadTossup(room);
      expect(room.s.phase).toBe('tossupEnd');
      room.next(ids[1]); // no reader: anyone can move on
      await flush();
    }
    expect(room.s.phase).toBe('gameOver');
    expect(room.s.tossupNum).toBe(3);
    expect(room.s.chat.at(-1)?.text).toBe('Game over.');
    room.dispose();
  });

  it('plays the bonus earned on the last tossup before ending', async () => {
    const { room, ids } = await setup({ gameLength: 1, mode: 'teams' });
    await convert(room, ids[0]);
    expect(room.s.tossup!.bonusTeam).toBeTruthy();
    room.next(ids[0]);
    await flush();
    expect(room.s.phase).toBe('bonus');
    room.next(ids[0]); // the host skips the bonus
    await flush();
    expect(room.s.phase).toBe('gameOver');
    room.dispose();
  });

  it('with party votes, skips the vote after the last tossup', async () => {
    const { room, ids } = await setup({ gameLength: 2, topicVote: true });
    await deadTossup(room);
    expect(room.s.vote).toBeTruthy();
    room.next(ids[0]); // start now
    await flush();
    expect(room.s.tossup!.num).toBe(2);
    await deadTossup(room);
    expect(room.s.vote).toBeFalsy();
    await vi.advanceTimersByTimeAsync(TIMING.voteMs * 2);
    expect(room.s.phase).toBe('tossupEnd'); // waits for Finish
    room.next(ids[1]);
    await flush();
    expect(room.s.phase).toBe('gameOver');
    room.dispose();
  });

  it('can be shortened or lengthened mid-game, and 0 means no limit', async () => {
    const { room, ids } = await setup({ gameLength: 10, topicVote: true });
    await deadTossup(room);
    await deadTossup(room); // vote open after tossup 1
    room.updateSettings(ids[0], { gameLength: 1 }); // now this was the last one: the vote goes away
    expect(room.s.vote).toBeNull();
    expect(room.s.chat.at(-1)?.text).toMatch(/game length to 1 tossups/);
    room.updateSettings(ids[0], { gameLength: 0 });
    expect(room.s.chat.at(-1)?.text).toMatch(/no limit/);
    room.next(ids[0]);
    await flush();
    expect(room.s.phase).toBe('reading');
    expect(room.s.tossup!.num).toBe(2);
    room.updateSettings(ids[0], { gameLength: 9999 });
    expect(room.s.settings.gameLength).toBe(500);
    room.dispose();
  });

  it('starting again after game over plays a fresh set of the same length', async () => {
    const { room, ids } = await setup({ gameLength: 1 });
    await deadTossup(room);
    room.next(ids[0]);
    await flush();
    expect(room.s.phase).toBe('gameOver');
    room.start(ids[0]);
    await flush();
    expect(room.s.phase).toBe('reading');
    expect(room.s.tossup!.num).toBe(1);
    room.dispose();
  });

  it('does not apply to the daily challenge', async () => {
    const room = new Room('DAY2', io);
    const { playerId } = room.join('Ann');
    room.makeDaily({ day: '2026-11-21', number: 1, playerKey: 'k' }, [1, 2].map((i) => ({ id: `d${i}`, category: 'Science', subcategory: '', question: 'w1 w2 w3', answer: '<b><u>alpha</u></b>' })));
    expect(() => room.updateSettings(playerId, { gameLength: 1 })).toThrow();
    expect(room.s.settings.gameLength).toBe(0);
    room.dispose();
  });
});
