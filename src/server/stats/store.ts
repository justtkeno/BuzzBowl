import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import type { GameSummary } from '../../shared/stats';

/** Game summaries and daily visitor ids. Postgres in production, a JSON file locally and in tests. */
export interface StatsStore {
  init(): Promise<void>;
  addGame(g: GameSummary): Promise<void>;
  /** Remember that this (hashed) device opened the app on `day`. */
  addVisit(day: string, device: string): Promise<void>;
  /** Games on or after `fromDay`. */
  games(fromDay: string): Promise<GameSummary[]>;
  /** Distinct devices per day, on or after `fromDay`. */
  visitors(fromDay: string): Promise<Record<string, number>>;
  /** Distinct devices across all days on or after `fromDay` (someone visiting daily counts once). */
  uniqueVisitors(fromDay: string): Promise<number>;
  /** All-time game count and the first day anything was recorded. */
  totals(): Promise<{ games: number; since: string | null }>;
  flush(): void;
}

const KEEP_DAYS = 120;

export class FileStatsStore implements StatsStore {
  private gamesList: GameSummary[] = [];
  private visits: Record<string, string[]> = {};
  private allGames = 0;
  private since: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private file: string | null) {}
  async init() {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const d = JSON.parse(readFileSync(this.file, 'utf8'));
      this.gamesList = d.games ?? []; this.visits = d.visits ?? {}; this.allGames = d.allGames ?? this.gamesList.length; this.since = d.since ?? null;
    } catch (e) { console.error(`Could not read ${this.file}:`, e); }
  }
  private save() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.flush(), 500);
    this.timer.unref?.();
  }
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    // Keep the file small: recent days only (the all-time count is kept separately).
    const cutoff = [...Object.keys(this.visits), ...this.gamesList.map((g) => g.day)].sort().reverse()[KEEP_DAYS - 1];
    if (cutoff) {
      this.gamesList = this.gamesList.filter((g) => g.day >= cutoff);
      for (const d of Object.keys(this.visits)) if (d < cutoff) delete this.visits[d];
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ games: this.gamesList, visits: this.visits, allGames: this.allGames, since: this.since }));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (e) { console.error('Could not save stats:', e); }
  }
  async addGame(g: GameSummary) {
    this.gamesList.push(structuredClone(g));
    this.allGames++;
    this.since ??= g.day;
    this.save();
  }
  async addVisit(day: string, device: string) {
    const list = (this.visits[day] ??= []);
    if (list.includes(device)) return;
    list.push(device);
    this.since ??= day;
    this.save();
  }
  async games(fromDay: string) { return structuredClone(this.gamesList.filter((g) => g.day >= fromDay)); }
  async visitors(fromDay: string) {
    return Object.fromEntries(Object.entries(this.visits).filter(([d]) => d >= fromDay).map(([d, l]) => [d, l.length]));
  }
  async uniqueVisitors(fromDay: string) {
    return new Set(Object.entries(this.visits).filter(([d]) => d >= fromDay).flatMap(([, l]) => l)).size;
  }
  async totals() { return { games: this.allGames, since: this.since }; }
}

export class PgStatsStore implements StatsStore {
  private pool: pg.Pool;
  constructor(url: string) {
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    this.pool = new pg.Pool({ connectionString: url, max: 2, ssl: local ? undefined : { rejectUnauthorized: false } });
    this.pool.on('error', (e) => console.error('Postgres pool error (stats):', e.message));
  }
  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS stats_games (at BIGINT NOT NULL, day TEXT NOT NULL, summary JSONB NOT NULL);
      CREATE INDEX IF NOT EXISTS stats_games_day ON stats_games (day);
      CREATE TABLE IF NOT EXISTS stats_visits (day TEXT NOT NULL, device TEXT NOT NULL, PRIMARY KEY (day, device));`);
  }
  async addGame(g: GameSummary) {
    await this.pool.query('INSERT INTO stats_games (at, day, summary) VALUES ($1, $2, $3)', [g.at, g.day, JSON.stringify(g)]);
  }
  async addVisit(day: string, device: string) {
    await this.pool.query('INSERT INTO stats_visits (day, device) VALUES ($1, $2) ON CONFLICT DO NOTHING', [day, device]);
  }
  async games(fromDay: string) {
    const r = await this.pool.query('SELECT summary FROM stats_games WHERE day >= $1 ORDER BY at', [fromDay]);
    return r.rows.map((x) => x.summary as GameSummary);
  }
  async visitors(fromDay: string) {
    const r = await this.pool.query('SELECT day, count(*)::int AS n FROM stats_visits WHERE day >= $1 GROUP BY day', [fromDay]);
    return Object.fromEntries(r.rows.map((x) => [x.day as string, x.n as number]));
  }
  async uniqueVisitors(fromDay: string) {
    const r = await this.pool.query('SELECT count(DISTINCT device)::int AS n FROM stats_visits WHERE day >= $1', [fromDay]);
    return r.rows[0].n as number;
  }
  async totals() {
    const r = await this.pool.query(`SELECT (SELECT count(*)::int FROM stats_games) AS games,
      LEAST((SELECT min(day) FROM stats_games), (SELECT min(day) FROM stats_visits)) AS since`);
    return { games: r.rows[0].games as number, since: (r.rows[0].since as string | null) ?? null };
  }
  flush() {}
}
