import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { BOOST_MAX_MINUTES, BOOST_MAX_MULTIPLIER, type BoostView, type XpBoost } from '../../shared/levels';

/** Where boosts are kept, so a restart (or the free plan waking up) doesn't end one early. */
export interface BoostStore {
  init(): Promise<void>;
  all(): Promise<XpBoost[]>;
  add(b: XpBoost): Promise<void>;
  /** Ends a boost now. */
  end(id: string, at: number): Promise<boolean>;
  flush(): void;
}

export class FileBoostStore implements BoostStore {
  private items: XpBoost[] = [];
  constructor(private file: string | null) {}
  async init() {
    if (!this.file || !existsSync(this.file)) return;
    try { this.items = JSON.parse(readFileSync(this.file, 'utf8')).items ?? []; } catch (e) { console.error(`Could not read ${this.file}:`, e); }
  }
  flush() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ items: this.items }));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (e) { console.error('Could not save boosts:', e); }
  }
  async all() { return structuredClone(this.items); }
  async add(b: XpBoost) {
    // Old, finished boosts don't need keeping.
    this.items = [...this.items.filter((x) => x.endsAt > Date.now() - 86_400_000), structuredClone(b)];
    this.flush();
  }
  async end(id: string, at: number) {
    const b = this.items.find((x) => x.id === id);
    if (!b || b.endsAt <= at) return false;
    b.endsAt = at;
    this.flush();
    return true;
  }
}

interface Row { id: string; multiplier: number; started_at: string; ends_at: string; account_id: string | null; username: string | null }

export class PgBoostStore implements BoostStore {
  private pool: pg.Pool;
  constructor(url: string) {
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    this.pool = new pg.Pool({ connectionString: url, max: 2, ssl: local ? undefined : { rejectUnauthorized: false } });
    this.pool.on('error', (e) => console.error('Postgres pool error (boosts):', e.message));
  }
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS xp_boosts (
      id TEXT PRIMARY KEY, multiplier REAL NOT NULL, started_at BIGINT NOT NULL, ends_at BIGINT NOT NULL,
      account_id TEXT, username TEXT
    )`);
  }
  async all() {
    const r = await this.pool.query<Row>('SELECT * FROM xp_boosts WHERE ends_at > $1', [Date.now() - 86_400_000]);
    return r.rows.map((x) => ({ id: x.id, multiplier: Number(x.multiplier), startedAt: Number(x.started_at), endsAt: Number(x.ends_at), accountId: x.account_id, username: x.username }));
  }
  async add(b: XpBoost) {
    await this.pool.query('INSERT INTO xp_boosts (id, multiplier, started_at, ends_at, account_id, username) VALUES ($1,$2,$3,$4,$5,$6)',
      [b.id, b.multiplier, b.startedAt, b.endsAt, b.accountId, b.username]);
  }
  async end(id: string, at: number) {
    return !!(await this.pool.query('UPDATE xp_boosts SET ends_at = $2 WHERE id = $1 AND ends_at > $2', [id, at])).rowCount;
  }
  flush() {}
}

export class BoostError extends Error {}

/**
 * XP boosts a site admin starts: a multiplier for everyone or one account, for a while. Kept in memory
 * (read from the store at startup) so games can look them up without a database trip.
 */
export class Boosts {
  ready: Promise<void>;
  private list: XpBoost[] = [];
  /** Called when boosts change, so open screens can show the new state. */
  onChange?: () => void;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private store: BoostStore) {
    this.ready = store.init().then(async () => { this.list = await store.all(); this.schedule(); })
      .catch((e) => console.error('Boosts unavailable:', e));
  }

  /** Running boosts, soonest to end first. */
  active(now = Date.now()) { return this.list.filter((b) => b.startedAt <= now && b.endsAt > now).sort((a, b) => a.endsAt - b.endsAt); }

  /** The XP multiplier for an account right now: the biggest boost on everyone or on them. 1 when none. */
  multiplierFor(accountId: string | null | undefined, now = Date.now()) {
    return Math.max(1, ...this.active(now).filter((b) => !b.accountId || b.accountId === accountId).map((b) => b.multiplier));
  }

  /** What a player (or a guest, with no account) sees. */
  viewFor(accountId: string | null | undefined, now = Date.now()): BoostView | null {
    const mine = this.active(now).filter((b) => !b.accountId || b.accountId === accountId);
    if (!mine.length) return null;
    const best = mine.reduce((a, b) => (b.multiplier > a.multiplier || (b.multiplier === a.multiplier && b.endsAt > a.endsAt) ? b : a));
    return { multiplier: best.multiplier, endsAt: best.endsAt, personal: !!best.accountId };
  }

  async start(input: { multiplier?: unknown; minutes?: unknown }, account: { id: string; username: string } | null) {
    const multiplier = Math.round(Number(input.multiplier) * 10) / 10;
    const minutes = Math.round(Number(input.minutes));
    if (!(multiplier > 1 && multiplier <= BOOST_MAX_MULTIPLIER)) throw new BoostError(`Pick a boost above 1× and up to ${BOOST_MAX_MULTIPLIER}×.`);
    if (!(minutes >= 1 && minutes <= BOOST_MAX_MINUTES)) throw new BoostError('Pick a length from 1 minute to 7 days.');
    const now = Date.now();
    const b: XpBoost = { id: randomBytes(6).toString('hex'), multiplier, startedAt: now, endsAt: now + minutes * 60_000, accountId: account?.id ?? null, username: account?.username ?? null };
    await this.ready;
    await this.store.add(b);
    this.list = [...this.list.filter((x) => x.endsAt > now - 86_400_000), b];
    this.changed();
    return b;
  }

  async end(id: unknown) {
    const now = Date.now();
    await this.ready;
    const ok = await this.store.end(String(id ?? ''), now);
    const b = this.list.find((x) => x.id === id);
    if (b && b.endsAt > now) b.endsAt = now;
    this.changed();
    return ok;
  }

  private changed() { this.schedule(); this.onChange?.(); }

  /** Tell screens again when the next boost runs out. */
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const next = this.active()[0];
    if (!next) return;
    this.timer = setTimeout(() => this.changed(), Math.min(next.endsAt - Date.now() + 50, 2 ** 31 - 1));
    this.timer.unref?.();
  }

  flush() { this.store.flush(); }
}
