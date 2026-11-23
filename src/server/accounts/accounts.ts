import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import express, { type Request, type Response } from 'express';
import type { Socket } from 'socket.io';
import {
  BIO_MAX, EMAIL_MAX, EMAIL_RE, FRIENDS_MAX, PASSWORD_MIN, USERNAME_COOLDOWN_DAYS, USERNAME_RE, summarize,
  type Friend, type FriendRoom, type FriendsList, type GameRecord, type Me, type ProfileView, type PublicProfile,
} from '../../shared/accounts';
import {
  BADGES, BADGE_BY_ID, VISIBILITIES, badgesFor, cleanPinned, colorById, earnedIds, frameById, isColor, isFrame, isUnlocked, lookFor,
  type Reward, type Visibility,
} from '../../shared/profile';
import { cleanPresets } from '../../shared/presets';
import type { Mailer } from './mailer';
import type { AccountStore, FriendLink, User, UserPatch } from './store';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

const COOKIE = 'bb_session';
const SESSION_DAYS = 60;
/** Profiles are built from at most this many recent games. */
const PROFILE_GAMES = 1000;
const RECENT_GAMES = 15;
/** A password-reset link works this long. */
const RESET_MINUTES = 60;
/** An email-confirmation link works this long. */
const CONFIRM_MINUTES = 7 * 24 * 60;
/** At most this many emails of each kind (reset, confirm) per account per hour. */
const LINKS_PER_HOUR = 3;

/** Who a socket is logged in as. */
export interface SocketAccount { id: string; username: string; admin: boolean }

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
const cleanEmail = (s: unknown) => String(s ?? '').trim().toLowerCase();
const badEmail = (e: string) => e.length > EMAIL_MAX || !EMAIL_RE.test(e);
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function toMe(u: User): Me {
  return { id: u.id, username: u.username, displayName: u.displayName, bio: u.bio, createdAt: u.createdAt, admin: isAdmin(u), ...(isAdmin(u) ? { adminLocked } : {}), settings: u.settings,
    visibility: u.visibility ?? 'public', pinned: cleanPinned(u.pinned), ...lookFor(u), email: u.email, emailVerified: !!u.email && !!u.emailVerified, usernameChangedAt: u.usernameChangedAt ?? null, presets: u.presets ?? [] };
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

  private mailer: Mailer | null;
  /** Where reset links point. Never taken from request headers in production (they can be forged). */
  private baseUrl: string | null;

  constructor(private store: AccountStore, opts: { mailer?: Mailer | null; publicUrl?: string } = {}) {
    this.mailer = opts.mailer ?? null;
    const url = opts.publicUrl ?? process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL;
    this.baseUrl = url ? url.replace(/\/+$/, '') : null;
  }

  private linkBase(req: Request) {
    if (this.baseUrl) return this.baseUrl;
    return process.env.NODE_ENV === 'production' ? null : `${req.protocol}://${req.get('host')}`;
  }

  /** Make a one-time link and email it. Quietly does nothing past the hourly limit. Returns whether it went out. */
  private async sendLink(u: User, kind: 'reset' | 'confirm', base: string) {
    // Logged by username only (never the address), so a missing email can be traced.
    if (!u.email || !this.mailer) { console.log(`No ${kind} email for @${u.username}: ${u.email ? 'email is not set up' : 'no email on the account'}`); return false; }
    if ((await this.store.countTokens(u.id, kind, Date.now() - 3600_000)) >= LINKS_PER_HOUR) { console.log(`No ${kind} email for @${u.username}: ${LINKS_PER_HOUR} already sent this hour`); return false; }
    const token = randomBytes(32).toString('base64url');
    const minutes = kind === 'reset' ? RESET_MINUTES : CONFIRM_MINUTES;
    const now = Date.now();
    const hash = sha256(token);
    await this.store.createToken({ hash, userId: u.id, kind, email: u.email, expiresAt: now + minutes * 60_000, createdAt: now });
    // In the fragment, so the token never reaches server logs or other sites.
    const link = `${base}/${kind}#${token}`;
    const name = escapeHtml(u.displayName), user = escapeHtml(u.username), href = escapeHtml(link);
    const mail = kind === 'reset'
      ? {
        subject: 'Reset your Trivio password',
        text: `Hi ${u.displayName},\n\nSomeone (hopefully you) asked to reset the password for @${u.username} on Trivio. `
          + `Open this link within an hour to pick a new one:\n\n${link}\n\nIf it wasn’t you, ignore this email. Your password stays the same.\n`,
        html: `<p>Hi ${name},</p><p>Someone (hopefully you) asked to reset the password for <b>@${user}</b> on Trivio. `
          + `Open this link within an hour to pick a new one:</p><p><a href="${href}">Reset your password</a></p>`
          + `<p style="color:#777">If it wasn’t you, ignore this email. Your password stays the same.</p>`,
      }
      : {
        subject: 'Confirm your email for Trivio',
        text: `Hi ${u.displayName},\n\nThis address was added to the Trivio account @${u.username}, so password-reset links can reach you. `
          + `Confirm it here (optional, works for a week):\n\n${link}\n\nIf this isn’t your account, ignore this email.\n`,
        html: `<p>Hi ${name},</p><p>This address was added to the Trivio account <b>@${user}</b>, so password-reset links can reach you. `
          + `Confirm it here (optional, works for a week):</p><p><a href="${href}">Confirm your email</a></p>`
          + `<p style="color:#777">If this isn’t your account, ignore this email.</p>`,
      };
    try {
      await this.mailer.send({ to: u.email, ...mail });
      console.log(`Sent a ${kind} email for @${u.username}`);
    } catch (e) {
      // It never reached them: don't let it use up one of the hour's links.
      await this.store.deleteToken(hash).catch(() => {});
      throw e;
    }
    return true;
  }

  /** Send a confirmation in the background (after sign-up or an email change). Never throws. */
  private confirmLater(u: User, req: Request) {
    const base = this.linkBase(req);
    if (!u.email || !base) return;
    this.sendLink(u, 'confirm', base).catch((e) => console.error('Could not send a confirmation email:', e?.message ?? e));
  }

  // ---------- site admin ----------

  /** How account email goes out: gmail, smtp, console, or off. */
  get mailKind() { return this.mailer ? this.mailer.kind ?? 'custom' : 'off'; }

  /** Accounts matching a search, for the admin panel. Emails stay private: only whether one is set and confirmed. */
  async adminSearch(query: string) {
    const q = String(query ?? '').trim().replace(/^@/, '').slice(0, 20);
    if (!this.ready || !q) return [];
    return (await this.store.searchUsers(q, 25)).map((u) => ({
      id: u.id, username: u.username, displayName: u.displayName, createdAt: u.createdAt, admin: isAdmin(u),
      email: !!u.email, emailVerified: !!u.email && !!u.emailVerified, usernameChangedAt: u.usernameChangedAt ?? null,
    }));
  }

  async adminCounts() {
    if (!this.ready) return null;
    return this.store.userCounts(Date.now() - 7 * 86_400_000);
  }

  /** Ends every session of an account. Returns its id (so live sockets can be dropped too), or null. */
  async adminLogout(username: string) {
    const u = this.ready ? await this.store.userByName(String(username ?? '')) : null;
    if (!u) return null;
    if (isAdmin(u)) throw new Error('Admin accounts can’t be logged out from here.');
    await this.store.deleteSessionsOf(u.id);
    console.log(`Admin logged out @${u.username} everywhere`);
    return u.id;
  }

  /** Sends a test email to this admin's own address. Throws with the reason when it can't. */
  async testEmail(accountId: string) {
    const u = await this.store.userById(accountId);
    if (!u?.email) throw new Error('Add an email to your account first (gear → Account settings).');
    if (!this.mailer) throw new Error('Email isn’t set up on this server.');
    await this.mailer.send({
      to: u.email, subject: 'Trivio test email',
      text: `This is a test from the Trivio admin panel, sent ${new Date().toUTCString()}. If you can read it, account emails work.\n`,
      html: `<p>This is a test from the Trivio admin panel, sent ${new Date().toUTCString()}.</p><p>If you can read it, account emails work.</p>`,
    });
  }

  /** Called after a username change, so other stores (leaderboards, live rooms) can follow. Never throws to the caller. */
  onRename?: (accountId: string, from: string, to: string) => Promise<void>;
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

  /**
   * A profile as `viewer` may see it. Stats, badges and games stay hidden unless the profile is public,
   * the viewer is a friend (friends only), the owner, or a site admin.
   */
  async profile(username: string, viewer: User | null = null): Promise<ProfileView | null> {
    const u = await this.store.userByName(username);
    if (!u) return null;
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
      res.json({ user: u ? toMe(u) : null });
    }));

    r.post('/signup', wrap(async (req, res) => {
      if (limited(req, res)) return;
      const username = String(req.body?.username ?? '').trim();
      const password = String(req.body?.password ?? '');
      const displayName = cleanName(req.body?.displayName) || username;
      const email = cleanEmail(req.body?.email) || null;
      if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Usernames are 3–20 letters, numbers or underscores.' });
      if (email && badEmail(email)) return res.status(400).json({ error: 'That email address doesn’t look right.' });
      if (password.length < PASSWORD_MIN) return res.status(400).json({ error: `Passwords need at least ${PASSWORD_MIN} characters.` });
      if (password.length > 200) return res.status(400).json({ error: 'That password is too long.' });
      const settings = req.body?.settings && typeof req.body.settings === 'object' ? req.body.settings : null;
      const user: User = {
        id: newId(), username, key: username.toLowerCase(), passwordHash: await hashPassword(password),
        displayName, bio: '', settings, createdAt: Date.now(), email,
      };
      if (!(await this.store.createUser(user))) {
        const nameTaken = !!(await this.store.userByName(username));
        return res.status(409).json({ error: nameTaken ? 'That username is taken.' : 'That email is already on another account.' });
      }
      await this.startSession(req, res, user.id);
      this.confirmLater(user, req);
      res.json({ user: toMe(user) });
    }));

    r.post('/login', wrap(async (req, res) => {
      if (limited(req, res)) return;
      // Username or email.
      const username = String(req.body?.username ?? '').trim();
      const password = String(req.body?.password ?? '');
      const u = !username ? null : username.includes('@') ? await this.store.userByEmail(username) : await this.store.userByName(username);
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
      const patch: UserPatch = {};
      if ('displayName' in b) {
        const n = cleanName(b.displayName);
        if (!n) return res.status(400).json({ error: 'Pick a display name.' });
        patch.displayName = n;
      }
      if ('bio' in b) patch.bio = String(b.bio ?? '').trim().slice(0, BIO_MAX);
      if ('settings' in b) patch.settings = b.settings && typeof b.settings === 'object' ? b.settings : null;
      if ('email' in b) {
        const email = cleanEmail(b.email) || null;
        if (email !== u.email) {
          // Whoever controls the email controls the account, so changing it takes the password.
          if (limited(req, res)) return;
          if (email && badEmail(email)) return res.status(400).json({ error: 'That email address doesn’t look right.' });
          if (!(await verifyPassword(String(b.password ?? ''), u.passwordHash))) return res.status(403).json({ error: 'Enter your current password to change your email.' });
          const other = email ? await this.store.userByEmail(email) : null;
          if (other && other.id !== u.id) return res.status(409).json({ error: 'That email is already on another account.' });
          patch.email = email;
          patch.emailVerified = false;
        }
      }
      if ('visibility' in b) {
        if (!VISIBILITIES.includes(b.visibility)) return res.status(400).json({ error: 'Pick who can see your profile.' });
        patch.visibility = b.visibility;
      }
      if ('pinned' in b) patch.pinned = cleanPinned(b.pinned);
      if ('presets' in b) patch.presets = cleanPresets(b.presets);
      if ('color' in b && !isColor(b.color)) return res.status(400).json({ error: 'Pick a profile color.' });
      if ('frame' in b && !isFrame(b.frame)) return res.status(400).json({ error: 'Pick an avatar frame.' });
      const wanted: Reward[] = [];
      if ('color' in b) { patch.color = b.color; wanted.push(colorById(b.color)); }
      if ('frame' in b) { patch.frame = b.frame; wanted.push(frameById(b.frame)); }
      if (wanted.some((r) => r.badge)) {
        const earned = await this.earnedBadges(u);
        const locked = wanted.find((r) => !isUnlocked(r, earned));
        if (locked) return res.status(403).json({ error: `Earn the ${BADGE_BY_ID.get(locked.badge!)?.name ?? locked.badge} badge to unlock ${locked.name}.` });
      }
      await this.store.updateUser(u.id, patch);
      if (patch.email) this.confirmLater({ ...u, ...patch }, req);
      res.json({ user: toMe({ ...u, ...patch }) });
    }));

    // ---------- account settings: username, password ----------

    r.post('/me/username', wrap(async (req, res) => {
      const u = await this.userFrom(req.headers.cookie);
      if (!u) return res.status(401).json({ error: 'Log in first.' });
      if (limited(req, res)) return;
      const username = String(req.body?.username ?? '').trim();
      if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Usernames are 3–20 letters, numbers or underscores.' });
      if (username === u.username) return res.status(400).json({ error: 'That’s already your username.' });
      const next = (u.usernameChangedAt ?? 0) + USERNAME_COOLDOWN_DAYS * 86_400_000;
      if (Date.now() < next) return res.status(429).json({ error: `You can change your username again on ${new Date(next).toUTCString().slice(0, 16)}.`, next });
      // Without ADMIN_ACCOUNT_IDS, admin goes by username: don't let a rename take or drop it.
      if (!adminLocked && (ADMINS.has(username.toLowerCase()) || ADMINS.has(u.username.toLowerCase())) && username.toLowerCase() !== u.key) {
        return res.status(403).json({ error: 'That username can’t be used.' });
      }
      const at = Date.now();
      if (!(await this.store.renameUser(u.id, username, at))) return res.status(409).json({ error: 'That username is taken.' });
      console.log(`@${u.username} is now @${username}`);
      await this.onRename?.(u.id, u.username, username).catch((e) => console.error('Could not carry a username change over:', e?.message ?? e));
      res.json({ user: toMe({ ...u, username, key: username.toLowerCase(), usernameChangedAt: at }) });
    }));

    r.post('/password/change', wrap(async (req, res) => {
      const u = await this.userFrom(req.headers.cookie);
      if (!u) return res.status(401).json({ error: 'Log in first.' });
      if (limited(req, res)) return;
      const password = String(req.body?.password ?? '');
      if (!(await verifyPassword(String(req.body?.current ?? ''), u.passwordHash))) return res.status(403).json({ error: 'Your current password isn’t right.' });
      if (password.length < PASSWORD_MIN) return res.status(400).json({ error: `Passwords need at least ${PASSWORD_MIN} characters.` });
      if (password.length > 200) return res.status(400).json({ error: 'That password is too long.' });
      await this.store.updateUser(u.id, { passwordHash: await hashPassword(password) });
      await this.store.deleteSessionsOf(u.id); // other devices log out; this one gets a fresh session
      await this.startSession(req, res, u.id);
      res.json({ user: toMe(u) });
    }));

    // ---------- password reset ----------

    r.post('/password/forgot', wrap(async (req, res) => {
      if (limited(req, res)) return;
      const base = this.linkBase(req);
      if (!this.mailer || !base) return res.status(503).json({ error: 'Password reset by email isn’t set up on this server yet.' });
      const who = String(req.body?.login ?? '').trim();
      const u = !who ? null : who.includes('@') ? await this.store.userByEmail(who) : await this.store.userByName(who);
      // Same answer either way, so this can't be used to find out who has an account or which email they use.
      res.json({ ok: true });
      if (!u) console.log(`Password reset asked for an unknown ${who.includes('@') ? 'email' : `username "${who.slice(0, 20)}"`}`);
      if (u) this.sendLink(u, 'reset', base).catch((e) => console.error('Could not send a password-reset email:', e?.message ?? e));
    }));

    r.post('/password/reset', wrap(async (req, res) => {
      if (limited(req, res)) return;
      const token = String(req.body?.token ?? '');
      const password = String(req.body?.password ?? '');
      // Check the new password first so a typo doesn't use up the link.
      if (password.length < PASSWORD_MIN) return res.status(400).json({ error: `Passwords need at least ${PASSWORD_MIN} characters.` });
      if (password.length > 200) return res.status(400).json({ error: 'That password is too long.' });
      const t = token ? await this.store.takeToken(sha256(token), 'reset') : null;
      const u = t ? await this.store.userById(t.userId) : null;
      if (!u) return res.status(400).json({ error: 'That reset link has expired or was already used. Ask for a new one.' });
      // Opening a link sent to the address proves it's theirs, so this confirms it too.
      const confirms = !!u.email && t!.email === u.email;
      await this.store.updateUser(u.id, { passwordHash: await hashPassword(password), ...(confirms ? { emailVerified: true } : {}) });
      if (confirms) u.emailVerified = true;
      await this.store.deleteSessionsOf(u.id); // logs out every device, including one someone else had
      await this.startSession(req, res, u.id);
      console.log(`@${u.username} reset their password`);
      res.json({ user: toMe(u) });
    }));

    // ---------- confirming an email (optional) ----------

    /** Opened from the emailed link, on any device, logged in or not. */
    r.post('/email/confirm', wrap(async (req, res) => {
      if (limited(req, res)) return;
      const token = String(req.body?.token ?? '');
      const t = token ? await this.store.takeToken(sha256(token), 'confirm') : null;
      const u = t ? await this.store.userById(t.userId) : null;
      if (!u || !u.email || u.email !== t!.email) {
        return res.status(400).json({ error: 'That link has expired, was already used, or is for an email the account no longer uses. You can send a new one from Edit profile.' });
      }
      if (!u.emailVerified) await this.store.updateUser(u.id, { emailVerified: true });
      res.json({ ok: true, username: u.username });
    }));

    /** Send the confirmation link again. */
    r.post('/email/confirm/send', wrap(async (req, res) => {
      const u = await this.userFrom(req.headers.cookie);
      if (!u) return res.status(401).json({ error: 'Log in first.' });
      if (!u.email) return res.status(400).json({ error: 'Add an email first.' });
      if (u.emailVerified) return res.json({ ok: true });
      const base = this.linkBase(req);
      if (!this.mailer || !base) return res.status(503).json({ error: 'Email isn’t set up on this server yet.' });
      let sent: boolean;
      try {
        sent = await this.sendLink(u, 'confirm', base);
      } catch (e: any) {
        console.error('Could not send a confirmation email:', e?.message ?? e);
        return res.status(502).json({ error: 'The email couldn’t be sent right now. Try again in a few minutes.' });
      }
      if (!sent) return res.status(429).json({ error: 'A few links were already sent this hour. Check your inbox and spam folder, or try again later.' });
      res.json({ ok: true });
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
        const look = lookFor(u, await this.earnedBadges({ ...u, grantedBadges }));
        if (look.color !== (u.color ?? look.color) || look.frame !== (u.frame ?? look.frame)) await this.store.updateUser(u.id, look);
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
