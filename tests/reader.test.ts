import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room, type RoomIO } from '../src/server/rooms/room';
import type { QuestionProvider } from '../src/server/questions/types';

function provider(): QuestionProvider {
  let n = 0;
  return {
    nextTossup: async (_f, seen) => {
      const id = `t${++n}`;
      if (seen.has(id)) throw new Error('repeat');
      return { id, category: 'Science', subcategory: 'Biology', question: `Question ${id} has words (*) and ends here`, answer: `<b><u>answer ${id}</u></b>` };
    },
    nextBonus: async () => null,
  };
}
const io: RoomIO = { emitEach: () => {}, emitTo: () => {} };
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function setup() {
  const room = new Room('READ', io, { qbreader: provider() });
  const reader = room.join('Rae').playerId;
  const player = room.join('Pat').playerId;
  room.setReader(reader, reader);
  await flush();
  return { room, reader, player };
}

describe('reader look-ahead', () => {
  it('shows the reader the next 3 tossups, and nobody else', async () => {
    const { room, reader, player } = await setup();
    expect(room.snapshot(reader).upcoming?.map((q) => q.id)).toEqual(['t1', 't2', 't3']);
    expect(room.snapshot(reader).upcoming?.[0].text).toContain('(*)');
    expect(room.snapshot(player).upcoming).toBeUndefined();
  });

  it('reads the queue in order and keeps it topped up', async () => {
    const { room, reader } = await setup();
    room.start(reader);
    await flush();
    expect(room.s.tossup?.q.id).toBe('t1');
    expect(room.snapshot(reader).upcoming?.map((q) => q.id)).toEqual(['t2', 't3', 't4']);
  });

  it('skipping an upcoming tossup replaces it, and it never comes back', async () => {
    const { room, reader, player } = await setup();
    expect(() => room.skipUpcoming(player, 't2')).toThrow('Only the reader');
    room.skipUpcoming(reader, 't2');
    await flush();
    expect(room.snapshot(reader).upcoming?.map((q) => q.id)).toEqual(['t1', 't3', 't4']);
    room.start(reader);
    await flush();
    room.next(reader); // skip t1 mid-read
    await flush();
    room.next(reader); // load the next one
    await flush();
    expect(room.s.tossup?.q.id).toBe('t3');
    expect(room.s.seenTossups.has('t2')).toBe(true);
  });

  it('changing filters swaps in a fresh queue and frees the unread questions', async () => {
    const { room, reader } = await setup();
    room.updateSettings(reader, { filters: { categories: ['History'], subcategories: [], difficulties: [] } });
    await flush();
    expect(room.snapshot(reader).upcoming?.map((q) => q.id)).toEqual(['t4', 't5', 't6']);
    expect(room.s.seenTossups.has('t1')).toBe(false);
  });

  it('the reader can end the match from mid-game', async () => {
    const { room, reader } = await setup();
    room.start(reader);
    await flush();
    room.end(reader);
    expect(room.s.phase).toBe('gameOver');
  });
});
