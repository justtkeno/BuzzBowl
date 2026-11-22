import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import type { Tossup } from '../questions/types';

export interface DailyRow {
  day: string;
  playerKey: string;
  name: string;
  username?: string;
  points: number;
  powers: number;
  tens: number;
  negs: number;
  marks: string;
  depth: number | null;
  createdAt: number;
}

/** Daily question sets and results. Postgres in production, a JSON file locally and in tests. */
export interface DailyStore {
  init(): Promise<void>;
  getSet(day: string): Promise<Tossup[] | null>;
  /** Saves the set unless one already exists for that day; returns whichever is stored. */
  putSet(day: string, tossups: Tossup[]): Promise<Tossup[]>;
  /** False when this player already has a result for the day. */
  addResult(row: DailyRow): Promise<boolean>;
  result(day: string, playerKey: string): Promise<DailyRow | null>;
  /** Best first: points, then earlier average buzz, then who finished first. */
  top(day: string, limit: number): Promise<DailyRow[]>;
  count(day: string): Promise<number>;
  /** 1 + how many results for the day rank above this one. */
  rankOf(row: DailyRow): Promise<number>;
  /** Every day this player played, newest first, with where they finished that day. */
  history(playerKey: string): Promise<DailyPlace[]>;
  /** An account changed its username: follow it on this player's saved rows (the shown name too, where it was the username). */
  rename(playerKey: string, username: string): Promise<void>;
}

export interface DailyPlace { row: DailyRow; rank: number; players: number }

const better = (a: DailyRow, b: DailyRow) =>
  b.points - a.points || (a.depth ?? 2) - (b.depth ?? 2) || a.createdAt - b.createdAt;

export class FileDailyStore implements DailyStore {
  private d: { sets: Record<string, Tossup[]>; results: DailyRow[] } = { sets: {}, results: [] };
  constructor(private file: string | null) {}

  async init() {
    if (!this.file || !existsSync(this.file)) return;
    try { this.d = { sets: {}, results: [], ...JSON.parse(readFileSync(this.file, 'utf8')) }; }
    catch (e) { console.error(`Could not read ${this.file}:`, e); }
  }
  private save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.d));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (e) { console.error('Could not save daily results:', e); }
  }
  async getSet(day: string) { return this.d.sets[day] ?? null; }
  async putSet(day: string, tossups: Tossup[]) {
    this.d.sets[day] ??= tossups;
    // Keep two weeks of sets.
    const days = Object.keys(this.d.sets).sort();
    for (const old of days.slice(0, Math.max(0, days.length - 14))) delete this.d.sets[old];
    this.save();
    return this.d.sets[day];
  }
  async addResult(row: DailyRow) {
    if (this.d.results.some((r) => r.day === row.day && r.playerKey === row.playerKey)) return false;
    this.d.results.push(row);
    this.save();
    return true;
  }
  async result(day: string, key: string) { return this.d.results.find((r) => r.day === day && r.playerKey === key) ?? null; }
  async top(day: string, limit: number) { return this.d.results.filter((r) => r.day === day).sort(better).slice(0, limit); }
  async count(day: string) { return this.d.results.filter((r) => r.day === day).length; }
  async rankOf(row: DailyRow) { return 1 + this.d.results.filter((r) => r.day === row.day && r.playerKey !== row.playerKey && better(r, row) < 0).length; }
  async history(key: string) {
    return this.d.results.filter((r) => r.playerKey === key)
      .map((row) => {
        const day = this.d.results.filter((r) => r.day === row.day);
        return { row, rank: 1 + day.filter((r) => r.playerKey !== key && better(r, row) < 0).length, players: day.length };
      })
      .sort((a, b) => b.row.day.localeCompare(a.row.day));
  }
  async rename(key: string, username: string) {
    for (const r of this.d.results) if (r.playerKey === key) { if (r.name === r.username) r.name = username; r.username = username; }
    this.save();
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS daily_sets (
  day TEXT PRIMARY KEY,
  tossups JSONB NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS daily_results (
  day TEXT NOT NULL,
  player_key TEXT NOT NULL,
  name TEXT NOT NULL,
  username TEXT,
  points INTEGER NOT NULL,
  powers INTEGER NOT NULL,
  tens INTEGER NOT NULL,
  negs INTEGER NOT NULL,
  marks TEXT NOT NULL,
  depth DOUBLE PRECISION,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (day, player_key)
);
CREATE INDEX IF NOT EXISTS daily_results_rank ON daily_results (day, points DESC, depth, created_at);
`;

const fromDb = (r: any): DailyRow => ({
  day: r.day, playerKey: r.player_key, name: r.name, username: r.username ?? undefined, points: r.points, powers: r.powers,
  tens: r.tens, negs: r.negs, marks: r.marks, depth: r.depth, createdAt: Number(r.created_at),
});
const ORDER = 'points DESC, COALESCE(depth, 2) ASC, created_at ASC';

export class PgDailyStore implements DailyStore {
  private pool: pg.Pool;
  constructor(url: string) {
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    this.pool = new pg.Pool({ connectionString: url, max: 2, ssl: local ? undefined : { rejectUnauthorized: false } });
    this.pool.on('error', (e) => console.error('Postgres pool error (daily):', e.message));
  }
  async init() { await this.pool.query(SCHEMA); }
  async getSet(day: string) {
    const r = await this.pool.query('SELECT tossups FROM daily_sets WHERE day = $1', [day]);
    return r.rows[0]?.tossups ?? null;
  }
  async putSet(day: string, tossups: Tossup[]) {
    await this.pool.query('INSERT INTO daily_sets (day, tossups, created_at) VALUES ($1, $2, $3) ON CONFLICT (day) DO NOTHING', [day, JSON.stringify(tossups), Date.now()]);
    return (await this.getSet(day)) ?? tossups;
  }
  async addResult(x: DailyRow) {
    const r = await this.pool.query(
      `INSERT INTO daily_results (day, player_key, name, username, points, powers, tens, negs, marks, depth, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (day, player_key) DO NOTHING`,
      [x.day, x.playerKey, x.name, x.username ?? null, x.points, x.powers, x.tens, x.negs, x.marks, x.depth, x.createdAt],
    );
    return (r.rowCount ?? 0) > 0;
  }
  async result(day: string, key: string) {
    const r = await this.pool.query('SELECT * FROM daily_results WHERE day = $1 AND player_key = $2', [day, key]);
    return r.rows[0] ? fromDb(r.rows[0]) : null;
  }
  async top(day: string, limit: number) {
    const r = await this.pool.query(`SELECT * FROM daily_results WHERE day = $1 ORDER BY ${ORDER} LIMIT $2`, [day, limit]);
    return r.rows.map(fromDb);
  }
  async count(day: string) {
    const r = await this.pool.query('SELECT count(*)::int AS n FROM daily_results WHERE day = $1', [day]);
    return r.rows[0].n as number;
  }
  async rankOf(x: DailyRow) {
    const r = await this.pool.query(
      // $4 needs its type spelled out: inside COALESCE(..., 2) Postgres would read it as an integer
      // and reject a fractional depth like 0.53, which made the daily status fail for anyone who had played.
      `SELECT count(*)::int AS n FROM daily_results WHERE day = $1 AND player_key <> $2 AND (
         points > $3 OR (points = $3 AND COALESCE(depth, 2) < COALESCE($4::double precision, 2))
         OR (points = $3 AND COALESCE(depth, 2) = COALESCE($4::double precision, 2) AND created_at < $5))`,
      [x.day, x.playerKey, x.points, x.depth, x.createdAt],
    );
    return 1 + (r.rows[0].n as number);
  }
  async history(key: string) {
    const r = await this.pool.query(
      `SELECT * FROM (
         SELECT d.*, ROW_NUMBER() OVER (PARTITION BY day ORDER BY ${ORDER})::int AS place, COUNT(*) OVER (PARTITION BY day)::int AS players
         FROM daily_results d WHERE day IN (SELECT day FROM daily_results WHERE player_key = $1)
       ) t WHERE player_key = $1 ORDER BY day DESC`,
      [key],
    );
    return r.rows.map((x) => ({ row: fromDb(x), rank: x.place as number, players: x.players as number }));
  }
  async rename(key: string, username: string) {
    await this.pool.query('UPDATE daily_results SET name = CASE WHEN name = username THEN $2 ELSE name END, username = $2 WHERE player_key = $1', [key, username]);
  }
}
