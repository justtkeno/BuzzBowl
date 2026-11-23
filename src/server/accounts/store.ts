import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import type { GameRecord } from '../../shared/accounts';
import type { Visibility } from '../../shared/profile';

export interface User {
  id: string;
  username: string;
  /** Lowercased username, unique. */
  key: string;
  passwordHash: string;
  displayName: string;
  bio: string;
  settings: Record<string, unknown> | null;
  createdAt: number;
  /** Lowercased, unique. Only used for account email (password resets, confirming it); never shown to others. */
  email: string | null;
  /** The owner opened the confirmation link sent to `email`. Optional: resets work either way. */
  emailVerified?: boolean;
  /** When the username last changed. */
  usernameChangedAt?: number;
  /** Who can see their profile stats. Missing means public. */
  visibility?: Visibility;
  /** Stat ids pinned to the top of their profile. */
  pinned?: string[];
  /** Badges a site admin unlocked for them, earned or not. */
  grantedBadges?: string[];
  /** Badge rewards they picked (ids from PROFILE_COLORS / AVATAR_FRAMES). Missing means the default. */
  color?: string;
  frame?: string;
  /** Titles a site admin gave them ('special:<id>' or 'custom:<text>', see shared/profile.ts). */
  titles?: string[];
  /** The title they show with their name (a key from titleOptions), or null for none. */
  title?: string | null;
}

/** A friend request from `from` to `to`; once accepted, the two are friends. */
export interface FriendLink { from: string; to: string; accepted: boolean; at: number }

/** A one-time emailed link: a password reset, or confirming an email address (`email` is the address it was sent to). */
export interface AccountToken { hash: string; userId: string; kind: 'reset' | 'confirm'; email: string | null; expiresAt: number; createdAt: number }

export type UserPatch = Partial<Pick<User, 'displayName' | 'bio' | 'settings' | 'visibility' | 'pinned' | 'grantedBadges' | 'color' | 'frame' | 'titles' | 'title' | 'email' | 'emailVerified' | 'passwordHash'>>;

/** Where accounts live. Postgres in production, a JSON file for local development and tests. */
export interface AccountStore {
  init(): Promise<void>;
  /** Returns null when the username is taken. */
  createUser(u: User): Promise<User | null>;
  userById(id: string): Promise<User | null>;
  userByName(username: string): Promise<User | null>;
  userByEmail(email: string): Promise<User | null>;
  /** Usernames containing `query` (case-insensitive), names starting with it first. */
  searchUsers(query: string, limit: number): Promise<User[]>;
  /** Account totals for the admin panel. */
  userCounts(since: number): Promise<{ total: number; withEmail: number; confirmed: number; newSince: number }>;
  updateUser(id: string, patch: UserPatch): Promise<void>;
  /** Changes the username. False when someone else has it. */
  renameUser(id: string, username: string, at: number): Promise<boolean>;
  /** Removes the user with their sessions and games. */
  deleteUser(id: string): Promise<void>;
  createSession(tokenHash: string, userId: string, expiresAt: number): Promise<void>;
  /** The user id for a live session, or null. */
  session(tokenHash: string): Promise<string | null>;
  deleteSession(tokenHash: string): Promise<void>;
  /** Logs the user out everywhere (after a password reset). */
  deleteSessionsOf(userId: string): Promise<void>;
  createToken(t: AccountToken): Promise<void>;
  /** How many links of this kind were made for this user since `since`. */
  countTokens(userId: string, kind: AccountToken['kind'], since: number): Promise<number>;
  /** Uses up a link: who it was for, if it was live and of this kind, else null. Either way it can't be used again. */
  takeToken(tokenHash: string, kind: AccountToken['kind']): Promise<{ userId: string; email: string | null } | null>;
  /** Forget a link that never went out, so it doesn't count toward the hourly limit. */
  deleteToken(tokenHash: string): Promise<void>;
  addGames(entries: { userId: string; game: GameRecord }[]): Promise<void>;
  /** Newest first. */
  games(userId: string, limit: number): Promise<GameRecord[]>;
  usersByIds(ids: string[]): Promise<User[]>;
  /** Every friend link (either direction) that involves this user. */
  friendLinks(userId: string): Promise<FriendLink[]>;
  /** Adds a pending request unless there is already a link from `from` to `to`. */
  requestFriend(from: string, to: string, at: number): Promise<void>;
  /** Accepts a pending request from `from` to `to`. Returns false when there was none. */
  acceptFriend(from: string, to: string): Promise<boolean>;
  /** Removes any link between the two, in both directions. */
  removeFriend(a: string, b: string): Promise<void>;
  readonly kind: string;
}

// ---------- JSON file (local) ----------

interface FileData {
  users: User[];
  sessions: { hash: string; userId: string; expiresAt: number }[];
  games: { userId: string; game: GameRecord }[];
  tokens: AccountToken[];
  friends: FriendLink[];
}

export class FileAccountStore implements AccountStore {
  readonly kind = 'file';
  private d: FileData = { users: [], sessions: [], games: [], tokens: [], friends: [] };
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private file: string | null) {}

  async init() {
    if (!this.file || !existsSync(this.file)) return;
    try {
      this.d = { users: [], sessions: [], games: [], tokens: [], friends: [], ...JSON.parse(readFileSync(this.file, 'utf8')) };
      for (const u of this.d.users) u.email ??= null;
    } catch (e) {
      console.error(`Could not read ${this.file}:`, e);
    }
  }

  private save() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.flush(), 200);
    this.timer.unref?.();
  }

  /** Write now (also called on shutdown). */
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const now = Date.now();
      this.d.sessions = this.d.sessions.filter((s) => s.expiresAt > now);
      // Used and expired links stay a day so they still count toward the hourly limit.
      this.d.tokens = this.d.tokens.filter((t) => t.createdAt > now - 7 * 86_400_000);
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.d));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (e) {
      console.error('Could not save accounts:', e);
    }
  }

  async createUser(u: User) {
    if (this.d.users.some((x) => x.key === u.key || (u.email && x.email === u.email))) return null;
    this.d.users.push(structuredClone(u));
    this.save();
    return u;
  }
  async userById(id: string) { return structuredClone(this.d.users.find((u) => u.id === id) ?? null); }
  async userByName(username: string) {
    const key = username.toLowerCase();
    return structuredClone(this.d.users.find((u) => u.key === key) ?? null);
  }
  async searchUsers(query: string, limit: number) {
    const q = query.toLowerCase();
    const hits = this.d.users.filter((u) => u.key.includes(q));
    hits.sort((a, b) => Number(!a.key.startsWith(q)) - Number(!b.key.startsWith(q)) || a.key.localeCompare(b.key));
    return structuredClone(hits.slice(0, limit));
  }
  async userCounts(since: number) {
    const u = this.d.users;
    return { total: u.length, withEmail: u.filter((x) => x.email).length, confirmed: u.filter((x) => x.email && x.emailVerified).length, newSince: u.filter((x) => x.createdAt >= since).length };
  }
  async userByEmail(email: string) {
    const e = email.toLowerCase();
    return structuredClone(this.d.users.find((u) => u.email === e) ?? null);
  }
  async updateUser(id: string, patch: UserPatch) {
    const u = this.d.users.find((x) => x.id === id);
    if (!u) return;
    Object.assign(u, structuredClone(patch));
    this.save();
  }
  async renameUser(id: string, username: string, at: number) {
    const key = username.toLowerCase();
    const u = this.d.users.find((x) => x.id === id);
    if (!u || this.d.users.some((x) => x.key === key && x.id !== id)) return false;
    Object.assign(u, { username, key, usernameChangedAt: at });
    this.save();
    return true;
  }
  async deleteUser(id: string) {
    this.d.users = this.d.users.filter((u) => u.id !== id);
    this.d.sessions = this.d.sessions.filter((s) => s.userId !== id);
    this.d.games = this.d.games.filter((g) => g.userId !== id);
    this.d.tokens = this.d.tokens.filter((t) => t.userId !== id);
    this.d.friends = this.d.friends.filter((f) => f.from !== id && f.to !== id);
    this.save();
  }
  async createSession(hash: string, userId: string, expiresAt: number) {
    this.d.sessions.push({ hash, userId, expiresAt });
    this.save();
  }
  async session(hash: string) {
    const s = this.d.sessions.find((x) => x.hash === hash);
    return s && s.expiresAt > Date.now() ? s.userId : null;
  }
  async deleteSession(hash: string) {
    this.d.sessions = this.d.sessions.filter((s) => s.hash !== hash);
    this.save();
  }
  async deleteSessionsOf(userId: string) {
    this.d.sessions = this.d.sessions.filter((s) => s.userId !== userId);
    this.save();
  }
  async createToken(t: AccountToken) {
    this.d.tokens.push({ ...t });
    this.save();
  }
  async countTokens(userId: string, kind: AccountToken['kind'], since: number) {
    return this.d.tokens.filter((t) => t.userId === userId && t.kind === kind && t.createdAt >= since).length;
  }
  async takeToken(hash: string, kind: AccountToken['kind']) {
    const t = this.d.tokens.find((x) => x.hash === hash && x.kind === kind);
    if (!t) return null;
    // Spent, but kept (expired) until it ages out so it still counts toward the rate limit.
    const live = t.expiresAt > Date.now();
    t.expiresAt = Math.min(t.expiresAt, Date.now());
    this.save();
    return live ? { userId: t.userId, email: t.email } : null;
  }
  async deleteToken(hash: string) {
    this.d.tokens = this.d.tokens.filter((t) => t.hash !== hash);
    this.save();
  }
  async addGames(entries: { userId: string; game: GameRecord }[]) {
    this.d.games.push(...structuredClone(entries));
    this.save();
  }
  async games(userId: string, limit: number) {
    const out: GameRecord[] = [];
    for (let i = this.d.games.length - 1; i >= 0 && out.length < limit; i--) {
      if (this.d.games[i].userId === userId) out.push(structuredClone(this.d.games[i].game));
    }
    return out;
  }
  async usersByIds(ids: string[]) {
    const want = new Set(ids);
    return structuredClone(this.d.users.filter((u) => want.has(u.id)));
  }
  async friendLinks(userId: string) {
    return structuredClone(this.d.friends.filter((f) => f.from === userId || f.to === userId));
  }
  async requestFriend(from: string, to: string, at: number) {
    if (this.d.friends.some((f) => f.from === from && f.to === to)) return;
    this.d.friends.push({ from, to, accepted: false, at });
    this.save();
  }
  async acceptFriend(from: string, to: string) {
    const f = this.d.friends.find((x) => x.from === from && x.to === to && !x.accepted);
    if (!f) return false;
    f.accepted = true;
    this.save();
    return true;
  }
  async removeFriend(a: string, b: string) {
    this.d.friends = this.d.friends.filter((f) => !((f.from === a && f.to === b) || (f.from === b && f.to === a)));
    this.save();
  }
}

// ---------- Postgres (production) ----------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  settings JSONB,
  created_at BIGINT NOT NULL
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'public';
ALTER TABLE users ADD COLUMN IF NOT EXISTS pinned JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS granted_badges JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS color TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS frame TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS titles JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS title TEXT;
CREATE TABLE IF NOT EXISTS sessions (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS games (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at BIGINT NOT NULL,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS games_user_at ON games (user_id, at DESC);
CREATE TABLE IF NOT EXISTS friends (
  from_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  accepted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS friends_to ON friends (to_id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS username_changed_at BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (email) WHERE email IS NOT NULL;
CREATE TABLE IF NOT EXISTS account_tokens (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  email TEXT,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS account_tokens_user ON account_tokens (user_id, kind, created_at);
`;

interface UserRow {
  id: string; username: string; key: string; password_hash: string; display_name: string; bio: string;
  settings: Record<string, unknown> | null; created_at: string; visibility: Visibility | null; pinned: string[] | null; granted_badges: string[] | null;
  color: string | null; frame: string | null; email: string | null; email_verified: boolean | null; username_changed_at: string | null;
  titles: string[] | null; title: string | null;
}
const fromRow = (r: UserRow | undefined): User | null => r ? {
  id: r.id, username: r.username, key: r.key, passwordHash: r.password_hash, displayName: r.display_name,
  bio: r.bio, settings: r.settings, createdAt: Number(r.created_at),
  visibility: r.visibility ?? 'public', pinned: r.pinned ?? [], grantedBadges: r.granted_badges ?? [],
  ...(r.color ? { color: r.color } : {}), ...(r.frame ? { frame: r.frame } : {}),
  titles: r.titles ?? [], title: r.title ?? null,
  email: r.email ?? null, emailVerified: !!r.email_verified,
  ...(r.username_changed_at ? { usernameChangedAt: Number(r.username_changed_at) } : {}),
} : null;

export class PgAccountStore implements AccountStore {
  readonly kind = 'postgres';
  private pool: pg.Pool;

  constructor(url: string) {
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    // Hosted databases (Neon, Supabase, Render) require TLS.
    this.pool = new pg.Pool({ connectionString: url, max: 5, ssl: local ? undefined : { rejectUnauthorized: false } });
    this.pool.on('error', (e) => console.error('Postgres pool error:', e.message));
  }

  async init() {
    await this.pool.query(SCHEMA);
    await this.pool.query('DELETE FROM sessions WHERE expires_at < $1', [Date.now()]);
    await this.pool.query('DELETE FROM account_tokens WHERE created_at < $1', [Date.now() - 7 * 86_400_000]);
  }

  async createUser(u: User) {
    const r = await this.pool.query(
      `INSERT INTO users (id, username, key, password_hash, display_name, bio, settings, created_at, email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
      [u.id, u.username, u.key, u.passwordHash, u.displayName, u.bio, u.settings, u.createdAt, u.email],
    );
    return r.rowCount ? u : null;
  }
  async userById(id: string) {
    return fromRow((await this.pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [id])).rows[0]);
  }
  async userByName(username: string) {
    return fromRow((await this.pool.query<UserRow>('SELECT * FROM users WHERE key = $1', [username.toLowerCase()])).rows[0]);
  }
  async searchUsers(query: string, limit: number) {
    const q = query.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
    const r = await this.pool.query<UserRow>(
      "SELECT * FROM users WHERE key LIKE '%' || $1 || '%' ORDER BY (key LIKE $1 || '%') DESC, key LIMIT $2", [q, limit]);
    return r.rows.map((x) => fromRow(x)!);
  }
  async userCounts(since: number) {
    const r = await this.pool.query<{ total: number; with_email: number; confirmed: number; new_since: number }>(
      `SELECT count(*)::int AS total, count(email)::int AS with_email, count(*) FILTER (WHERE email IS NOT NULL AND email_verified)::int AS confirmed,
       count(*) FILTER (WHERE created_at >= $1)::int AS new_since FROM users`, [since]);
    const x = r.rows[0];
    return { total: x.total, withEmail: x.with_email, confirmed: x.confirmed, newSince: x.new_since };
  }
  async userByEmail(email: string) {
    return fromRow((await this.pool.query<UserRow>('SELECT * FROM users WHERE email = $1', [email.toLowerCase()])).rows[0]);
  }
  async updateUser(id: string, patch: UserPatch) {
    const cols: Record<keyof UserPatch, string> = {
      displayName: 'display_name', bio: 'bio', settings: 'settings', visibility: 'visibility', pinned: 'pinned', grantedBadges: 'granted_badges',
      color: 'color', frame: 'frame', titles: 'titles', title: 'title', email: 'email', emailVerified: 'email_verified', passwordHash: 'password_hash',
    };
    const keys = (Object.keys(patch) as (keyof UserPatch)[]).filter((k) => k in cols);
    if (!keys.length) return;
    const sets = keys.map((k, i) => `${cols[k]} = $${i + 2}`).join(', ');
    // node-pg would send a JS array as a Postgres array, not JSON.
    const value = (k: keyof UserPatch) => (Array.isArray(patch[k]) ? JSON.stringify(patch[k]) : patch[k]);
    await this.pool.query(`UPDATE users SET ${sets} WHERE id = $1`, [id, ...keys.map(value)]);
  }
  async renameUser(id: string, username: string, at: number) {
    try {
      const r = await this.pool.query('UPDATE users SET username = $2, key = $3, username_changed_at = $4 WHERE id = $1', [id, username, username.toLowerCase(), at]);
      return !!r.rowCount;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return false; // the name is taken (unique key)
      throw e;
    }
  }

  async deleteUser(id: string) {
    // sessions and games go with it (ON DELETE CASCADE).
    await this.pool.query('DELETE FROM users WHERE id = $1', [id]);
  }
  async createSession(hash: string, userId: string, expiresAt: number) {
    await this.pool.query('INSERT INTO sessions (hash, user_id, expires_at) VALUES ($1,$2,$3)', [hash, userId, expiresAt]);
  }
  async session(hash: string) {
    const r = await this.pool.query<{ user_id: string }>('SELECT user_id FROM sessions WHERE hash = $1 AND expires_at > $2', [hash, Date.now()]);
    return r.rows[0]?.user_id ?? null;
  }
  async deleteSession(hash: string) {
    await this.pool.query('DELETE FROM sessions WHERE hash = $1', [hash]);
  }
  async deleteSessionsOf(userId: string) {
    await this.pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  }
  async createToken(t: AccountToken) {
    await this.pool.query('INSERT INTO account_tokens (hash, user_id, kind, email, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [t.hash, t.userId, t.kind, t.email, t.expiresAt, t.createdAt]);
  }
  async countTokens(userId: string, kind: AccountToken['kind'], since: number) {
    const r = await this.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM account_tokens WHERE user_id = $1 AND kind = $2 AND created_at >= $3', [userId, kind, since]);
    return r.rows[0].n;
  }
  async takeToken(hash: string, kind: AccountToken['kind']) {
    // Spend it atomically; the row stays (expired) so it still counts toward the rate limit.
    const now = Date.now();
    const r = await this.pool.query<{ user_id: string; email: string | null }>(
      'UPDATE account_tokens SET expires_at = $3 WHERE hash = $1 AND kind = $2 AND expires_at > $3 RETURNING user_id, email', [hash, kind, now]);
    return r.rows[0] ? { userId: r.rows[0].user_id, email: r.rows[0].email } : null;
  }
  async deleteToken(hash: string) {
    await this.pool.query('DELETE FROM account_tokens WHERE hash = $1', [hash]);
  }
  async addGames(entries: { userId: string; game: GameRecord }[]) {
    for (const e of entries) {
      await this.pool.query('INSERT INTO games (user_id, at, data) VALUES ($1,$2,$3)', [e.userId, e.game.at, e.game]);
    }
  }
  async games(userId: string, limit: number) {
    const r = await this.pool.query<{ data: GameRecord }>('SELECT data FROM games WHERE user_id = $1 ORDER BY at DESC LIMIT $2', [userId, limit]);
    return r.rows.map((x) => x.data);
  }
  async usersByIds(ids: string[]) {
    if (!ids.length) return [];
    const r = await this.pool.query<UserRow>('SELECT * FROM users WHERE id = ANY($1)', [ids]);
    return r.rows.map((x) => fromRow(x)!);
  }
  async friendLinks(userId: string) {
    const r = await this.pool.query<{ from_id: string; to_id: string; accepted: boolean; created_at: string }>(
      'SELECT from_id, to_id, accepted, created_at FROM friends WHERE from_id = $1 OR to_id = $1', [userId]);
    return r.rows.map((x) => ({ from: x.from_id, to: x.to_id, accepted: x.accepted, at: Number(x.created_at) }));
  }
  async requestFriend(from: string, to: string, at: number) {
    await this.pool.query('INSERT INTO friends (from_id, to_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [from, to, at]);
  }
  async acceptFriend(from: string, to: string) {
    const r = await this.pool.query('UPDATE friends SET accepted = TRUE WHERE from_id = $1 AND to_id = $2 AND NOT accepted', [from, to]);
    return !!r.rowCount;
  }
  async removeFriend(a: string, b: string) {
    await this.pool.query('DELETE FROM friends WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)', [a, b]);
  }
}
