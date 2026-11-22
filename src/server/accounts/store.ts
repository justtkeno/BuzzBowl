import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import type { GameRecord } from '../../shared/accounts';

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
  /** Lowercased, unique. Only used for password resets; never shown to others. */
  email: string | null;
}

export type UserPatch = Partial<Pick<User, 'displayName' | 'bio' | 'settings' | 'email' | 'passwordHash'>>;

/** Where accounts live. Postgres in production, a JSON file for local development and tests. */
export interface AccountStore {
  init(): Promise<void>;
  /** Returns null when the username is taken. */
  createUser(u: User): Promise<User | null>;
  userById(id: string): Promise<User | null>;
  userByName(username: string): Promise<User | null>;
  userByEmail(email: string): Promise<User | null>;
  updateUser(id: string, patch: UserPatch): Promise<void>;
  /** Removes the user with their sessions and games. */
  deleteUser(id: string): Promise<void>;
  createSession(tokenHash: string, userId: string, expiresAt: number): Promise<void>;
  /** The user id for a live session, or null. */
  session(tokenHash: string): Promise<string | null>;
  deleteSession(tokenHash: string): Promise<void>;
  /** Logs the user out everywhere (after a password reset). */
  deleteSessionsOf(userId: string): Promise<void>;
  createReset(tokenHash: string, userId: string, expiresAt: number): Promise<void>;
  /** How many reset links were made for this user since `since`. */
  countResets(userId: string, since: number): Promise<number>;
  /** Uses up a reset token: the user id if it was live, else null. Either way it can't be used again. */
  takeReset(tokenHash: string): Promise<string | null>;
  addGames(entries: { userId: string; game: GameRecord }[]): Promise<void>;
  /** Newest first. */
  games(userId: string, limit: number): Promise<GameRecord[]>;
  readonly kind: string;
}

// ---------- JSON file (local) ----------

interface FileData {
  users: User[];
  sessions: { hash: string; userId: string; expiresAt: number }[];
  games: { userId: string; game: GameRecord }[];
  resets: { hash: string; userId: string; expiresAt: number; createdAt: number }[];
}

export class FileAccountStore implements AccountStore {
  readonly kind = 'file';
  private d: FileData = { users: [], sessions: [], games: [], resets: [] };
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private file: string | null) {}

  async init() {
    if (!this.file || !existsSync(this.file)) return;
    try {
      this.d = { users: [], sessions: [], games: [], resets: [], ...JSON.parse(readFileSync(this.file, 'utf8')) };
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
      this.d.resets = this.d.resets.filter((r) => r.createdAt > now - 86_400_000);
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
  async deleteUser(id: string) {
    this.d.users = this.d.users.filter((u) => u.id !== id);
    this.d.sessions = this.d.sessions.filter((s) => s.userId !== id);
    this.d.games = this.d.games.filter((g) => g.userId !== id);
    this.d.resets = this.d.resets.filter((r) => r.userId !== id);
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
  async createReset(hash: string, userId: string, expiresAt: number) {
    this.d.resets.push({ hash, userId, expiresAt, createdAt: Date.now() });
    this.save();
  }
  async countResets(userId: string, since: number) {
    return this.d.resets.filter((r) => r.userId === userId && r.createdAt >= since).length;
  }
  async takeReset(hash: string) {
    const r = this.d.resets.find((x) => x.hash === hash);
    if (!r) return null;
    // Spent, but kept (expired) until it ages out so it still counts toward the rate limit.
    const live = r.expiresAt > Date.now();
    r.expiresAt = Math.min(r.expiresAt, Date.now());
    this.save();
    return live ? r.userId : null;
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
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (email) WHERE email IS NOT NULL;
CREATE TABLE IF NOT EXISTS password_resets (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets (user_id, created_at);
`;

interface UserRow {
  id: string; username: string; key: string; password_hash: string; display_name: string; bio: string;
  settings: Record<string, unknown> | null; created_at: string; email: string | null;
}
const fromRow = (r: UserRow | undefined): User | null => r ? {
  id: r.id, username: r.username, key: r.key, passwordHash: r.password_hash, displayName: r.display_name,
  bio: r.bio, settings: r.settings, createdAt: Number(r.created_at), email: r.email ?? null,
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
    await this.pool.query('DELETE FROM password_resets WHERE created_at < $1', [Date.now() - 86_400_000]);
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
  async userByEmail(email: string) {
    return fromRow((await this.pool.query<UserRow>('SELECT * FROM users WHERE email = $1', [email.toLowerCase()])).rows[0]);
  }
  async updateUser(id: string, patch: UserPatch) {
    const cols: Record<keyof UserPatch, string> = { displayName: 'display_name', bio: 'bio', settings: 'settings', email: 'email', passwordHash: 'password_hash' };
    const keys = (Object.keys(patch) as (keyof UserPatch)[]).filter((k) => k in cols);
    if (!keys.length) return;
    const sets = keys.map((k, i) => `${cols[k]} = $${i + 2}`).join(', ');
    await this.pool.query(`UPDATE users SET ${sets} WHERE id = $1`, [id, ...keys.map((k) => patch[k])]);
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
  async createReset(hash: string, userId: string, expiresAt: number) {
    await this.pool.query('INSERT INTO password_resets (hash, user_id, expires_at, created_at) VALUES ($1,$2,$3,$4)', [hash, userId, expiresAt, Date.now()]);
  }
  async countResets(userId: string, since: number) {
    const r = await this.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM password_resets WHERE user_id = $1 AND created_at >= $2', [userId, since]);
    return r.rows[0].n;
  }
  async takeReset(hash: string) {
    // Spend it atomically; the row stays (expired) so it still counts toward the rate limit.
    const now = Date.now();
    const r = await this.pool.query<{ user_id: string }>(
      'UPDATE password_resets SET expires_at = $2 WHERE hash = $1 AND expires_at > $2 RETURNING user_id', [hash, now]);
    return r.rows[0]?.user_id ?? null;
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
}
