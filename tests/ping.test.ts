import { describe, expect, it } from 'vitest';
import { Room, type RoomIO } from '../src/server/rooms/room';
import { pingQuality } from '../src/shared/types';
import type { QuestionProvider } from '../src/server/questions/types';

const provider: QuestionProvider = { nextTossup: async () => null, nextBonus: async () => null };

describe('ping', () => {
  it('rates a round trip', () => {
    expect(pingQuality(40)).toBe('good');
    expect(pingQuality(99)).toBe('good');
    expect(pingQuality(100)).toBe('ok');
    expect(pingQuality(249)).toBe('ok');
    expect(pingQuality(250)).toBe('bad');
  });

  it('shows a smoothed ping for online people and only broadcasts when the quality changes', () => {
    let sent = 0;
    const io: RoomIO = { emitEach: () => { sent++; }, emitTo: () => {} };
    const room = new Room('PING', io, { qbreader: provider });
    const ann = room.join('Ann').playerId;
    const bob = room.join('Bob').playerId;
    const ping = (id: string) => room.snapshot(ann).players.find((p) => p.id === id)?.ping;

    expect(ping(ann)).toBeUndefined();
    sent = 0;
    room.setPing(ann, 40);
    expect(ping(ann)).toBe(40);
    expect(sent).toBe(1);
    // Still good: smoothed, no broadcast.
    room.setPing(ann, 60);
    expect(ping(ann)).toBe(48);
    expect(sent).toBe(1);
    // A big jump makes it ok: broadcast.
    room.setPing(ann, 400);
    expect(ping(ann)).toBe(189);
    expect(sent).toBe(2);
    // Junk is ignored.
    room.setPing(ann, -5);
    room.setPing(ann, NaN);
    room.setPing('nobody', 10);
    expect(ping(ann)).toBe(189);

    room.setPing(bob, 30);
    expect(ping(bob)).toBe(30);
    room.disconnect(bob);
    expect(ping(bob)).toBeUndefined();
  });
});
