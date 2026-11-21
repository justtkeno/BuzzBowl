import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Accounts, hashPassword, verifyPassword } from '../src/server/accounts/accounts';
import { FileAccountStore } from '../src/server/accounts/store';
import { Room, TIMING, type RoomIO } from '../src/server/rooms/room';
import { summarize, type GameRecord } from '../src/shared/accounts';
import type { QuestionProvider, Tossup } from '../src/server/questions/types';

const game = (over: Partial<GameRecord> = {}): GameRecord => ({
  at: Date.now(), room: 'TEST', mode: 'ffa', sides: 2, rank: 1, standings: [], tossups: 20,
  points: 100, powers: 2, tens: 7, negs: 1, buzzes: 10, heard: 20, correctDepthSum: 9 * 0.6,
  bestStreak: 3, bonusPoints: 0, bonusesHeard: 0,
  categories: { Science: { heard: 12, points: 70, powers: 2, tens: 4, negs: 0 }, History: { heard: 8, points: 30, powers: 0, tens: 3, negs: 1 } },
  ...over,
});

describe('passwords', () => {
  it('verifies the right password only', async () => {
    const h = await hashPassword('correct horse');
    expect(h).toMatch(/^scrypt\$/);
    expect(await verifyPassword('correct horse', h)).toBe(true);
    expect(await verifyPassword('wrong horse', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('summarize', () => {
  it('totals games, counts wins only against others, and ranks subjects', () => {
    const s = summarize([game(), game({ rank: 2 }), game({ sides: 1, rank: 1 })]);
    expect(s.totals).toMatchObject({ games: 3, competitive: 2, wins: 1, points: 300, powers: 6 });
    expect(s.totals.avgCorrectDepth).toBeCloseTo(0.6);
    expect(s.subjects.map((x) => x.category)).toEqual(['Science', 'History']);
    expect(s.bestSubject).toBe('Science');
    expect(s.subjects[0].ppth).toBeCloseTo(210 / 36);
  });

  it('does not crown a best subject from a handful of tossups', () => {
    const s = summarize([game({ categories: { Science: { heard: 3, points: 30, powers: 0, tens: 3, negs: 0 } } })]);
    expect(s.bestSubject).toBeNull();
  });
});

describe('HTTP API', () => {
  let server: Server;
  let base: string;
  let dir: string;
  let accounts: Accounts;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bb-accounts-'));
    accounts = new Accounts(new FileAccountStore(join(dir, 'accounts.json')));
    await accounts.init();
    const app = express();
    app.use('/api', accounts.router());
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as { port: number }).port}/api`;
  });
  afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  const post = (path: string, body: unknown, cookie?: string) =>
    fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0];

  it('signs up, stays logged in with the cookie, and logs out', async () => {
    const res = await post('/signup', { username: 'Alice_1', password: 'hunter2hunter2', displayName: 'Alice' });
    expect(res.status).toBe(200);
    const cookie = cookieOf(res);
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    const me = await (await fetch(`${base}/me`, { headers: { cookie } })).json();
    expect(me.user).toMatchObject({ username: 'Alice_1', displayName: 'Alice' });
    expect(me.user.passwordHash).toBeUndefined();
    await post('/logout', {}, cookie);
    expect((await (await fetch(`${base}/me`, { headers: { cookie } })).json()).user).toBeNull();
  });

  it('rejects taken usernames (any case), short passwords and bad logins', async () => {
    expect((await post('/signup', { username: 'alice_1', password: 'longenough' })).status).toBe(409);
    expect((await post('/signup', { username: 'bob', password: 'short' })).status).toBe(400);
    expect((await post('/signup', { username: 'no spaces', password: 'longenough' })).status).toBe(400);
    expect((await post('/login', { username: 'Alice_1', password: 'nope-nope' })).status).toBe(401);
    expect((await post('/login', { username: 'ALICE_1', password: 'hunter2hunter2' })).status).toBe(200);
  });

  it('serves a public profile with recorded games', async () => {
    const res = await post('/login', { username: 'alice_1', password: 'hunter2hunter2' });
    const id = (await res.json()).user.id;
    accounts.record([{ accountId: id, game: game() }]);
    await new Promise((r) => setTimeout(r, 10));
    const { profile } = await (await fetch(`${base}/users/alice_1`)).json();
    expect(profile).toMatchObject({ username: 'Alice_1', displayName: 'Alice', bestSubject: 'Science' });
    expect(profile.totals.games).toBe(1);
    expect(profile.recent).toHaveLength(1);
    expect((await fetch(`${base}/users/nobody`)).status).toBe(404);
  });

  it('updates display name and bio', async () => {
    const cookie = cookieOf(await post('/login', { username: 'alice_1', password: 'hunter2hunter2' }));
    const res = await fetch(`${base}/me`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ displayName: 'Al', bio: 'Science main' }) });
    expect((await res.json()).user).toMatchObject({ displayName: 'Al', bio: 'Science main' });
    expect((await fetch(`${base}/me`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
  });
});

// ---------- rooms report results for logged-in players ----------

const TOSSUP: Tossup = { id: 't1', category: 'Science', subcategory: 'Biology', question: 'w1 w2 w3 w4 (*) w5 w6 w7 w8 w9 w10', answer: '<b><u>mitochondria</u></b>' };
const provider = (): QuestionProvider => {
  let n = 0;
  return { nextTossup: async () => ({ ...TOSSUP, id: `t${++n}` }), nextBonus: async () => null };
};

describe('game results', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('records each logged-in player once at game over, with rank and subjects', async () => {
    const records: { accountId: string; game: GameRecord }[] = [];
    const io: RoomIO = { emitEach: () => {}, emitTo: () => {}, gameOver: (r) => records.push(...r) };
    const room = new Room('TEST', io, { qbreader: provider() });
    const ann = room.join('Ann', undefined, { id: 'acct-ann', username: 'ann' }).playerId;
    room.join('Guest');
    room.updateSettings(ann, { wpm: 600 });
    room.start(ann);
    await vi.advanceTimersByTimeAsync(0);
    while ((room.s.tossup?.revealed ?? 0) < 3) await vi.advanceTimersByTimeAsync(20);
    room.buzz(ann, 3);
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    room.submitAnswer(ann, 'mitochondria');
    room.end(ann);
    room.end(ann); // ending twice doesn't double-count
    expect(records).toHaveLength(1);
    expect(records[0].accountId).toBe('acct-ann');
    expect(records[0].game).toMatchObject({ sides: 2, rank: 1, points: 15, powers: 1, heard: 1 });
    expect(records[0].game.categories.Science).toMatchObject({ heard: 1, powers: 1 });
    expect(records[0].game.standings[0]).toMatchObject({ name: 'Ann', you: true });
    expect(room.snapshot(ann).players.find((p) => p.id === ann)?.username).toBe('ann');
  });

  it('gives a logged-in player their seat back from another device', () => {
    const room = new Room('TEST', { emitEach: () => {}, emitTo: () => {} }, { qbreader: provider() });
    const a = room.join('Ann', undefined, { id: 'acct-ann', username: 'ann' });
    const b = room.join('Ann on phone', undefined, { id: 'acct-ann', username: 'ann' });
    expect(b.playerId).toBe(a.playerId);
    // Someone else's account can't take the seat with a copied token.
    const c = room.join('Bob', a.token, { id: 'acct-bob', username: 'bob' });
    expect(c.playerId).not.toBe(a.playerId);
  });
});

describe('admins', () => {
  it('lets a logged-in admin take the host seat, and nobody else', () => {
    const room = new Room('TEST', { emitEach: () => {}, emitTo: () => {} }, { qbreader: provider() });
    const host = room.join('Host').playerId;
    const guest = room.join('Guest').playerId;
    const admin = room.join('Hao', undefined, { id: 'acct-hao', username: 'Hao', admin: true });
    expect(() => room.claimHost(guest)).toThrow(/admins/);
    expect(room.s.hostId).toBe(host);
    room.claimHost(admin.playerId);
    expect(room.s.hostId).toBe(admin.playerId);
    expect(room.snapshot(guest).players.find((p) => p.id === admin.playerId)?.admin).toBe(true);
    // Rejoining with the seat token while logged out drops the admin powers.
    room.join('Hao', admin.token);
    expect(room.snapshot(guest).players.find((p) => p.id === admin.playerId)?.admin).toBeUndefined();
  });
});

describe('admin moderation API', () => {
  let server: Server;
  let base: string;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bb-admin-'));
    const accounts = new Accounts(new FileAccountStore(join(dir, 'accounts.json')));
    await accounts.init();
    const app = express();
    app.use('/api', accounts.router());
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as { port: number }).port}/api`;
  });
  afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  const req = (method: string, path: string, body?: unknown, cookie?: string) =>
    fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const signup = async (username: string, extra: Record<string, unknown> = {}) => {
    const res = await req('POST', '/signup', { username, password: 'long-enough-pw', ...extra });
    return { cookie: res.headers.get('set-cookie')!.split(';')[0], user: (await res.json()).user };
  };

  it('marks the admin account and lets only it reset or delete other accounts', async () => {
    const hao = await signup('Hao');
    const troll = await signup('troll', { displayName: 'Rude Name' });
    expect(hao.user.admin).toBe(true);
    expect(troll.user.admin).toBe(false);
    expect((await (await fetch(`${base}/users/hao`)).json()).profile.admin).toBe(true);

    expect((await req('POST', '/admin/users/troll/reset', {}, troll.cookie)).status).toBe(403);
    expect((await req('POST', '/admin/users/hao/reset', {}, hao.cookie)).status).toBe(400);

    await req('PATCH', '/me', { bio: 'bad bio' }, troll.cookie);
    expect((await req('POST', '/admin/users/troll/reset', { bio: false }, hao.cookie)).status).toBe(200);
    let p = (await (await fetch(`${base}/users/troll`)).json()).profile;
    expect(p).toMatchObject({ displayName: 'troll', bio: 'bad bio' });

    expect((await req('DELETE', '/admin/users/troll', undefined, troll.cookie)).status).toBe(403);
    expect((await req('DELETE', '/admin/users/troll', undefined, hao.cookie)).status).toBe(200);
    expect((await fetch(`${base}/users/troll`)).status).toBe(404);
    // The deleted account's session is gone too.
    expect((await (await fetch(`${base}/me`, { headers: { cookie: troll.cookie } })).json()).user).toBeNull();
  });
});

describe('friends API', () => {
  let server: Server;
  let base: string;
  let dir: string;
  let accounts: Accounts;
  let where = new Map<string, import('../src/server/accounts/accounts').Presence>();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bb-friends-'));
    accounts = new Accounts(new FileAccountStore(join(dir, 'accounts.json')));
    await accounts.init();
    accounts.presence = (ids) => new Map([...where].filter(([id]) => ids.includes(id)));
    const app = express();
    app.use('/api', accounts.router());
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as { port: number }).port}/api`;
  });
  afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  const req = (method: string, path: string, body?: unknown, cookie?: string) =>
    fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const signup = async (username: string) => {
    const res = await req('POST', '/signup', { username, password: 'long-enough-pw' });
    return { cookie: res.headers.get('set-cookie')!.split(';')[0], user: (await res.json()).user };
  };
  const list = async (cookie: string) => (await req('GET', '/friends', undefined, cookie)).json();

  it('needs a login and a real username that isn’t yours', async () => {
    expect((await req('GET', '/friends')).status).toBe(401);
    const me = await signup('solo_sam');
    expect((await req('POST', '/friends', { username: 'nobody_here' }, me.cookie)).status).toBe(404);
    expect((await req('POST', '/friends', { username: 'SOLO_SAM' }, me.cookie)).status).toBe(400);
  });

  it('sends a request, accepts it, shows where friends are, and unfriends', async () => {
    const amy = await signup('amy');
    const ben = await signup('ben');
    // Amy asks (with an @ and different case); Ben sees it waiting.
    const sent = await (await req('POST', '/friends', { username: '@BEN' }, amy.cookie)).json();
    expect(sent.outgoing.map((r: any) => r.username)).toEqual(['ben']);
    expect(sent.friends).toEqual([]);
    expect((await list(ben.cookie)).incoming.map((r: any) => r.username)).toEqual(['amy']);
    // Presence is hidden until they're friends.
    where = new Map([[amy.user.id, { status: 'room', room: { code: 'ABCD', phase: 'lobby', mode: 'ffa', players: 2 } }]]);
    expect((await list(ben.cookie)).friends).toEqual([]);
    // Ben accepts by adding her back.
    const accepted = await (await req('POST', '/friends', { username: 'amy' }, ben.cookie)).json();
    expect(accepted.incoming).toEqual([]);
    expect(accepted.friends).toEqual([{ username: 'amy', displayName: 'amy', admin: false, status: 'room', room: { code: 'ABCD', phase: 'lobby', mode: 'ffa', players: 2 } }]);
    expect((await list(amy.cookie)).friends).toMatchObject([{ username: 'ben', status: 'offline' }]);
    expect((await list(amy.cookie)).friends[0].room).toBeUndefined();
    // Asking again changes nothing.
    expect((await (await req('POST', '/friends', { username: 'ben' }, amy.cookie)).json()).friends).toHaveLength(1);
    // Either side can unfriend.
    expect((await (await req('DELETE', '/friends/AMY', undefined, ben.cookie)).json()).friends).toEqual([]);
    expect((await list(amy.cookie)).friends).toEqual([]);
    where = new Map();
  });

  it('lets the other side decline, and the sender cancel', async () => {
    const cal = await signup('cal');
    const dee = await signup('dee');
    await req('POST', '/friends', { username: 'dee' }, cal.cookie);
    expect((await (await req('DELETE', '/friends/cal', undefined, dee.cookie)).json()).incoming).toEqual([]);
    expect((await list(cal.cookie)).outgoing).toEqual([]);
    await req('POST', '/friends', { username: 'dee' }, cal.cookie);
    expect((await (await req('DELETE', '/friends/dee', undefined, cal.cookie)).json()).outgoing).toEqual([]);
    expect((await list(dee.cookie)).incoming).toEqual([]);
  });

  it('drops friend links when an account is deleted', async () => {
    const store = new FileAccountStore(null);
    await store.requestFriend('a', 'b', 1);
    await store.acceptFriend('a', 'b');
    await store.requestFriend('c', 'a', 2);
    await store.deleteUser('a');
    expect(await store.friendLinks('b')).toEqual([]);
    expect(await store.friendLinks('c')).toEqual([]);
  });
});
