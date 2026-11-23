import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Accounts } from '../src/server/accounts/accounts';
import { FileAccountStore } from '../src/server/accounts/store';
import { cleanCustomTitle, cleanGrantedTitles, titleName, titleOptions } from '../src/shared/profile';
import { Room, type RoomIO } from '../src/server/rooms/room';

describe('title rules', () => {
  it('keeps granted titles to known special ones and tidy custom text', () => {
    expect(cleanGrantedTitles(['special:vip', 'special:nope', 'custom:  Quiz   Legend ', 'custom:', 'special:vip', 'badge:debut', 42])).toEqual(['special:vip', 'custom:Quiz Legend']);
    expect(cleanCustomTitle('x'.repeat(40))).toHaveLength(24);
    expect(cleanCustomTitle('Bad\u0007Title\n')).toBe('BadTitle');
  });

  it('offers granted titles first, then one per earned badge, and resolves only titles still owned', () => {
    const opts = titleOptions(['special:developer', 'custom:Founder'], new Set(['debut', 'firstPower']));
    expect(opts.map((o) => `${o.from}:${o.name}`)).toEqual(['special:Developer', 'custom:Founder', 'badge:Debut', 'badge:First power']);
    expect(titleName('special:developer', ['special:developer'], new Set())).toBe('Developer');
    expect(titleName('special:vip', ['special:developer'], new Set())).toBeNull(); // not given
    expect(titleName('badge:champion', [], new Set(['debut']))).toBeNull(); // not earned
    expect(titleName(null, ['special:vip'], new Set())).toBeNull();
  });
});

describe('titles over the API', () => {
  let server: Server;
  let base: string;
  let dir: string;
  let accounts: Accounts;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bb-titles-'));
    accounts = new Accounts(new FileAccountStore(join(dir, 'accounts.json')));
    await accounts.init();
    const app = express();
    app.use(express.json());
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
    return res.headers.get('set-cookie')!.split(';')[0];
  };
  const profile = async (u: string, cookie?: string) => (await (await req('GET', `/users/${u}`, undefined, cookie)).json()).profile;

  it('lets an admin give titles, the player equip one, and shows it on the profile', async () => {
    const hao = await signup('Hao');
    const mia = await signup('mia');
    expect((await req('POST', '/admin/users/mia/titles', { titles: ['special:vip'] }, mia)).status).toBe(403); // not an admin
    const r = await (await req('POST', '/admin/users/mia/titles', { titles: ['special:vip', 'special:early-tester', 'custom:Quiz Legend'] }, hao)).json();
    expect(r.titles).toEqual(['special:vip', 'special:early-tester', 'custom:Quiz Legend']);

    const t = await (await req('GET', '/me/titles', undefined, mia)).json();
    expect(t.options.map((o: { name: string }) => o.name)).toEqual(['VIP', 'Early Tester', 'Quiz Legend']);
    expect(t.equipped).toBeNull();

    expect((await req('PATCH', '/me', { title: 'special:developer' }, mia)).status).toBe(403); // not given to her
    const ok = await (await req('PATCH', '/me', { title: 'custom:Quiz Legend' }, mia)).json();
    expect(ok.user.title).toBe('custom:Quiz Legend');
    expect((await profile('mia')).title).toBe('Quiz Legend');
    expect((await profile('mia')).grantedTitles).toBeUndefined(); // only admins see the list
    expect((await profile('mia', hao)).grantedTitles).toEqual(['special:vip', 'special:early-tester', 'custom:Quiz Legend']);

    // Taking the title away takes it off too.
    await req('POST', '/admin/users/mia/titles', { titles: ['special:vip'] }, hao);
    expect((await profile('mia')).title).toBeNull();
    // And a player can always go back to none.
    await req('PATCH', '/me', { title: 'special:vip' }, mia);
    expect((await profile('mia')).title).toBe('VIP');
    await req('PATCH', '/me', { title: null }, mia);
    expect((await profile('mia')).title).toBeNull();
  });

  it('admins can title themselves, and give or take individual badges (which unlock their titles)', async () => {
    const hao = (await req('POST', '/login', { username: 'Hao', password: 'long-enough-pw' })).headers.get('set-cookie')!.split(';')[0];
    await req('POST', '/admin/users/Hao/titles', { titles: ['special:developer'] }, hao);
    await req('PATCH', '/me', { title: 'special:developer' }, hao);
    expect((await profile('Hao')).title).toBe('Developer');

    const zed = await signup('zed');
    expect((await req('PATCH', '/me', { title: 'badge:champion' }, zed)).status).toBe(403); // not earned
    const g = await (await req('POST', '/admin/users/zed/badges', { badges: ['champion', 'notABadge'] }, hao)).json();
    expect(g.grantedBadges).toEqual(['champion']);
    expect((await req('PATCH', '/me', { title: 'badge:champion' }, zed)).status).toBe(200);
    expect((await profile('zed')).title).toBe('Champion');
    expect((await profile('zed', hao)).grantedBadges).toEqual(['champion']);
    // Taking the badge back takes its title off.
    await req('POST', '/admin/users/zed/badges', { badges: [] }, hao);
    expect((await profile('zed')).title).toBeNull();
    // The old all-or-nothing switch still works.
    expect((await (await req('POST', '/admin/users/zed/badges', { unlock: true }, hao)).json()).unlocked).toBe(true);
  });
});

describe('titles in rooms', () => {
  it('shows the equipped title next to the player and follows the account on rejoin', () => {
    const io: RoomIO = { emitEach: () => {}, emitTo: () => {} };
    const room = new Room('TTL1', io);
    const a = room.join('Ann', undefined, { id: 'acct-ann', username: 'ann', title: 'VIP' });
    room.join('Guest');
    const players = room.snapshot(a.playerId).players;
    expect(players.find((p) => p.name === 'Ann')?.title).toBe('VIP');
    expect(players.find((p) => p.name === 'Guest')?.title).toBeUndefined();
    room.join('Ann', a.token, { id: 'acct-ann', username: 'ann' }); // took the title off, then reconnected
    expect(room.snapshot(a.playerId).players.find((p) => p.name === 'Ann')?.title).toBeUndefined();
    room.dispose();
  });
});
