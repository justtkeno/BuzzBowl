import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';

/** One finished survival run. */
export interface SurvivalRow {
  playerKey: string;
  name: string;
  username?: string;
  /** US Eastern day the run finished (YYYY-MM-DD), for the weekly board. */
  day: string;
  correct: number;
  tossups: number;
  points: number;
  powers: number;
  tens: number;
  negs: number;
  marks: string;
  createdAt: number;
}

/**
 * Survival runs. Postgres in production, a JSON file locally and in tests.
 * Boards count each player once, by their best run since `fromDay` (null = all time).
 */
export interface SurvivalStore {
  init(): Promise<void>;
  addRun(row: SurvivalRow): Promise<void>;
  /** Each player's best run, best first. */
  top(fromDay: string | null, limit: number): Promise<SurvivalRow[]>;
  best(playerKey: string, fromDay: string | null): Promise<SurvivalRow | null>;
  /** Players with at least one run. */
  count(fromDay: string | null): Promise<number>;
  /** 1 + how many other players have a better run. */
  rankOf(row: SurvivalRow, fromDay: string | null): Promise<number>;
  /** How many runs this player has finished. */
  runs(playerKey: string): Promise<number>;
  /** An account changed its username: follow it on this player's saved rows (the shown name too, where it was the username). */
  rename(playerKey: string, username: string): Promise<void>;
}

/** Best first: more tossups right, then more points, then whoever got there first. */
export const betterRun = (a: SurvivalRow, b: SurvivalRow) =>
  b.correct - a.correct || b.points - a.points || a.createdAt - b.createdAt;

/** Runs this recent are all kept (the weekly board needs them); older ones only if they're a player's best. */
const KEEP_DAYS = 14;

export class FileSurvivalStore implements SurvivalStore {
  private d: { runs: SurvivalRow[]; counts: Record<string, number> } = { runs: [], counts: {} };
  constructor(private file: string | null) {}

  async init() {
    if (!this.file || !existsSync(this.file)) return;
    try { this.d = { runs: [], counts: {}, ...JSON.parse(readFileSync(this.file, 'utf8')) }; }
    catch (e) { console.error(`Could not read ${this.file}:`, e); }
  }
  private save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.d));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (e) { console.error('Could not save survival runs:', e); }
  }
  private bests(fromDay: string | null): Map<string, SurvivalRow> {
    const out = new Map<string, SurvivalRow>();
    for (const r of this.d.runs) {
      if (fromDay && r.day < fromDay) continue;
      const cur = out.get(r.playerKey);
      if (!cur || betterRun(r, cur) < 0) out.set(r.playerKey, r);
    }
    return out;
  }
  async addRun(row: SurvivalRow) {
    this.d.runs.push(row);
    this.d.counts[row.playerKey] = (this.d.counts[row.playerKey] ?? 0) + 1;
    const day = Date.parse(`${row.day}T00:00:00Z`);
    if (Number.isFinite(day)) {
      const cutoff = new Date(day - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
      const keep = new Set(this.bests(null).values());
      this.d.runs = this.d.runs.filter((r) => r.day >= cutoff || keep.has(r));
    }
    this.save();
  }
  async top(fromDay: string | null, limit: number) { return [...this.bests(fromDay).values()].sort(betterRun).slice(0, limit); }
  async best(key: string, fromDay: string | null) { return this.bests(fromDay).get(key) ?? null; }
  async count(fromDay: string | null) { return this.bests(fromDay).size; }
  async rankOf(row: SurvivalRow, fromDay: string | null) {
    return 1 + [...this.bests(fromDay).values()].filter((r) => r.playerKey !== row.playerKey && betterRun(r, row) < 0).length;
  }
  async runs(key: string) { return this.d.counts[key] ?? 0; }
  async rename(key: string, username: string) {
    for (const r of this.d.runs) if (r.playerKey === key) { if (r.name === r.username) r.name = username; r.username = username; }
    this.save();
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS survival_runs (
  id BIGSERIAL PRIMARY KEY,
  player_key TEXT NOT NULL,
  name TEXT NOT NULL,
  username TEXT,
  day TEXT NOT NULL,
  correct INTEGER NOT NULL,
  tossups INTEGER NOT NULL,
  points INTEGER NOT NULL,
  powers INTEGER NOT NULL,
  tens INTEGER NOT NULL,
  negs INTEGER NOT NULL,
  marks TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS survival_runs_player ON survival_runs (player_key, correct DESC, points DESC, created_at);
CREATE INDEX IF NOT EXISTS survival_runs_day ON survival_runs (day);
`;

const fromDb = (r: any): SurvivalRow => ({
  playerKey: r.player_key, name: r.name, username: r.username ?? undefined, day: r.day, correct: r.correct, tossups: r.tossups,
  points: r.points, powers: r.powers, tens: r.tens, negs: r.negs, marks: r.marks, createdAt: Number(r.created_at),
});
const ORDER = 'correct DESC, points DESC, created_at ASC';
/** `$n` is the board's first day, or null for all time. */
const since = (n: number) => `($${n}::text IS NULL OR day >= $${n}::text)`;

export class PgSurvivalStore implements SurvivalStore {
  private pool: pg.Pool;
  constructor(url: string) {
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    this.pool = new pg.Pool({ connectionString: url, max: 2, ssl: local ? undefined : { rejectUnauthorized: false } });
    this.pool.on('error', (e) => console.error('Postgres pool error (survival):', e.message));
  }
  async init() { await this.pool.query(SCHEMA); }
  async addRun(x: SurvivalRow) {
    await this.pool.query(
      `INSERT INTO survival_runs (player_key, name, username, day, correct, tossups, points, powers, tens, negs, marks, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [x.playerKey, x.name, x.username ?? null, x.day, x.correct, x.tossups, x.points, x.powers, x.tens, x.negs, x.marks, x.createdAt],
    );
  }
  async top(fromDay: string | null, limit: number) {
    const r = await this.pool.query(
      `SELECT * FROM (SELECT DISTINCT ON (player_key) * FROM survival_runs WHERE ${since(1)} ORDER BY player_key, ${ORDER}) b
       ORDER BY ${ORDER} LIMIT $2`,
      [fromDay, limit],
    );
    return r.rows.map(fromDb);
  }
  async best(key: string, fromDay: string | null) {
    const r = await this.pool.query(`SELECT * FROM survival_runs WHERE player_key = $1 AND ${since(2)} ORDER BY ${ORDER} LIMIT 1`, [key, fromDay]);
    return r.rows[0] ? fromDb(r.rows[0]) : null;
  }
  async count(fromDay: string | null) {
    const r = await this.pool.query(`SELECT count(DISTINCT player_key)::int AS n FROM survival_runs WHERE ${since(1)}`, [fromDay]);
    return r.rows[0].n as number;
  }
  async rankOf(x: SurvivalRow, fromDay: string | null) {
    // A player is ahead if any of their runs beats this one (so their best does).
    const r = await this.pool.query(
      `SELECT count(DISTINCT player_key)::int AS n FROM survival_runs WHERE player_key <> $1 AND ${since(2)} AND (
         correct > $3 OR (correct = $3 AND points > $4) OR (correct = $3 AND points = $4 AND created_at < $5))`,
      [x.playerKey, fromDay, x.correct, x.points, x.createdAt],
    );
    return 1 + (r.rows[0].n as number);
  }
  async runs(key: string) {
    const r = await this.pool.query('SELECT count(*)::int AS n FROM survival_runs WHERE player_key = $1', [key]);
    return r.rows[0].n as number;
  }
  async rename(key: string, username: string) {
    await this.pool.query('UPDATE survival_runs SET name = CASE WHEN name = username THEN $2 ELSE name END, username = $2 WHERE player_key = $1', [key, username]);
  }
}
