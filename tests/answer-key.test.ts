import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room, TIMING, type RoomIO } from '../src/server/rooms/room';
import type { QuestionProvider, Tossup } from '../src/server/questions/types';

const TOSSUP: Tossup = {
  id: 't1', category: 'Science', subcategory: 'Biology',
  question: 'w1 w2 w3 w4 (*) w5 w6 w7 w8 w9 w10',
  answer: '<b><u>mitochondria</u></b> [or <b>mitochondrion</b>; prompt on <b>organelle</b>; do not accept <b>nucleus</b>]',
};
const provider = (): QuestionProvider => {
  let n = 0;
  return { nextTossup: async () => ({ ...TOSSUP, id: `t${++n}` }), nextBonus: async () => null };
};
const io: RoomIO = { emitEach: () => {}, emitTo: () => {} };

describe('why was I wrong', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('explains your own misses once the tossup ends, and nobody else’s', async () => {
    const room = new Room('TEST', io, { qbreader: provider() });
    const ann = room.join('Ann').playerId;
    const bob = room.join('Bob').playerId;
    room.updateSettings(ann, { wpm: 600 });
    room.start(ann);
    await vi.advanceTimersByTimeAsync(0);
    while ((room.s.tossup?.revealed ?? 0) < 3) await vi.advanceTimersByTimeAsync(20);
    room.buzz(ann, 3);
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    // Not ended yet: no key for anyone (it would give the answer away).
    expect(room.snapshot(bob).tossup?.answerKey).toBeUndefined();
    room.submitAnswer(ann, 'nucleus');
    while (!room.s.tossup?.ended) await vi.advanceTimersByTimeAsync(200);
    const key = room.snapshot(ann).tossup!.answerKey!;
    expect(key.accept).toEqual(['mitochondria', 'mitochondrion']);
    expect(key.prompt).toEqual(['organelle']);
    expect(key.reject).toEqual(['nucleus']);
    expect(key.misses).toEqual([{ given: 'nucleus', why: 'rejected' }]);
    expect(room.snapshot(bob).tossup!.answerKey!.misses).toEqual([]);
  });
});
