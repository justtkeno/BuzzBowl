import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room, type RoomIO } from '../src/server/rooms/room';
import { botRandom, botsFor, PROFILES } from '../src/server/rooms/bots';
import type { QuestionProvider } from '../src/server/questions/types';

const ANSWER = '<b><u>mitochondria</u></b> [prompt on <u>organelle</u>s]';
const provider = (): QuestionProvider => {
  let n = 0;
  return {
    nextTossup: async () => ({ id: `t${++n}`, category: 'Science', subcategory: 'Biology', question: 'w1 w2 w3 w4 w5 w6 (*) w7 w8 w9 w10 w11 w12', answer: ANSWER }),
    nextBonus: async () => ({ id: `b${++n}`, category: 'Science', subcategory: 'Biology', leadin: 'For 10 points each:', parts: ['p1', 'p2', 'p3'], answers: ['<b><u>alpha</u></b>', '<b><u>beta</u></b>', '<b><u>gamma</u></b>'] }),
  };
};
const io: RoomIO = { emitEach: () => {}, emitTo: () => {} };

/** Advance time while ticking the bots the way the server does. */
async function play(room: Room, ms: number) {
  for (let t = 0; t < ms; t += 100) { botsFor(room).tick(); await vi.advanceTimersByTimeAsync(100); }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { botRandom.next = () => Math.random(); vi.useRealTimers(); });

describe('bots', () => {
  it('only the host can add bots, and bots never become host', () => {
    const room = new Room('BOTS', io, { qbreader: provider() });
    const host = room.join('Hao').playerId;
    const guest = room.join('Sam').playerId;
    expect(() => botsFor(room).add(guest, 'easy')).toThrow('Only the host');
    const { playerId: bot } = botsFor(room).add(host, 'expert');
    expect(room.s.players.find((p) => p.id === bot)?.bot).toBe('expert');
    room.disconnect(host);
    expect(room.s.hostId).toBe(guest);
    room.disconnect(guest);
    expect(room.s.hostId).not.toBe(bot);
    expect(room.connectedCount()).toBe(0); // bots alone don't keep a room alive
  });

  it('a bot that knows the answer buzzes and scores', async () => {
    botRandom.next = () => 0.01; // knows it, buzzes at the early end of its range, no typo
    const room = new Room('BOTS', io, { qbreader: provider() });
    const host = room.join('Hao').playerId;
    const { playerId: bot } = botsFor(room).add(host, 'hard');
    room.updateSettings(host, { wpm: 600 });
    room.start(host);
    await play(room, 8000);
    const r = room.s.rulings.find((x) => x.playerId === bot);
    expect(r?.correct).toBe(true);
    expect(r?.given).toMatch(/^m\w+a$/); // "mitochondria", or a forgiven typo of it
  });

  it('a bot that does not know sits out or negs, and can be changed and removed', async () => {
    botRandom.next = () => 0.99; // never knows, never reckless, never guesses late
    const room = new Room('BOTS', io, { qbreader: provider() });
    const host = room.join('Hao').playerId;
    const { playerId: bot } = botsFor(room).add(host, 'easy');
    room.updateSettings(host, { wpm: 600, deadSeconds: 1 });
    room.start(host);
    await play(room, 6000);
    expect(room.s.rulings.some((x) => x.playerId === bot)).toBe(false);
    botsFor(room).setSkill(host, bot, 'medium');
    expect(room.s.players.find((p) => p.id === bot)?.bot).toBe('medium');
    botsFor(room).remove(host, bot);
    expect(room.s.players.some((p) => p.id === bot)).toBe(false);
  });

  it('a bot captain answers its team’s bonus', async () => {
    botRandom.next = () => 0.01;
    const room = new Room('BOTS', io, { qbreader: provider() });
    const host = room.join('Hao').playerId;
    room.updateSettings(host, { mode: 'teams', wpm: 600 });
    const { playerId: bot } = botsFor(room).add(host, 'expert');
    const botTeam = room.s.players.find((p) => p.id === bot)!.teamId!;
    expect(botTeam).not.toBe(room.s.players.find((p) => p.id === host)!.teamId);
    room.start(host);
    await play(room, 8000);
    expect(room.s.phase).toBe('tossupEnd');
    room.next(host); // bonus for the bot's team
    await play(room, 30000);
    const parts = room.s.rulings.filter((x) => x.type === 'bonus' && x.teamId === botTeam);
    expect(parts.map((x) => x.given)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('skill levels get stronger', () => {
    const order = ['easy', 'medium', 'hard', 'expert'] as const;
    for (let i = 1; i < order.length; i++) {
      expect(PROFILES[order[i]].knows).toBeGreaterThan(PROFILES[order[i - 1]].knows);
      expect(PROFILES[order[i]].depth[0]).toBeLessThan(PROFILES[order[i - 1]].depth[0]);
    }
  });
});
