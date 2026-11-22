import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room, type RoomIO } from '../src/server/rooms/room';
import type { QuestionProvider, Tossup } from '../src/server/questions/types';

const io: RoomIO = { emitEach: () => {}, emitTo: () => {} };
const tu = (i: number): Tossup => ({
  id: `r${i}`, category: 'Science', subcategory: 'Biology',
  question: 'one two three four five six (*) seven eight nine ten eleven twelve', answer: '<b><u>mitochondria</u></b> [do not accept <b>nucleus</b>]',
});
const provider = (): QuestionProvider => {
  let n = 0;
  return { nextTossup: async () => tu(++n), nextBonus: async () => ({ id: `b${n}`, leadin: 'Lead.', parts: ['a', 'b', 'c'], answers: ['<b>x</b>', '<b>y</b>', '<b>z</b>'], category: 'Science', subcategory: 'Biology' }) };
};
const waitFor = async (room: Room, phase: string) => { for (let i = 0; i < 400 && room.s.phase !== phase; i++) await vi.advanceTimersByTimeAsync(20); };
const readTo = async (room: Room, n: number) => { while ((room.s.tossup?.revealed ?? 0) < n) await vi.advanceTimersByTimeAsync(20); };
const points = (room: Room, id: string) => room.snapshot(id).players.find((p) => p.id === id)!.stats.points;

/** Pat negs at word 2, then Quinn gets it at word 3. */
async function negThenCorrect(settings: Record<string, unknown> = {}) {
  const room = new Room('RULE', io, { qbreader: provider() });
  const host = room.join('Host').playerId;
  const pat = room.join('Pat').playerId;
  const quinn = room.join('Quinn').playerId;
  room.updateSettings(host, { wpm: 600, readerRules: false, ...settings });
  return { room, host, pat, quinn };
}

describe('reversing a ruling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function play(room: Room, host: string, pat: string, quinn: string) {
    room.start(host);
    await waitFor(room, 'reading');
    await readTo(room, 2);
    room.buzz(pat, 2);
    await waitFor(room, 'buzz');
    room.submitAnswer(pat, 'nucleus');
    await waitFor(room, 'reading');
    await readTo(room, 3);
    room.buzz(quinn, 3);
    await waitFor(room, 'buzz');
    room.submitAnswer(quinn, 'mitochondria');
    await waitFor(room, 'tossupEnd');
  }

  it('an upheld protest scores the first buzz and cancels the later one, and reversing again restores it', async () => {
    const { room, host, pat, quinn } = await negThenCorrect();
    await play(room, host, pat, quinn);
    expect([points(room, pat), points(room, quinn)]).toEqual([-5, 15]);
    const neg = room.s.rulings.find((r) => r.playerId === pat)!;
    room.protest(pat, neg.id, 'should count');
    room.resolveProtest(host, room.s.protests[0].id, true);
    // Only one answer scores on a tossup: Pat's power now, Quinn's later answer is cancelled to 0.
    expect([points(room, pat), points(room, quinn)]).toEqual([15, 0]);
    const q = room.s.rulings.find((r) => r.playerId === quinn)!;
    expect(q).toMatchObject({ correct: false, points: 0, kind: 'zero', voidedBy: neg.id });
    expect(room.snapshot(host).tossup!.buzzes.map((b) => b.result)).toEqual(['power', 'zero']);
    // The host changes their mind: Pat is wrong again, Quinn gets the points back.
    room.override(host, neg.id);
    expect([points(room, pat), points(room, quinn)]).toEqual([-5, 15]);
    expect(room.s.rulings.find((r) => r.playerId === quinn)).toMatchObject({ correct: true, points: 15, voidedBy: undefined });
  });

  it('gives the bonus to the team whose buzz now counts', async () => {
    const { room, host, pat, quinn } = await negThenCorrect({ mode: 'teams', bonuses: true });
    const [a, b] = room.s.teams;
    room.joinTeam(pat, a.id);
    room.joinTeam(quinn, b.id);
    room.joinTeam(host, b.id);
    await play(room, host, pat, quinn);
    expect(room.s.tossup!.bonusTeam).toBe(b.id);
    room.override(host, room.s.rulings.find((r) => r.playerId === pat)!.id);
    expect(room.s.tossup!.bonusTeam).toBe(a.id);
    room.override(host, room.s.rulings.find((r) => r.playerId === pat)!.id);
    expect(room.s.tossup!.bonusTeam).toBe(b.id);
  });

  it('overriding a lone wrong answer still just flips it', async () => {
    const { room, host, pat } = await negThenCorrect();
    room.start(host);
    await waitFor(room, 'reading');
    await readTo(room, 2);
    room.buzz(pat, 2);
    await waitFor(room, 'buzz');
    room.submitAnswer(pat, 'nucleus');
    room.override(host, room.s.rulings[0].id);
    expect(points(room, pat)).toBe(15);
    room.override(host, room.s.rulings[0].id);
    expect(points(room, pat)).toBe(-5);
  });
});

describe('daily challenge', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('refuses protests', async () => {
    const room = new Room('DAY', io, {});
    const me = room.join('Solo').playerId;
    room.makeDaily({ day: '2026-11-21', number: 3, playerKey: 'g:abcdef123456' }, [tu(1), tu(2)]);
    room.start(me);
    await waitFor(room, 'reading');
    await readTo(room, 2);
    room.buzz(me, 2);
    await waitFor(room, 'buzz');
    room.submitAnswer(me, 'nucleus');
    expect(() => room.protest(me, room.s.rulings[0].id, 'x')).toThrow(/daily/);
    expect(room.s.protests).toHaveLength(0);
  });
});
