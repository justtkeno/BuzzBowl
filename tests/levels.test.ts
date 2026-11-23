import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Accounts, jpegSize } from '../src/server/accounts/accounts';
import { FileAccountStore } from '../src/server/accounts/store';
import type { GameRecord } from '../src/shared/accounts';
import { LEVEL_TITLES, MAX_LEVEL, levelFor, titleFor, unlockedBetween, xpAtLevel, xpForGame, xpParts, xpToNext } from '../src/shared/levels';
import { AVATAR_FRAMES, PROFILE_COLORS, isUnlocked, lookFor } from '../src/shared/profile';

const game = (over: Partial<GameRecord> = {}): GameRecord => ({
  at: Date.now(), room: 'TEST', mode: 'ffa', sides: 2, rank: 1, standings: [], tossups: 20,
  points: 100, powers: 2, tens: 7, negs: 1, buzzes: 10, heard: 20, correctDepthSum: 5,
  bestStreak: 3, bonusPoints: 30, bonusesHeard: 5, categories: {}, ...over,
});

/** A minimal JPEG: just the markers the server reads. */
function fakeJpeg(width: number, height: number, pad = 2000) {
  const head = Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
  ]);
  return Buffer.concat([head, Buffer.alloc(pad, 0x55), Buffer.from([0xff, 0xd9])]);
}

describe('XP', () => {
  it('pays for tossups, gets, bonuses, a win and the daily', () => {
    // 20 heard ×2 = 40, 2 powers ×6 = 12, 7 tens ×4 = 28, 30 bonus points → 3, full win 25
    expect(xpForGame(game())).toBe(40 + 12 + 28 + 3 + 25);
    expect(xpForGame(game({ rank: 2 }))).toBe(83);
    expect(xpForGame(game({ rank: 3, sides: 4 }))).toBe(93);
    expect(xpForGame(game({ sides: 1, daily: 12 }))).toBe(83 + 30);
    expect(xpParts(game()).map((p) => p.label)).toContain('Win');
  });

  it('scales a win in short games, skips it when abandoned, and caps marathon games', () => {
    const short = game({ heard: 5, powers: 0, tens: 0, bonusPoints: 0 });
    expect(xpForGame(short)).toBe(10 + Math.round(25 * 5 / 20));
    expect(xpForGame(game({ abandoned: true }))).toBe(83);
    expect(xpForGame(game({ heard: 500, powers: 0, tens: 0, bonusPoints: 0, sides: 1 }))).toBe(120);
    expect(xpForGame(game({ heard: 0, powers: 0, tens: 0, bonusPoints: 0, sides: 1 }))).toBe(0);
  });
});

describe('levels', () => {
  it('starts at 1 and needs 25 more XP each level', () => {
    expect(levelFor(0)).toMatchObject({ level: 1, into: 0, need: 100, title: 'Rookie' });
    expect(levelFor(99).level).toBe(1);
    expect(levelFor(100)).toMatchObject({ level: 2, into: 0, need: 125 });
    expect(levelFor(xpAtLevel(10) + 5)).toMatchObject({ level: 10, into: 5, need: xpToNext(10), title: 'Scholar' });
    expect(levelFor(1e9)).toMatchObject({ level: MAX_LEVEL, need: 0 });
    for (let l = 1; l < 30; l++) expect(levelFor(xpAtLevel(l)).level).toBe(l);
  });

  it('names titles and unlocks between two levels', () => {
    expect(titleFor(4)).toBe('Rookie');
    expect(titleFor(52)).toBe('Legend');
    expect(LEVEL_TITLES.map((t) => t.level)).toEqual([...LEVEL_TITLES.map((t) => t.level)].sort((a, b) => a - b));
    const rewards = [...PROFILE_COLORS.map((r) => ({ ...r, kind: 'color' })), ...AVATAR_FRAMES.map((r) => ({ ...r, kind: 'frame' }))];
    expect(unlockedBetween(2, 5, rewards)).toEqual(['Buzzer title', 'Mint color', 'Bronze ring frame']);
    expect(unlockedBetween(5, 5, rewards)).toEqual([]);
  });

  it('locks level rewards until the level, and shows the default after', () => {
    const mint = PROFILE_COLORS.find((c) => c.id === 'mint')!;
    expect(isUnlocked(mint, new Set(), 2)).toBe(false);
    expect(isUnlocked(mint, new Set(), 3)).toBe(true);
    expect(lookFor({ color: 'mint', frame: 'bronze', xp: 0 }, new Set())).toMatchObject({ color: 'orange', frame: 'none', level: 1 });
    expect(lookFor({ color: 'mint', frame: 'bronze', xp: xpAtLevel(5) }, new Set())).toMatchObject({ color: 'mint', frame: 'bronze', level: 5 });
    // An admin who unlocked every badge for someone unlocks the level rewards too.
    expect(lookFor({ color: 'lime', xp: 0, grantedBadges: ['debut'] }, new Set(['debut'])).color).toBe('lime');
    // Every reward is unlocked one way or another, except the defaults.
    for (const r of [...PROFILE_COLORS, ...AVATAR_FRAMES]) expect(!!r.badge !== !!r.level || (!r.badge && !r.level)).toBe(true);
  });
});

describe('JPEG check', () => {
  it('reads the size of a JPEG and rejects anything else', () => {
    expect(jpegSize(fakeJpeg(256, 200))).toEqual({ width: 256, height: 200 });
    expect(jpegSize(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(jpegSize(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
  });
});

describe('profile pictures and XP over HTTP', () => {
  let server: Server;
  let base: string;
  let dir: string;
  let accounts: Accounts;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bb-levels-'));
    accounts = new Accounts(new FileAccountStore(join(dir, 'accounts.json')));
    await accounts.init();
    const app = express();
    app.use('/api', accounts.router());
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as { port: number }).port}/api`;
  });
  afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  const signup = async (username: string) => {
    const res = await fetch(`${base}/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'longenough1' }) });
    return { cookie: res.headers.get('set-cookie')!.split(';')[0], user: (await res.json()).user };
  };
  const put = (cookie: string | null, body: Buffer, type = 'image/jpeg') =>
    fetch(`${base}/me/avatar`, { method: 'PUT', headers: { 'Content-Type': type, ...(cookie ? { cookie } : {}) }, body });

  it('uploads, serves, replaces and removes a picture', async () => {
    const { cookie } = await signup('pic_user');
    expect((await put(null, fakeJpeg(256, 256))).status).toBe(401);
    expect((await put(cookie, Buffer.from('not an image'))).status).toBe(400);
    expect((await put(cookie, fakeJpeg(8, 8))).status).toBe(400);
    expect((await put(cookie, fakeJpeg(4000, 4000))).status).toBe(400);
    expect((await put(cookie, fakeJpeg(256, 256, 300 * 1024))).status).toBe(413);
    expect((await put(cookie, fakeJpeg(256, 256), 'image/png')).status).toBe(400);

    const ok = await put(cookie, fakeJpeg(256, 256));
    expect(ok.status).toBe(200);
    const { user } = await ok.json();
    expect(user.pic).toMatch(/^\/api\/avatar\/pic_user\?v=/);
    const img = await fetch(base.replace(/\/api$/, '') + user.pic);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/jpeg');
    expect(img.headers.get('cache-control')).toMatch(/immutable/);
    expect(Buffer.from(await img.arrayBuffer()).equals(fakeJpeg(256, 256))).toBe(true);

    const { profile } = await (await fetch(`${base}/users/pic_user`)).json();
    expect(profile.pic).toBe(user.pic);

    const gone = await (await fetch(`${base}/me/avatar`, { method: 'DELETE', headers: { cookie } })).json();
    expect(gone.user.pic).toBeUndefined();
    expect((await fetch(`${base}/avatar/pic_user`)).status).toBe(404);
  });

  it('adds XP for recorded games, reports level-ups, and checks level rewards', async () => {
    const { cookie, user } = await signup('xp_user');
    expect(user.level).toBe(1);
    const gains = await accounts.record([{ accountId: user.id, game: game() }, { accountId: user.id, game: game({ rank: 2 }) }]);
    expect(gains).toHaveLength(1);
    expect(gains[0]).toMatchObject({ gained: 108 + 83, before: { level: 1 }, after: { level: 2 } });
    const { profile } = await (await fetch(`${base}/users/xp_user`)).json();
    expect(profile.levelInfo).toMatchObject({ level: 2, xp: 191 });
    expect(profile.level).toBe(2);

    const patch = (body: unknown) => fetch(`${base}/me`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body) });
    const no = await patch({ color: 'mint' });
    expect(no.status).toBe(403);
    expect((await no.json()).error).toMatch(/level 3/);
    await accounts.record([{ accountId: user.id, game: game({ heard: 60, powers: 10, tens: 10 }) }]);
    expect((await patch({ color: 'mint' })).status).toBe(200);
  });

  it('works out XP from games saved before levels existed', async () => {
    const { user } = await signup('old_user');
    const store = (accounts as any).store as FileAccountStore;
    await store.addGames([{ userId: user.id, game: game() }, { userId: user.id, game: game() }]);
    // As if the account came from before levels: no total yet.
    (store as any).d.users.find((u: any) => u.id === user.id).xp = null;
    const { profile } = await (await fetch(`${base}/users/old_user`)).json();
    expect(profile.levelInfo.xp).toBe(216);
    // The next game adds to that total instead of counting everything again.
    const [g] = await accounts.record([{ accountId: user.id, game: game() }]);
    expect(g.after.xp).toBe(324);
  });
});
