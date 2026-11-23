import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import express, { type Request, type Response } from 'express';
import type { Socket } from 'socket.io';
import {
  BIO_MAX, FRIENDS_MAX, PASSWORD_MIN, USERNAME_RE, summarize,
  type Friend, type FriendRoom, type FriendsList, type GameRecord, type Me, type ProfileView, type PublicProfile,
} from '../../shared/accounts';
import {
  AVATAR_FRAMES, BADGES, PROFILE_COLORS, VISIBILITIES, badgesFor, cleanPinned, colorById, earnedIds, frameById, isColor, isFrame, isUnlocked,
  lookFor, rewardLevel, unlockHint, type Reward, type Visibility,
} from '../../shared/profile';
import { levelFor, unlockedBetween, xpForGame, type LevelInfo } from '../../shared/levels';
import type { AccountStore, FriendLink, User, UserPatch } from './store';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

const COOKIE = 'bb_session';
const SESSION_DAYS = 60;
/** Profiles are built from at most this many recent games. */
const PROFILE_GAMES = 1000;
const RECENT_GAMES = 15;

/** Who a socket is logged in as, with their level and picture for the rooms they join. */
export interface SocketAccount { id: string; username: string; admin: boolean; level?: number; pic?: string }

/** XP one account got from a finished game. */
export interface XpGain { accountId: string; gained: number; before: LevelInfo; after: LevelInfo; unlocked: string[] }

const LEVEL_REWARDS = [
  ...PROFILE_COLORS.map((r) => ({ ...r, kind: 'color' })),
  ...AVATAR_FRAMES.map((r) => ({ ...r, kind: 'frame' })),
];

/** Profile pictures: a square JPEG the app made on the player's device (256 px), checked here. */
export const AVATAR_MAX_BYTES = 200 * 1024;
const AVATAR_MIN_PX = 32, AVATAR_MAX_PX = 1024;

/** Width and height of a baseline or progressive JPEG, or null when it isn't one. */
export function jpegSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue; }
    const len = b.readUInt16BE(i + 2);
    // SOF markers (C0–CF except C4 DHT, C8 JPG, CC DAC) carry the size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    if (marker === 0xda || len < 2) return null;
    i += 2 + len;
  }
  return null;
}

/** Where a logged-in account is right now (accounts with no entry are offline). */
export interface Presence { status: 'online' | 'room' | 'daily' | 'survival'; room?: FriendRoom }

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

const STATUS_ORDER: Record<Friend['status'], number> = { room: 0, daily: 1, survival: 1, online: 2, offline: 3 };

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
  return { id: u.id, username: u.username, displayName: u.displayName, bio: u.bio, createdAt: u.createdAt, admin: isAdmin(u), ...(isAdmin(u) ? { adminLocked } : {}), settings: u.settings,
    visibility: u.visibility ?? 'public', pinned: cleanPinned(u.pinned), ...lookFor(u) };
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
  private allowAvatar = limiter(10, 10 * 60_000);
  /** Set by the server, which knows the sockets and rooms: where each of these accounts is right now. */
  presence: (accountIds: string[]) => Map<string, Presence> = () => new Map();

  constructor(private store: AccountStore) {}

  /** Extra profile sections from elsewhere (the daily challenge, survival), added when a profile is shown. */
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
      return;
    }
    // Work out levels for accounts that had games before levels existed (in the background).
    void this.backfillXp();
  }

  private async backfillXp() {
    try {
      const ids = await this.store.usersWithoutXp();
      for (const id of ids) {
        const u = await this.store.userById(id);
        if (u) await this.xpOf(u);
      }
      if (ids.length) console.log(`Worked out levels for ${ids.length} account${ids.length === 1 ? '' : 's'}.`);
    } catch (e) {
      console.error('Could not work out levels:', e);
    }
  }

  /** Total XP of an account, worked out from every saved game the first time it's needed. */
  async xpOf(u: User): Promise<number> {
    if (u.xp != null) return u.xp;
    const games = await this.store.games(u.id, 1_000_000);
    u.xp = await this.store.initXp(u.id, games.reduce((n, g) => n + xpForGame(g), 0));
    return u.xp;
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
      if (u) {
        const { level, pic } = lookFor(u);
        this.sockets.set(socket, { id: u.id, username: u.username, admin: isAdmin(u), ...(level ? { level } : {}), ...(pic ? { pic } : {}) });
      }
      next();
    }, () => next());
  };

  of(socket: Socket): SocketAccount | undefined { return this.sockets.get(socket); }

  // ---------- game results ----------

  /** Save finished games to their players' profiles and add their XP. Never throws. */
  async record(entries: { accountId: string; game: GameRecord }[]): Promise<XpGain[]> {
    if (!this.ready || !entries.length) return [];
    try {
      await this.store.addGames(entries.map((e) => ({ userId: e.accountId, game: e.game })));
    } catch (e) {
      console.error('Could not save game results:', e);
      return [];
    }
    const gained = new Map<string, number>();
    for (const e of entries) gained.set(e.accountId, (gained.get(e.accountId) ?? 0) + xpForGame(e.game));
    const out: XpGain[] = [];
    for (const [accountId, n] of gained) {
      try {
        let total = await this.store.addXp(accountId, n);
        if (total == null) {
          // Not worked out yet: the sum over saved games already includes this one.
          const u = await this.store.userById(accountId);
          if (!u) continue;
          total = await this.xpOf(u);
        }
        const before = levelFor(total - n), after = levelFor(total);
        out.push({ accountId, gained: n, before, after, unlocked: unlockedBetween(before.level, after.level, LEVEL_REWARDS) });
      } catch (e) {
        console.error('Could not add XP:', e);
      }
    }
    return out;
  }

  /**
   * A profile as `viewer` may see it. Stats, badges and games stay hidden unless the profile is public,
   * the viewer is a friend (friends only), the owner, or a site admin.
   */
  async profile(username: string, viewer: User | null = null): Promise<ProfileView | null> {
    const u = await this.store.userByName(username);
    if (!u) return null;
    await this.xpOf(u);
    const visibility: Visibility = u.visibility ?? 'public';
    const owner = viewer?.id === u.id;
    const privileged = owner || (!!viewer && isAdmin(viewer));
    if (visibility !== 'public' && !privileged) {
      const friend = visibility === 'friends' && !!viewer && !!relations(await this.store.friendLinks(u.id), u.id).get(viewer.id)?.friend;
      if (!friend) {
        return { username: u.username, displayName: u.displayName, createdAt: u.createdAt, admin: isAdmin(u), locked: visibility, ...lookFor(u, await this.earnedBadges(u)) };
      }
    }
    const games = await this.store.games(u.id, PROFILE_GAMES);
    const recent = games.slice(0, RECENT_GAMES);
    if (this.findDaily) {
      await Promise.all(recent.map(async (g, i) => {
        if (g.daily || g.sides > 1 || g.mode !== 'ffa') return;
        const n = await this.findDaily!(u.id, g.at, g.points).catch(() => null);
        if (n) recent[i] = { ...g, daily: n };
      }));
    }
    const p: PublicProfile = {
      username: u.username, displayName: u.displayName, bio: u.bio, createdAt: u.createdAt, admin: isAdmin(u),
      ...lookFor(u),
      ...summarize(games),
      recent,
      ...(await this.extras(u)),
      pinned: cleanPinned(u.pinned),
      badges: [],
      levelInfo: levelFor(u.xp ?? 0),
      ...(privileged ? { visibility } : {}),
      ...(viewer && isAdmin(viewer) ? { badgesUnlocked: !!u.grantedBadges?.length } : {}),
    };
    p.badges = badgesFor({ games, p, granted: u.grantedBadges });
    Object.assign(p, lookFor(u, earnedIds(p.badges)));
    return p;
  }

  private extras(u: User): Promise<Partial<PublicProfile>> {
    return this.profileExtras?.(u).catch((e) => { console.error('Profile extras failed:', e); return {}; }) ?? Promise.resolve({});
  }

  /** The badges an account has now: earned from games and daily results, or granted by an admin. */
  async earnedBadges(u: User): Promise<Set<string>> {
    const games = await this.store.games(u.id, PROFILE_GAMES);
    const p = { ...summarize(games), ...(await this.extras(u)) };
    return earnedIds(badgesFor({ games, p, granted: u.grantedBadges }));
  }

  /** The account `username` if they and `meId` are friends. */
  async friendOf(meId: string, username: string): Promise<User | null> {
    const them = await this.store.userByName(username);
    if (!them || them.id === meId) return null;
    return relations(await this.store.friendLinks(meId), meId).get(them.id)?.friend ? them : null;
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
      // Rewards were checked when picked (and again when an admin re-locks badges), so the list skips recomputing badges.
      const who = { username: x.username, displayName: x.displayName, admin: isAdmin(x), ...lookFor(x) };
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
      if (u) await this.xpOf(u);
      res.json({ user: u ? toMe(u) : null });
    }));

    // ---------- profile pictures ----------

    r.get('/avatar/:username', wrap(async (req, res) => {
      const u = await this.store.userByName(String(req.params.username));
      const jpeg = u?.avatarAt ? await this.store.avatar(u.id) : null;
      if (!jpeg) return res.status(404).json({ error: 'No picture.' });
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // The address carries the upload time, so a new picture gets a new address.
      res.setHeader('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
      res.send(jpeg);
    }));

    r.put('/me/avatar', express.raw({ type: 'image/jpeg', limit: AVATAR_MAX_BYTES }), wrap(async (req, res) => {
      const u = await this.userFrom(req.headers.cookie);
      if (!u) return res.status(401).json({ error: 'Log in first.' });
      if (!this.allowAvatar(u.id)) return res.status(429).json({ error: 'That’s a lot of new pictures. Try again in a few minutes.' });
      const body = Buffer.isBuffer(req.body) ? req.body : null;
      const size = body ? jpegSize(body) : null;
      if (!body || !size) return res.status(400).json({ error: 'That picture didn’t come through. Try another one.' });
      if (size.width < AVATAR_MIN_PX || size.height < AVATAR_MIN_PX || size.width > AVATAR_MAX_PX || size.height > AVATAR_MAX_PX) {
        return res.status(400).json({ error: 'That picture is the wrong size.' });
      }
      const at = Date.now();
      await this.store.setAvatar(u.id, body, at);
      res.json({ user: toMe({ ...u, avatarAt: at }) });
    }));

    r.delete('/me/avatar', wrap(async (req, res) => {
      const u = await this.userFrom(req.headers.cookie);
      if (!u) return res.status(401).json({ error: 'Log in first.' });
      await this.store.setAvatar(u.id, null, Date.now());
      res.json({ user: toMe({ ...u, avatarAt: null }) });
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
      user.xp = await this.store.initXp(user.id, 0);
      await this.startSession(req, res, user.id);
      res.json({ user: toMe(user) });
    }));

    r.post('/login', wrap(async (req, res) => {
      if (limited(req, res)) return;
      const username = String(req.body?.username ?? '').trim();
      const password = String(req.body?.password ?? '');
      const u = username ? await this.store.userByName(username) : null;
      if (!u || !(await verifyPassword(password, u.passwordHash))) return res.status(401).json({ error: 'Wrong username or password.' });
      await this.xpOf(u);
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
      const patch: UserPatch = {};
      if ('displayName' in b) {
        const n = cleanName(b.displayName);
        if (!n) return res.status(400).json({ error: 'Pick a display name.' });
        patch.displayName = n;
      }
      if ('bio' in b) patch.bio = String(b.bio ?? '').trim().slice(0, BIO_MAX);
      if ('settings' in b) patch.settings = b.settings && typeof b.settings === 'object' ? b.settings : null;
      if ('visibility' in b) {
        if (!VISIBILITIES.includes(b.visibility)) return res.status(400).json({ error: 'Pick who can see your profile.' });
        patch.visibility = b.visibility;
      }
      if ('pinned' in b) patch.pinned = cleanPinned(b.pinned);
      if ('color' in b && !isColor(b.color)) return res.status(400).json({ error: 'Pick a profile color.' });
      if ('frame' in b && !isFrame(b.frame)) return res.status(400).json({ error: 'Pick an avatar frame.' });
      const wanted: Reward[] = [];
      if ('color' in b) { patch.color = b.color; wanted.push(colorById(b.color)); }
      if ('frame' in b) { patch.frame = b.frame; wanted.push(frameById(b.frame)); }
      if (wanted.some((r) => r.badge || r.level)) {
        await this.xpOf(u);
        const earned = await this.earnedBadges(u);
        const locked = wanted.find((r) => !isUnlocked(r, earned, rewardLevel(u)));
        if (locked) return res.status(403).json({ error: `${unlockHint(locked)} to unlock ${locked.name}.` });
      }
      await this.store.updateUser(u.id, patch);
      res.json({ user: toMe({ ...u, ...patch }) });
    }));

    r.get('/users/:username', wrap(async (req, res) => {
      const p = await this.profile(String(req.params.username), await this.userFrom(req.headers.cookie));
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

    /** Unlock every badge for an account (admins included, yourself too), or put it back to what they earned. */
    r.post('/admin/users/:username/badges', wrap(async (req, res) => {
      const me = await this.userFrom(req.headers.cookie);
      if (!me || !isAdmin(me)) return res.status(403).json({ error: 'Admins only.' });
      const u = await this.store.userByName(String(req.params.username));
      if (!u) return res.status(404).json({ error: 'No player with that username.' });
      const grantedBadges = req.body?.unlock ? BADGES.map((b) => b.id) : [];
      await this.store.updateUser(u.id, { grantedBadges });
      if (!grantedBadges.length && (u.color || u.frame)) {
        // Rewards those badges unlocked go back to the defaults.
        await this.xpOf(u);
        const look = lookFor({ ...u, grantedBadges }, await this.earnedBadges({ ...u, grantedBadges }));
        if (look.color !== (u.color ?? look.color) || look.frame !== (u.frame ?? look.frame)) await this.store.updateUser(u.id, { color: look.color, frame: look.frame });
      }
      console.log(`Admin ${grantedBadges.length ? 'unlocked' : 're-locked'} badges for @${u.username}`);
      res.json({ ok: true, unlocked: grantedBadges.length > 0 });
    }));

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

    /** Take down someone's profile picture. */
    r.delete('/admin/users/:username/avatar', wrap(async (req, res) => {
      const u = await target(req, res);
      if (!u) return;
      await this.store.setAvatar(u.id, null, Date.now());
      console.log(`Admin removed the profile picture of @${u.username}`);
      res.json({ ok: true });
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
