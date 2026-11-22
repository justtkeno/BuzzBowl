import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import type { FeedbackItem } from '../../shared/feedback';

/** Player feedback. Postgres in production, a JSON file locally and in tests. */
export interface FeedbackStore {
  init(): Promise<void>;
  add(f: FeedbackItem): Promise<void>;
  /** Newest first. */
  list(limit: number): Promise<FeedbackItem[]>;
  setDone(id: string, done: boolean): Promise<boolean>;
  flush(): void;
}

const FILE_KEEP = 2000;

export class FileFeedbackStore implements FeedbackStore {
  private items: FeedbackItem[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private file: string | null) {}
  async init() {
    if (!this.file || !existsSync(this.file)) return;
    try { this.items = JSON.parse(readFileSync(this.file, 'utf8')).items ?? []; } catch (e) { console.error(`Could not read ${this.file}:`, e); }
  }
  private save() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.flush(), 200);
    this.timer.unref?.();
  }
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ items: this.items.slice(-FILE_KEEP) }));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (e) { console.error('Could not save feedback:', e); }
  }
  async add(f: FeedbackItem) { this.items.push(structuredClone(f)); this.save(); }
  async list(limit: number) { return structuredClone([...this.items].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)); }
  async setDone(id: string, done: boolean) {
    const f = this.items.find((x) => x.id === id);
    if (!f) return false;
    f.done = done;
    this.save();
    return true;
  }
}

interface Row { id: string; created_at: string; kind: FeedbackItem['kind']; message: string; sender: string; username: string | null; place: string; device: string; done: boolean }

export class PgFeedbackStore implements FeedbackStore {
  private pool: pg.Pool;
  constructor(url: string) {
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    this.pool = new pg.Pool({ connectionString: url, max: 2, ssl: local ? undefined : { rejectUnauthorized: false } });
    this.pool.on('error', (e) => console.error('Postgres pool error (feedback):', e.message));
  }
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY, created_at BIGINT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL,
      sender TEXT NOT NULL, username TEXT, place TEXT NOT NULL, device TEXT NOT NULL, done BOOLEAN NOT NULL DEFAULT FALSE
    ); CREATE INDEX IF NOT EXISTS feedback_created ON feedback (created_at DESC);`);
  }
  async add(f: FeedbackItem) {
    await this.pool.query('INSERT INTO feedback (id, created_at, kind, message, sender, username, place, device, done) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [f.id, f.createdAt, f.kind, f.message, f.from, f.username, f.where, f.device, f.done]);
  }
  async list(limit: number) {
    const r = await this.pool.query<Row>('SELECT * FROM feedback ORDER BY created_at DESC LIMIT $1', [limit]);
    return r.rows.map((x) => ({ id: x.id, createdAt: Number(x.created_at), kind: x.kind, message: x.message, from: x.sender, username: x.username, where: x.place, device: x.device, done: x.done }));
  }
  async setDone(id: string, done: boolean) {
    return !!(await this.pool.query('UPDATE feedback SET done = $2 WHERE id = $1', [id, done])).rowCount;
  }
  flush() {}
}
