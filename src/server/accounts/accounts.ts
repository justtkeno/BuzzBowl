import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import express, { type Request, type Response } from 'express';
import type { Socket } from 'socket.io';
import {
  BIO_MAX, FRIENDS_MAX, PASSWORD_MIN, USERNAME_RE, summarize,
  type Friend, type FriendRoom, type FriendsList, type GameRecord, type Me, type PublicProfile,
} from '../../shared/accounts';
import type { AccountStore, FriendLink, User } from './store';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

const COOKIE = 'bb_session';
const SESSION_DAYS = 60;
/** Profiles are built from at most this many recent games. */
const PROFILE_GAMES = 1000;
const RECENT_GAMES = 15;

/** Who a socket is logged in as. */
export interface SocketAccount { id: string; username: string; admin: boolean }

/** Where a logged-in account is right now (accounts with no entry are offline). */
export interface Presence { status: 'online' | 'room' | 'daily'; room?: FriendRoom }

/** How `me` stands with each other account they have a friend link with. */
interface Relation { friend: boolean; incoming?: number; outgoing?: number }
function relations(links: FriendLink[], me: string): Map<string, Relation> {
  const out = new Map<string, Relation>();
  for (const l of links) {
    const other = l.from === me ? l.to : l.from;
    const r = out.get(other) ?? { friend: false };
    if (l.accepted) r.friend = true;
    else if (l.from === me) r.outgoing = l.at;
    else r.incoming = l.at;
    out.set(other, r);
  }
  // Both asked at once: that's a yes from each side.
  for (const r of out.values()) if (r.incoming !== undefined && r.outgoing !== undefined) r.friend = true;
  return out;
}

const STATUS_ORDER: Record<Friend['status'], number> = { room: 0, daily: 1, online: 2, offline: 3 };

/**
 * Site admins.
 * - Locked (recommended on a public server): ADMIN_ACCOUNT_IDS lists exact account ids, comma-separated.
 *   Only those accounts are admins. A wiped account list can't hand the powers to whoever re-registers the name.
 * - Unlocked fallback: ADMIN_USERNAMES (default "Hao"), case-insensitive. Fine for a local server, but whoever
 *   registers that username first on a server gets admin. Set ADMIN_USERNAMES to "" to have no admins.
 */
const ADMIN_IDS = new Set((process.env.ADMIN_ACCOUNT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const ADMINS = new Set((process.env.ADMIN_USERNAMES ?? 'Hao').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
/** True when admins are pinned to account ids. */
export const adminLocked = ADMIN_IDS.size > 0;
export const isAdmin = (u: { id: string; username: string }) => (adminLocked ? ADMIN_IDS.has(u.id) : ADMINS.has(u.username.toLowerCase()));
if (!adminLocked && ADMINS.size && process.env.NODE_ENV === 'production') {
  console.warn(`Admin is by username (${[...ADMINS].join(', ')}). Set ADMIN_ACCOUNT_IDS to lock it to your account; the admin panel shows your id.`);
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [kind, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), want.length);
  return got.length === want.length && timingSafeEqual(got, want);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const newId = () => randomBytes(9).toString('base64url');

function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

const cleanName = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);

export function toMe(u: User): Me {
  return { id: u.id, username: u.username, displayName: u.displayName, bio: u.bio, createdAt: u.createdAt, admin: isAdmin(u), ...(isAdmin(u) ? { adminLocked } : {}), settings: u.settings };
}

/** Tiny in-memory limiter for login/signup attempts, per IP. */
function limiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  setInterval(() => {
    const cut = Date.now() - windowMs;
    for (const [k, v] of hits) { const keep = v.filter((t) => t > cut); if (keep.length) hits.set(k, keep); else hits.delete(k); }
  }, windowMs).unref();
  return (key: string) => {
    const cut = Date.now() - windowMs;
    const list = (hits.get(key) ?? []).filter((t) => t > cut);
    list.push(Date.now());
    hits.set(key, list);
    return list.length <= max;
  };
}

export class Accounts {
  /** False when the database could not be reached at startup. */
  ready = false;
  private sockets = new WeakMap<Socket, SocketAccount>();
  private allow = limiter(20, 10 * 60_000);
  private allowFriendRequest = limiter(30, 10 * 60_000);
  /** Set by the server, which knows the sockets and rooms: where each of these accounts is right now. */
  presence: (accountIds: string[]) => Map<string, Presence> = () => new Map();

  constructor(private store: AccountStore) {}

  /** Extra profile sections from elsewhere (the daily challenge), added when a profile is shown. */
  profileExtras?: (user: { id: string }) => Promise<Partial<PublicProfile>>;
  /** Finds the daily challenge a solo game saved before games carried `daily` belongs to (its number), if any. */
  findDaily?: (accountId: string, at: number, points: number) => Promise<number | null>;

  get kind() { return this.store.kind; }

  async init() {
    try {
      await this.store.init();
      this.ready = true;
    } catch (e) {
      console.error(`Accounts are disabled: could not open the ${this.store.kind} store.`, e);
    }
  }

  /** The account a request's session cookie belongs to. */
  private async userFrom(cookieHeader: string | undefined): Promise<User | null> {
    if (!this.ready) return null;
    const token = readCookie(cookieHeader, COOKIE);
    if (!token) return null;
    try {
      const id = await this.store.session(sha256(token));
      return id ? await this.store.userById(id) : null;
    } catch (e) {
      console.error('Session lookup failed:', e);
      return null;
    }
  }

  private async startSession(req: Request, res: Response, userId: string) {
    const token = randomBytes(32).toString('base64url');
    const maxAge = SESSION_DAYS * 86_400_000;
    await this.store.createSession(sha256(token), userId, Date.now() + maxAge);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge, path: '/' });
  }

  // ---------- sockets ----------

  /** Socket.IO middleware: remembers who each socket is logged in as (from the cookie sent with the handshake). */
  socketMiddleware = (socket: Socket, next: (err?: Error) => void) => {
    this.userFrom(socket.request.headers.cookie).then((u) => {
      if (u) this.sockets.set(socket, { id: u.id, username: u.username, admin: isAdmin(u) });
      next();
    }, () => next());
  };

  of(socket: Socket): SocketAccount | undefined { return this.sockets.get(socket); }

  // ---------- game results ----------

  /** Save finished games to their players' profiles. Never throws. */
  record(entries: { accountId: string; game: GameRecord }[]) {
    if (!this.ready || !entries.length) return;
    this.store.addGames(entries.map((e) => ({ userId: e.accountId, game: e.game })))
      .catch((e) => console.error('Could not save game results:', e));
  }

  async profile(username: string): Promise<PublicProfile | null> {
    const u = await this.store.userByName(username);
    if (!u) return null;
    const games = await this.store.games(u.id, PROFILE_GAMES);
    const recent = games.slice(0, RECENT_GAMES);
    if (this.findDaily) {
      await Promise.all(recent.map(async (g, i) => {
        if (g.daily || g.sides > 1 || g.mode !== 'ffa') return;
        const n = await this.findDaily!(u.id, g.at, g.points).catch(() => null);
        if (n) recent[i] = { ...g, daily: n };
      }));
    }
    return {
      username: u.username, displayName: u.displayName, bio: u.bio, createdAt: u.createdAt, admin: isAdmin(u),
      ...summarize(games),
      recent,
      ...(await this.profileExtras?.(u).catch((e) => { console.error('Profile extras failed:', e); return {}; })),
    };
  }

  // ---------- friends ----------

  async friends(u: User): Promise<FriendsList> {
    const rel = relations(await this.store.friendLinks(u.id), u.id);
    const users = await this.store.usersByIds([...rel.keys()]);
    const friendIds = users.filter((x) => rel.get(x.id)!.friend).map((x) => x.id);
    const where = this.presence(friendIds);
    const list: FriendsList = { friends: [], incoming: [], outgoing: [] };
    for (const x of users) {
      const r = rel.get(x.id)!;
      const who = { username: x.username, displayName: x.displayName, admin: isAdmin(x) };
      if (r.friend) {
        const p = where.get(x.id);
        list.friends.push({ ...who, status: p?.status ?? 'offline', ...(p?.room ? { room: p.room } : {}) });
      } else if (r.incoming !== undefined) list.incoming.push({ ...who, at: r.incoming });
      else if (r.outgoing !== undefined) list.outgoing.push({ ...who, at: r.outgoing });
    }
    list.friends.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.displayName.localeCompare(b.displayName));
    list.incoming.sort((a, b) => b.at - a.at);
    list.outgoing.sort((a, b) => b.at - a.at);
    return list;
  }

  // ---------- HTTP ----------

  router() {
    const r = express.Router();
    r.use(express.json({ limit: '64kb' }));

    const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
      if (!this.ready) return res.status(503).json({ error: 'Accounts are unavailable right now. You can still play as a guest.' });
      fn(req, res).catch((e) => {
        console.error(e);
        if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Try again.' });
      });
    };
    const limited = (req: Request, res: Response) => {
      if (this.allow(req.ip ?? '?')) return false;
      res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
      return true;
    };

    r.get('/me', wrap(async (req, res) => {
      const u = await this.userFrom(req.headers.cookie);
      res.json({ user: u ? toMe(u) : null });
    }));

    r.post('/signup', wrap(async (req, res) => {
      if (limited(req, res)) return;
      const username = String(req.body?.username ?? '').trim();
      const password = String(req.body?.password ?? '');
      const displayName = cleanName(req.body?.displayName) || username;
      if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Usernames are 3–20 letters, numbers or underscores.' });
      if (password.length < PASSWORD_MIN) return res.status(400).json({ error: `Passwords need at least ${PASSWORD_MIN} characters.` });
      if (password.length > 200) return res.status(400).json({ error: 'That password is too long.' });
      const settings = req.body?.settings && typeof req.body.settings === 'object' ? req.body.settings : null;
      const user: User = {
        id: newId(), username, key: username.toLowerCase(), passwordHash: await hashPassword(password),
        displayName, bio: '', settings, createdAt: Date.now(),
      };
      if (!(await this.store.createUser(user))) return res.status(409).json({ error: 'That username is taken.' });
      await this.startSession(req, res, user.id);
      res.json({ user: toMe(user) });
    }));

    r.post('/login', wrap(async (req, res) => {
      if (limited(req, res)) return;
      const username = String(req.body?.username ?? '').trim();
      const password = String(req.body?.password ?? '');
      const u = username ? await this.store.userByName(username) : null;
      if (!u || !(await verifyPassword(password, u.passwordHash))) return res.status(401).json({ error: 'Wrong username or password.' });
      await this.startSession(req, res, u.id);
      res.json({ user: toMe(u) });
    }));

    r.post('/logout', wrap(async (req, res) => {
      const token = readCookie(req.headers.cookie, COOKIE);
      if (token) await this.store.deleteSession(sha256(token));
      res.clearCookie(COOKIE, { path: '/' });
      res.json({ ok: true });
    }));

    r.patch('/me', wrap(async (req, res) => {
      const u = await this.userFrom(req.headers.cookie);
      if (!u) return res.status(401).json({ error: 'Log in first.' });
      const b = req.body ?? {};
      const patch: Partial<Pick<User, 'displayName' | 'bio' | 'settings'>> = {};
      if ('displayName' in b) {
        const n = cleanName(b.displayName);
        if (!n) return res.status(400).json({ error: 'Pick a display name.' });
        patch.displayName = n;
      }
      if ('bio' in b) patch.bio = String(b.bio ?? '').trim().slice(0, BIO_MAX);
      if ('settings' in b) patch.settings = b.settings && typeof b.settings === 'object' ? b.settings : null;
      await this.store.updateUser(u.id, patch);
      res.json({ user: toMe({ ...u, ...patch }) });
    }));

    r.get('/users/:username', wrap(async (req, res) => {
      const p = await this.profile(String(req.params.username));
      if (!p) return res.status(404).json({ error: 'No player with that username.' });
      res.json({ profile: p });
    }));

    // ---------- friends ----------

    const loggedIn = async (req: Request, res: Response) => {
      const u = await this.userFrom(req.headers.cookie);
      if (!u) res.status(401).json({ error: 'Log in to add friends.' });
      return u;
    };

    r.get('/friends', wrap(async (req, res) => {
      const me = await loggedIn(req, res);
      if (me) res.json(await this.friends(me));
    }));

    /** Send a friend request, or accept theirs if they already asked you. */
    r.post('/friends', wrap(async (req, res) => {
      const me = await loggedIn(req, res);
      if (!me) return;
      if (!this.allowFriendRequest(me.id)) return res.status(429).json({ error: 'Too many friend requests. Wait a few minutes.' });
      const name = String(req.body?.username ?? '').trim().replace(/^@/, '');
      const them = USERNAME_RE.test(name) ? await this.store.userByName(name) : null;
      if (!them) return res.status(404).json({ error: 'No player with that username.' });
      if (them.id === me.id) return res.status(400).json({ error: 'That’s you!' });
      const mine = relations(await this.store.friendLinks(me.id), me.id);
      const r = mine.get(them.id);
      if (r?.incoming !== undefined && !r.friend) {
        await this.store.acceptFriend(them.id, me.id);
      } else if (!r) {
        if (mine.size >= FRIENDS_MAX) return res.status(400).json({ error: `You can have up to ${FRIENDS_MAX} friends and requests.` });
        if (relations(await this.store.friendLinks(them.id), them.id).size >= FRIENDS_MAX) {
          return res.status(400).json({ error: `@${them.username} can’t take more friend requests.` });
        }
        await this.store.requestFriend(me.id, them.id, Date.now());
      }
      res.json(await this.friends(me));
    }));

    /** Unfriend, decline their request, or cancel yours. */
    r.delete('/friends/:username', wrap(async (req, res) => {
      const me = await loggedIn(req, res);
      if (!me) return;
      const them = await this.store.userByName(String(req.params.username));
      if (them) await this.store.removeFriend(me.id, them.id);
      res.json(await this.friends(me));
    }));

    // ---------- admin moderation ----------

    const target = async (req: Request, res: Response) => {
      const me = await this.userFrom(req.headers.cookie);
      if (!me || !isAdmin(me)) { res.status(403).json({ error: 'Admins only.' }); return null; }
      const u = await this.store.userByName(String(req.params.username));
      if (!u) { res.status(404).json({ error: 'No player with that username.' }); return null; }
      if (isAdmin(u)) { res.status(400).json({ error: 'Admin accounts can’t be moderated here.' }); return null; }
      return u;
    };

    /** Clear an offensive display name (back to the username) and/or bio. */
    r.post('/admin/users/:username/reset', wrap(async (req, res) => {
      const u = await target(req, res);
      if (!u) return;
      const patch: Partial<Pick<User, 'displayName' | 'bio'>> = {};
      if (req.body?.displayName !== false) patch.displayName = u.username;
      if (req.body?.bio !== false) patch.bio = '';
      await this.store.updateUser(u.id, patch);
      console.log(`Admin reset profile of @${u.username}`);
      res.json({ ok: true, ...patch });
    }));

    /** Delete an account with its sessions and saved games. */
    r.delete('/admin/users/:username', wrap(async (req, res) => {
      const u = await target(req, res);
      if (!u) return;
      await this.store.deleteUser(u.id);
      console.log(`Admin deleted account @${u.username}`);
      res.json({ ok: true });
    }));

    r.use((_req, res) => res.status(404).json({ error: 'Not found.' }));
    return r;
  }
}
