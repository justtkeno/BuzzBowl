import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Accounts, hashPassword, verifyPassword } from '../src/server/accounts/accounts';
import type { Mail } from '../src/server/accounts/mailer';
import { FileAccountStore } from '../src/server/accounts/store';
import { Room, TIMING, type RoomIO } from '../src/server/rooms/room';
import { summarize, type GameRecord, type PublicProfile } from '../src/shared/accounts';
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

  it('tells the app email is off when the server has no mailer', async () => {
    expect((await (await fetch(`${base}/me`)).json()).email).toBe(false);
  });

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

describe('email and password reset', () => {
  let server: Server;
  let base: string;
  let dir: string;
  const mail: Mail[] = [];
  let accounts: Accounts;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bb-reset-'));
    accounts = new Accounts(new FileAccountStore(join(dir, 'accounts.json')), { mailer: { send: async (m) => { mail.push(m); } }, publicUrl: 'https://trivio.test/' });
    await accounts.init();
    const app = express();
    app.use('/api', accounts.router());
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as { port: number }).port}/api`;
  });
  afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  it('tells the app email is on when a mailer and a public address are set', async () => {
    expect((await (await fetch(`${base}/me`)).json()).email).toBe(true);
  });

  const send = (method: string, path: string, body: unknown, cookie?: string) =>
    fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0];
  const me = async (cookie: string) => (await (await fetch(`${base}/me`, { headers: { cookie } })).json()).user;
  const tokenFrom = (m: Mail) => m.text.match(/https:\/\/trivio\.test\/reset#([\w-]+)/)![1];
  const settle = () => new Promise((r) => setTimeout(r, 30));

  it('signs up with an email, keeps it private, and logs in with it', async () => {
    expect((await send('POST', '/signup', { username: 'bad_mail', password: 'hunter2hunter2', email: 'nope' })).status).toBe(400);
    const res = await send('POST', '/signup', { username: 'mia', password: 'hunter2hunter2', email: ' Mia@Example.com ' });
    expect(res.status).toBe(200);
    expect((await me(cookieOf(res))).email).toBe('mia@example.com');
    const dup = await send('POST', '/signup', { username: 'mia2', password: 'hunter2hunter2', email: 'MIA@example.com' });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toMatch(/email/);
    expect((await send('POST', '/login', { username: 'mia@EXAMPLE.com', password: 'hunter2hunter2' })).status).toBe(200);
    const profile = await (await fetch(`${base}/users/mia`)).json();
    expect(JSON.stringify(profile)).not.toContain('example.com');
  });

  it('emails a one-time reset link that logs out every other device', async () => {
    const old = cookieOf(await send('POST', '/login', { username: 'mia', password: 'hunter2hunter2' }));
    mail.length = 0;
    expect((await send('POST', '/password/forgot', { login: 'nobody_here' })).status).toBe(200);
    expect((await send('POST', '/password/forgot', { login: 'MIA' })).status).toBe(200);
    await settle();
    expect(mail).toHaveLength(1);
    expect(mail[0].to).toBe('mia@example.com');
    const token = tokenFrom(mail[0]);

    expect((await send('POST', '/password/reset', { token, password: 'short' })).status).toBe(400); // doesn't use up the link
    const res = await send('POST', '/password/reset', { token, password: 'brand-new-pass' });
    expect(res.status).toBe(200);
    expect(await me(cookieOf(res))).toMatchObject({ username: 'mia', emailVerified: true }); // opening the link proves the address
    expect(await me(old)).toBeNull();
    expect((await send('POST', '/password/reset', { token, password: 'another-pass-1' })).status).toBe(400);
    expect((await send('POST', '/login', { username: 'mia', password: 'hunter2hunter2' })).status).toBe(401);
    expect((await send('POST', '/login', { username: 'mia', password: 'brand-new-pass' })).status).toBe(200);
  });

  it('sends at most three reset emails an hour per account', async () => {
    mail.length = 0;
    for (let i = 0; i < 3; i++) await send('POST', '/password/forgot', { login: 'mia@example.com' });
    await settle();
    expect(mail).toHaveLength(2); // one was already sent in the last test
  });

  it('needs the current password to change the email', async () => {
    const cookie = cookieOf(await send('POST', '/login', { username: 'mia', password: 'brand-new-pass' }));
    expect((await send('PATCH', '/me', { email: 'thief@example.com' }, cookie)).status).toBe(403);
    expect((await send('PATCH', '/me', { email: 'thief@example.com', password: 'wrong-password' }, cookie)).status).toBe(403);
    const ok = await send('PATCH', '/me', { email: 'mia.new@example.com', password: 'brand-new-pass' }, cookie);
    expect((await ok.json()).user.email).toBe('mia.new@example.com');
    // Saving the same email again (e.g. with a bio edit) doesn't ask for the password.
    expect((await send('PATCH', '/me', { email: 'mia.new@example.com', bio: 'hi' }, cookie)).status).toBe(200);
  });
});

describe('confirming an email (optional)', () => {
  let server: Server;
  let base: string;
  let dir: string;
  const mail: Mail[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bb-confirm-'));
    const accounts = new Accounts(new FileAccountStore(join(dir, 'accounts.json')), { mailer: { send: async (m) => { mail.push(m); } }, publicUrl: 'https://trivio.test' });
    await accounts.init();
    const app = express();
    app.use('/api', accounts.router());
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as { port: number }).port}/api`;
  });
  afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  const send = (method: string, path: string, body: unknown, cookie?: string) =>
    fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const me = async (cookie: string) => (await (await fetch(`${base}/me`, { headers: { cookie } })).json()).user;
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const confirmToken = (to: string) => mail.filter((m) => m.to === to && m.subject.includes('Confirm')).at(-1)!.text.match(/https:\/\/trivio\.test\/confirm#([\w-]+)/)![1];

  it('emails a link after sign-up that confirms the address, even logged out', async () => {
    const res = await send('POST', '/signup', { username: 'zoe', password: 'hunter2hunter2', email: 'zoe@example.com' });
    const cookie = res.headers.get('set-cookie')!.split(';')[0];
    expect((await res.json()).user).toMatchObject({ email: 'zoe@example.com', emailVerified: false });
    await settle();
    const token = confirmToken('zoe@example.com');
    expect(await (await send('POST', '/email/confirm', { token })).json()).toMatchObject({ ok: true, username: 'zoe' });
    expect((await me(cookie)).emailVerified).toBe(true);
    expect((await send('POST', '/email/confirm', { token })).status).toBe(400); // one use
    // Already confirmed: asking again sends nothing.
    mail.length = 0;
    expect((await send('POST', '/email/confirm/send', {}, cookie)).status).toBe(200);
    await settle();
    expect(mail).toHaveLength(0);
  });

  it('starts a new address unconfirmed, and an old link can’t confirm it', async () => {
    const cookie = (await send('POST', '/login', { username: 'zoe', password: 'hunter2hunter2' })).headers.get('set-cookie')!.split(';')[0];
    await send('PATCH', '/me', { email: 'zoe2@example.com', password: 'hunter2hunter2' }, cookie);
    expect((await me(cookie)).emailVerified).toBe(false);
    await settle();
    const stale = confirmToken('zoe2@example.com');
    await send('PATCH', '/me', { email: 'zoe3@example.com', password: 'hunter2hunter2' }, cookie);
    expect((await send('POST', '/email/confirm', { token: stale })).status).toBe(400);
    expect((await me(cookie)).emailVerified).toBe(false);
  });

  it('resends on request, up to three links an hour', async () => {
    const cookie = (await send('POST', '/signup', { username: 'amy', password: 'hunter2hunter2', email: 'amy@example.com' })).headers.get('set-cookie')!.split(';')[0];
    // One link already went out at sign-up. Changing the email also counts, so typing a new one can't spam other people.
    expect((await send('POST', '/email/confirm/send', {}, cookie)).status).toBe(200);
    expect((await send('POST', '/email/confirm/send', {}, cookie)).status).toBe(200);
    expect((await send('POST', '/email/confirm/send', {}, cookie)).status).toBe(429);
    expect((await send('POST', '/email/confirm/send', {})).status).toBe(401);
  });

  it('keeps working without confirming: resets still go out', async () => {
    mail.length = 0;
    await send('POST', '/password/forgot', { login: 'zoe3@example.com' });
    await settle();
    expect(mail.map((m) => m.subject)).toEqual(['Reset your Trivio password']);
  });
});

describe('account settings: username and password', () => {
  let server: Server;
  let base: string;
  let dir: string;
  const renames: string[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bb-acct-settings-'));
    const accounts = new Accounts(new FileAccountStore(join(dir, 'accounts.json')));
    accounts.onRename = async (id, from, to) => { renames.push(`${from}->${to}`); };
    await accounts.init();
    const app = express();
    app.use('/api', accounts.router());
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as { port: number }).port}/api`;
  });
  afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });

  const send = (method: string, path: string, body: unknown, cookie?: string) =>
    fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0];
  const me = async (cookie: string) => (await (await fetch(`${base}/me`, { headers: { cookie } })).json()).user;

  it('changes the username, then waits a week before the next change', async () => {
    const cookie = cookieOf(await send('POST', '/signup', { username: 'sam', password: 'hunter2hunter2' }));
    await send('POST', '/signup', { username: 'taken_name', password: 'hunter2hunter2' });
    expect((await me(cookie)).usernameChangedAt).toBeNull();
    expect((await send('POST', '/me/username', { username: 'no' }, cookie)).status).toBe(400);
    expect((await send('POST', '/me/username', { username: 'TAKEN_NAME' }, cookie)).status).toBe(409);
    expect((await send('POST', '/me/username', { username: 'sam' }, cookie)).status).toBe(400); // same name
    expect((await send('POST', '/me/username', { username: 'x' })).status).toBe(401);

    const ok = await send('POST', '/me/username', { username: 'Sammy' }, cookie);
    expect(ok.status).toBe(200);
    expect((await ok.json()).user.username).toBe('Sammy');
    expect(renames).toEqual(['sam->Sammy']);
    expect((await fetch(`${base}/users/sammy`)).status).toBe(200);
    expect((await fetch(`${base}/users/sam`)).status).toBe(404);
    expect((await send('POST', '/login', { username: 'sammy', password: 'hunter2hunter2' })).status).toBe(200);
    // The old name is free for someone else.
    expect((await send('POST', '/signup', { username: 'sam', password: 'hunter2hunter2' })).status).toBe(200);

    const again = await send('POST', '/me/username', { username: 'Sam_two' }, cookie);
    expect(again.status).toBe(429);
    expect((await again.json()).next).toBe((await me(cookie)).usernameChangedAt + 7 * 86_400_000);
  });

  it('allows the next change once the week is up', async () => {
    const cookie = cookieOf(await send('POST', '/login', { username: 'sammy', password: 'hunter2hunter2' }));
    const real = Date.now;
    Date.now = () => real() + 7 * 86_400_000 + 1000;
    try {
      expect((await send('POST', '/me/username', { username: 'Sam_two' }, cookie)).status).toBe(200);
    } finally { Date.now = real; }
  });

  it('saves up to five game presets on the account', async () => {
    const cookie = cookieOf(await send('POST', '/login', { username: 'sam_two', password: 'hunter2hunter2' }));
    const presets = Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, name: `Rules ${i}`, settings: { wpm: 300, source: 'upload', junk: true } }));
    const res = await send('PATCH', '/me', { presets }, cookie);
    const saved = (await res.json()).user.presets;
    expect(saved).toHaveLength(5);
    expect(saved[0]).toEqual({ id: 'p0', name: 'Rules 0', settings: { wpm: 300 } });
    expect((await me(cookie)).presets).toHaveLength(5);
  });

  it('changes the password with the current one, logging out other devices', async () => {
    const other = cookieOf(await send('POST', '/login', { username: 'sam_two', password: 'hunter2hunter2' }));
    const here = cookieOf(await send('POST', '/login', { username: 'sam_two', password: 'hunter2hunter2' }));
    expect((await send('POST', '/password/change', { current: 'wrong-password', password: 'new-password-1' }, here)).status).toBe(403);
    expect((await send('POST', '/password/change', { current: 'hunter2hunter2', password: 'short' }, here)).status).toBe(400);
    const ok = await send('POST', '/password/change', { current: 'hunter2hunter2', password: 'new-password-1' }, here);
    expect(ok.status).toBe(200);
    expect((await me(cookieOf(ok))).username).toBe('Sam_two'); // still logged in here
    expect(await me(other)).toBeNull();
    expect((await send('POST', '/login', { username: 'sam_two', password: 'new-password-1' })).status).toBe(200);
  });
});

describe('when sending fails', () => {
  it('doesn’t count failed emails toward the hourly limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-mailfail-'));
    let down = true;
    const sent: Mail[] = [];
    const accounts = new Accounts(new FileAccountStore(join(dir, 'accounts.json')), {
      mailer: { send: async (m) => { if (down) throw new Error('Connection timeout'); sent.push(m); } }, publicUrl: 'https://trivio.test',
    });
    await accounts.init();
    const app = express();
    app.use('/api', accounts.router());
    const server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://localhost:${(server.address() as { port: number }).port}/api`;
    const send = (path: string, body: unknown, cookie?: string) =>
      fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await send('/signup', { username: 'lee', password: 'hunter2hunter2', email: 'lee@example.com' }); // its email fails too
      const cookie = res.headers.get('set-cookie')!.split(';')[0];
      await new Promise((r) => setTimeout(r, 30));
      for (let i = 0; i < 4; i++) {
        const r = await send('/email/confirm/send', {}, cookie);
        expect(r.status).toBe(502);
        expect((await r.json()).error).toMatch(/couldn’t be sent/);
      }
      down = false;
      expect((await send('/email/confirm/send', {}, cookie)).status).toBe(200);
      expect(sent).toHaveLength(1);
    } finally {
      errors.mockRestore();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('admin account tools', () => {
  it('searches usernames (prefix matches first), counts accounts, and logs someone out everywhere', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-admintools-'));
    const store = new FileAccountStore(join(dir, 'accounts.json'));
    const accounts = new Accounts(store);
    await accounts.init();
    const now = Date.now();
    const mk = (id: string, username: string, extra: Record<string, unknown> = {}) =>
      store.createUser({ id, username, key: username.toLowerCase(), passwordHash: 'x', displayName: username, bio: '', settings: null, createdAt: now, email: null, ...extra });
    await mk('1', 'quizzer');
    await mk('2', 'Bob_quiz', { email: 'bob@example.com', emailVerified: true });
    await mk('3', 'carl', { email: 'carl@example.com', createdAt: now - 30 * 86_400_000 });
    expect((await accounts.adminSearch('QUIZ')).map((u) => u.username)).toEqual(['quizzer', 'Bob_quiz']);
    expect((await accounts.adminSearch('@carl'))[0]).toMatchObject({ username: 'carl', email: true, emailVerified: false });
    expect(JSON.stringify(await accounts.adminSearch('o'))).not.toContain('@example.com'); // never the address itself
    expect(await accounts.adminCounts()).toEqual({ total: 3, withEmail: 2, confirmed: 1, newSince: 2 });
    await store.createSession('h1', '3', now + 60_000);
    expect(await accounts.adminLogout('carl')).toBe('3');
    expect(await store.session('h1')).toBeNull();
    expect(await accounts.adminLogout('nobody')).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('password reset without email set up', () => {
  it('says so instead of pretending to send', async () => {
    const accounts = new Accounts(new FileAccountStore(null));
    await accounts.init();
    const app = express();
    app.use('/api', accounts.router());
    const server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    const res = await fetch(`http://localhost:${(server.address() as { port: number }).port}/api/password/forgot`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'x' }),
    });
    server.close();
    expect(res.status).toBe(503);
  });
});

describe('recent games', () => {
  it('labels daily challenges, including games saved before they carried the number', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-recent-'));
    const store = new FileAccountStore(join(dir, 'accounts.json'));
    const accounts = new Accounts(store);
    await accounts.init();
    await store.createUser({ id: 'u1', username: 'hao', key: 'hao', passwordHash: 'x', displayName: 'Hao', bio: '', settings: null, createdAt: 0, email: null });
    const game = (at: number, points: number, extra: Partial<GameRecord> = {}): GameRecord => ({
      at, room: 'R', mode: 'ffa', sides: 1, rank: 1, standings: [], tossups: 10, points, powers: 0, tens: 0, negs: 0,
      buzzes: 0, heard: 10, correctDepthSum: 0, bestStreak: 0, bonusPoints: 0, bonusesHeard: 0, categories: {}, ...extra,
    });
    accounts.record([
      { accountId: 'u1', game: game(1000, 145) }, // an old daily game, saved without the number
      { accountId: 'u1', game: game(2000, 60) }, // plain solo practice
      { accountId: 'u1', game: game(3000, 90, { daily: 4 }) },
    ]);
    await vi.waitFor(async () => expect(await store.games('u1', 10)).toHaveLength(3));
    accounts.findDaily = async (id, at, points) => (id === 'u1' && at === 1000 && points === 145 ? 3 : null);
    const recent = ((await accounts.profile('hao')) as PublicProfile).recent;
    expect(Object.fromEntries(recent.map((g) => [g.at, g.daily]))).toEqual({ 1000: 3, 2000: undefined, 3000: 4 });
    rmSync(dir, { recursive: true, force: true });
  });
});

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
    expect(accepted.friends).toEqual([{ username: 'amy', displayName: 'amy', admin: false, color: 'orange', frame: 'none', level: 1, status: 'room', room: { code: 'ABCD', phase: 'lobby', mode: 'ffa', players: 2 } }]);
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

describe('badges', () => {
  it('awards badges from games and daily results, with progress on the rest', async () => {
    const { badgesFor } = await import('../src/shared/profile');
    const games = [game({ points: 120, powers: 3, tens: 4, negs: 0, tossups: 12, correctDepthSum: 7 * 0.35 }), game({ rank: 1 })];
    const s = summarize(games);
    const daily = { played: 8, wins: 1, podiums: 2, bestRank: 1, bestScore: 150, avgPoints: 80, streak: 2, longestStreak: 7, leadingToday: false, perfect: 0, recent: [] };
    const by = Object.fromEntries(badgesFor({ games, p: { ...s, daily } }).map((b) => [b.id, b]));
    expect(by.debut.earned).toBe(true);
    expect(by.firstPower.earned).toBe(true);
    expect(by.firstWin.earned).toBe(true);
    expect(by.century.earned).toBe(true);
    expect(by.clean.earned).toBe(true);
    expect(by.earlyBuzzer.earned).toBe(true);
    expect(by.dailyWin.earned).toBe(true);
    expect(by.dailyWeek.earned).toBe(true);
    expect(by.dailyPerfect.earned).toBe(false);
    expect(by.regular).toEqual({ id: 'regular', earned: false, have: 2, need: 25 });
    expect(by.powerHungry).toMatchObject({ earned: false, have: 5, need: 50 });
  });

  it('keeps only known pinned stats, once each, at most three', async () => {
    const { cleanPinned } = await import('../src/shared/profile');
    expect(cleanPinned(['dailyWins', 'nope', 'dailyWins', 'ppg', 'powers', 'wins'])).toEqual(['dailyWins', 'ppg', 'powers']);
    expect(cleanPinned('dailyWins')).toEqual([]);
  });
});

describe('profile privacy and pins', () => {
  let server: Server;
  let base: string;
  let dir: string;
  let accounts: Accounts;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bb-privacy-'));
    accounts = new Accounts(new FileAccountStore(join(dir, 'accounts.json')));
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
  const signup = async (username: string) => {
    const res = await req('POST', '/signup', { username, password: 'long-enough-pw' });
    return { cookie: res.headers.get('set-cookie')!.split(';')[0], user: (await res.json()).user };
  };
  const view = async (username: string, cookie?: string) => (await (await req('GET', `/users/${username}`, undefined, cookie)).json()).profile;

  it('saves visibility and pins, and rejects a bad visibility', async () => {
    const owner = await signup('pinner');
    expect(owner.user).toMatchObject({ visibility: 'public', pinned: [] });
    const res = await req('PATCH', '/me', { pinned: ['dailyWins', 'bogus', 'ppg'] }, owner.cookie);
    expect((await res.json()).user.pinned).toEqual(['dailyWins', 'ppg']);
    expect((await req('PATCH', '/me', { visibility: 'everyone' }, owner.cookie)).status).toBe(400);
    const p = await view('pinner');
    expect(p.pinned).toEqual(['dailyWins', 'ppg']);
    expect(p.badges.length).toBeGreaterThan(10);
    expect(p.visibility).toBeUndefined(); // only the owner sees their setting
    expect((await view('pinner', owner.cookie)).visibility).toBe('public');
  });

  it('hides stats from everyone but friends, the owner and admins', async () => {
    const owner = await signup('shy');
    const friend = await signup('pal');
    const stranger = await signup('rando');
    const admin = await signup('Hao');
    await req('POST', '/friends', { username: 'pal' }, owner.cookie);
    await req('POST', '/friends', { username: 'shy' }, friend.cookie);

    await req('PATCH', '/me', { visibility: 'friends' }, owner.cookie);
    expect(await view('shy')).toEqual({ username: 'shy', displayName: 'shy', createdAt: owner.user.createdAt, admin: false, locked: 'friends', color: 'orange', frame: 'none', level: 1 });
    expect((await view('shy', stranger.cookie)).locked).toBe('friends');
    expect((await view('shy', friend.cookie)).totals).toBeDefined();
    expect((await view('shy', owner.cookie)).visibility).toBe('friends');

    await req('PATCH', '/me', { visibility: 'private' }, owner.cookie);
    expect((await view('shy', friend.cookie)).locked).toBe('private');
    expect((await view('shy', owner.cookie)).totals).toBeDefined();
    expect((await view('shy', admin.cookie)).visibility).toBe('private');

    // Invites go to friends only.
    expect((await accounts.friendOf(owner.user.id, 'PAL'))?.username).toBe('pal');
    expect(await accounts.friendOf(owner.user.id, 'rando')).toBeNull();
    expect(await accounts.friendOf(owner.user.id, 'shy')).toBeNull();
  });

  it('lets only admins unlock every badge, for anyone including themselves', async () => {
    const admin = (await req('POST', '/login', { username: 'Hao', password: 'long-enough-pw' }));
    const cookie = admin.headers.get('set-cookie')!.split(';')[0];
    const user = (await req('POST', '/login', { username: 'rando', password: 'long-enough-pw' })).headers.get('set-cookie')!.split(';')[0];
    expect((await req('POST', '/admin/users/rando/badges', { unlock: true }, user)).status).toBe(403);
    expect((await (await req('POST', '/admin/users/Hao/badges', { unlock: true }, cookie)).json()).unlocked).toBe(true);
    const mine = await view('Hao', cookie);
    expect(mine.badges.every((b: any) => b.earned)).toBe(true);
    expect(mine.badgesUnlocked).toBe(true);
    expect((await view('Hao')).badgesUnlocked).toBeUndefined(); // others don't see that it was unlocked
    await req('POST', '/admin/users/Hao/badges', { unlock: false }, cookie);
    expect((await view('Hao', cookie)).badges.some((b: any) => !b.earned)).toBe(true);
    expect((await req('POST', '/admin/users/nobody_x/badges', { unlock: true }, cookie)).status).toBe(404);
  });
});

describe('badge rewards', () => {
  it('pairs every color and frame but the defaults with a real badge or a level, and falls back to the defaults', async () => {
    const { AVATAR_FRAMES, BADGE_BY_ID, DEFAULT_COLOR, DEFAULT_FRAME, PROFILE_COLORS, isUnlocked, lookFor } = await import('../src/shared/profile');
    for (const r of [...PROFILE_COLORS, ...AVATAR_FRAMES]) {
      if (r.id === DEFAULT_COLOR || r.id === DEFAULT_FRAME) expect(r.badge).toBeUndefined();
      else expect(r.level ? r.level >= 2 && !r.badge : BADGE_BY_ID.has(r.badge!)).toBe(true);
    }
    expect(PROFILE_COLORS.every((c) => /^#[0-9a-f]{6}$/.test(c.light) && /^#[0-9a-f]{6}$/.test(c.dark))).toBe(true);
    expect(lookFor({})).toEqual({ color: 'orange', frame: 'none' });
    expect(lookFor({ color: 'plaid', frame: 'spikes' })).toEqual({ color: 'orange', frame: 'none' });
    // A badge that's gone (an admin re-locked them) shows the default instead.
    expect(lookFor({ color: 'gold', frame: 'halo' }, new Set(['dailyWin']))).toEqual({ color: 'gold', frame: 'none' });
    expect(lookFor({ color: 'gold', frame: 'halo' }, new Set())).toEqual({ color: 'orange', frame: 'none' });
    const teal = PROFILE_COLORS.find((c) => c.id === 'teal')!;
    expect(isUnlocked(teal, new Set(['firstPower']))).toBe(true);
    expect(isUnlocked(teal, new Set(['debut']))).toBe(false);
  });

  describe('HTTP', () => {
    let server: Server;
    let base: string;
    let dir: string;
    let store: FileAccountStore;

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'bb-rewards-'));
      store = new FileAccountStore(join(dir, 'accounts.json'));
      const accounts = new Accounts(store);
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
    const signup = async (username: string) => {
      const res = await req('POST', '/signup', { username, password: 'long-enough-pw' });
      return { cookie: res.headers.get('set-cookie')!.split(';')[0], user: (await res.json()).user };
    };
    const view = async (username: string, cookie?: string) => (await (await req('GET', `/users/${username}`, undefined, cookie)).json()).profile;
    const me = async (cookie: string) => (await (await req('GET', '/me', undefined, cookie)).json()).user;

    it('starts on the defaults and only takes rewards whose badge was earned', async () => {
      const p = await signup('painter');
      expect(p.user).toMatchObject({ color: 'orange', frame: 'none' });
      expect(await view('painter')).toMatchObject({ color: 'orange', frame: 'none' });

      // Nothing earned yet: locked rewards are refused, unknown ids too, the defaults are fine.
      let res = await req('PATCH', '/me', { color: 'blue' }, p.cookie);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/Debut/);
      expect((await req('PATCH', '/me', { color: 'plaid' }, p.cookie)).status).toBe(400);
      expect((await req('PATCH', '/me', { frame: 'spikes' }, p.cookie)).status).toBe(400);
      expect((await req('PATCH', '/me', { color: 'orange', frame: 'none' }, p.cookie)).status).toBe(200);

      // One won game with powers: Debut, First power and First win.
      await store.addGames([{ userId: p.user.id, game: game() }]);
      res = await req('PATCH', '/me', { color: 'teal', frame: 'ring', bio: 'hi' }, p.cookie);
      expect(res.status).toBe(200);
      expect((await res.json()).user).toMatchObject({ color: 'teal', frame: 'ring', bio: 'hi' });
      // A locked one in the same request fails the whole request.
      res = await req('PATCH', '/me', { color: 'blue', frame: 'halo', bio: 'changed' }, p.cookie);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/Champion/);
      expect(await me(p.cookie)).toMatchObject({ color: 'teal', frame: 'ring', bio: 'hi' });
      expect(await view('painter')).toMatchObject({ color: 'teal', frame: 'ring' });
      expect((await req('PATCH', '/me', { color: 'gold' }, p.cookie)).status).toBe(403);
    });

    it('lets admin-granted badges unlock rewards, shows them to friends and on locked profiles, and resets them on re-lock', async () => {
      const admin = await signup('Hao');
      const pal = await signup('palette');
      const stranger = await signup('passerby');
      expect((await req('PATCH', '/me', { color: 'gold', frame: 'halo' }, admin.cookie)).status).toBe(403);
      await req('POST', '/admin/users/Hao/badges', { unlock: true }, admin.cookie);
      expect((await req('PATCH', '/me', { color: 'gold', frame: 'halo', visibility: 'private' }, admin.cookie)).status).toBe(200);

      // Cosmetic, so it shows even when the stats are hidden.
      expect(await view('Hao', stranger.cookie)).toMatchObject({ locked: 'private', color: 'gold', frame: 'halo' });
      await req('POST', '/friends', { username: 'Hao' }, pal.cookie);
      let list = await (await req('GET', '/friends', undefined, admin.cookie)).json();
      expect(list.incoming[0]).toMatchObject({ username: 'palette', color: 'orange', frame: 'none' });
      await req('POST', '/friends', { username: 'palette' }, admin.cookie);
      list = await (await req('GET', '/friends', undefined, pal.cookie)).json();
      expect(list.friends[0]).toMatchObject({ username: 'Hao', color: 'gold', frame: 'halo' });

      // Re-locking takes back what only the granted badges unlocked.
      await req('POST', '/admin/users/Hao/badges', { unlock: false }, admin.cookie);
      expect(await view('Hao', admin.cookie)).toMatchObject({ color: 'orange', frame: 'none' });
      expect(await me(admin.cookie)).toMatchObject({ color: 'orange', frame: 'none' });
      list = await (await req('GET', '/friends', undefined, pal.cookie)).json();
      expect(list.friends[0]).toMatchObject({ color: 'orange', frame: 'none' });
    });

    it('shows the default when a stored reward is no longer unlocked', async () => {
      const u = await signup('faded');
      await store.updateUser(u.user.id, { color: 'violet', frame: 'star' }); // as if the badges went away
      expect(await view('faded')).toMatchObject({ color: 'orange', frame: 'none' });
    });
  });
});
