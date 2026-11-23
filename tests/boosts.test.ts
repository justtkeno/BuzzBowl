import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Accounts } from '../src/server/accounts/accounts';
import { FileAccountStore } from '../src/server/accounts/store';
import { BoostError, Boosts, FileBoostStore } from '../src/server/boosts/boosts';
import type { GameRecord } from '../src/shared/accounts';
import { xpForGame, xpParts } from '../src/shared/levels';

const game = (over: Partial<GameRecord> = {}): GameRecord => ({
  at: Date.now(), room: 'TEST', mode: 'ffa', sides: 1, rank: 1, standings: [], tossups: 20,
  points: 100, powers: 2, tens: 7, negs: 1, buzzes: 10, heard: 20, correctDepthSum: 5,
  bestStreak: 3, bonusPoints: 30, bonusesHeard: 5, categories: {}, ...over,
});

describe('XP boosts', () => {
  it('multiplies a game saved with a boost', () => {
    expect(xpForGame(game())).toBe(83);
    expect(xpForGame(game({ xpBoost: 2 }))).toBe(166);
    expect(xpForGame(game({ xpBoost: 1.5 }))).toBe(83 + 42);
    expect(xpParts(game({ xpBoost: 3 })).at(-1)).toEqual({ label: '3× XP boost', xp: 166 });
  });

  it('starts, picks the biggest that applies, ends, and checks its input', async () => {
    const b = new Boosts(new FileBoostStore(null));
    await b.ready;
    expect(b.multiplierFor('a1')).toBe(1);
    expect(b.viewFor(null)).toBeNull();
    const all = await b.start({ multiplier: 2, minutes: 60 }, null);
    await b.start({ multiplier: 5, minutes: 10 }, { id: 'a1', username: 'amy' });
    expect(b.multiplierFor('a1')).toBe(5);
    expect(b.multiplierFor('b2')).toBe(2);
    expect(b.multiplierFor(null)).toBe(2);
    expect(b.viewFor('a1')).toMatchObject({ multiplier: 5, personal: true });
    expect(b.viewFor('b2')).toMatchObject({ multiplier: 2, personal: false });
    // Personal boosts end on their own.
    expect(b.multiplierFor('a1', Date.now() + 11 * 60_000)).toBe(2);
    await b.end(all.id);
    expect(b.multiplierFor('b2')).toBe(1);
    expect(b.active()).toHaveLength(1);
    for (const bad of [{ multiplier: 1, minutes: 10 }, { multiplier: 11, minutes: 10 }, { multiplier: 2, minutes: 0 }, { multiplier: 2, minutes: 99_999 }, { multiplier: 'x', minutes: 10 }]) {
      await expect(b.start(bad, null)).rejects.toBeInstanceOf(BoostError);
    }
  });

  it('keeps boosts across a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-boosts-'));
    try {
      const file = join(dir, 'boosts.json');
      const one = new Boosts(new FileBoostStore(file));
      await one.ready;
      await one.start({ multiplier: 3, minutes: 30 }, null);
      const two = new Boosts(new FileBoostStore(file));
      await two.ready;
      expect(two.multiplierFor('anyone')).toBe(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('gives boosted XP when a game is recorded, and keeps it when the total is worked out again', async () => {
    const accounts = new Accounts(new FileAccountStore(null));
    await accounts.init();
    const store = (accounts as any).store as FileAccountStore;
    await store.createUser({ id: 'u1', username: 'booster', key: 'booster', passwordHash: 'x', displayName: 'B', bio: '', settings: null, createdAt: 0, xp: 0 } as any);
    accounts.boostFor = (id) => (id === 'u1' ? 2 : 1);
    const [g] = await accounts.record([{ accountId: 'u1', game: game() }]);
    expect(g).toMatchObject({ gained: 166, boost: 2 });
    accounts.boostFor = () => 1;
    expect((await accounts.record([{ accountId: 'u1', game: game() }]))[0].gained).toBe(83);
    // Back to earned: the saved boost still counts.
    await store.setXp('u1', null);
    expect(await accounts.xpOf((await store.userById('u1'))!)).toBe(249);
  });
});
