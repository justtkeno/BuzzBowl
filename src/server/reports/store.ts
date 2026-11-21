import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import type { ReportReason, ReportStatus } from '../../shared/reports';

export interface QuestionReport {
  id: string;
  createdAt: number;
  status: ReportStatus;
  /** The tossup's own id and where it came from (qbreader, sample, upload, lightning, daily). */
  questionId: string;
  source: string;
  category: string;
  subcategory: string;
  setName: string | null;
  question: string;
  /** Sanitized answer line HTML, as the room showed it. */
  answer: string;
  reason: ReportReason;
  note: string;
  reporter: string;
  reporterUsername: string | null;
  /** Who reported, for de-duplication: `a:<accountId>` or `g:<room>:<playerId>` for a guest. Never shown. */
  reporterKey: string;
  roomCode: string;
  resolvedBy: string | null;
  resolvedAt: number | null;
}

/** Question reports. Postgres in production, a JSON file locally and in tests. */
export interface ReportStore {
  init(): Promise<void>;
  /** False when this reporter already reported this question. */
  add(r: QuestionReport): Promise<boolean>;
  /** Open reports, newest first. */
  open(limit: number): Promise<QuestionReport[]>;
  /** Close every open report of one question; returns how many were closed. */
  resolve(source: string, questionId: string, status: Exclude<ReportStatus, 'open'>, by: string, at?: number): Promise<number>;
  /** Write pending changes now (shutdown). */
  flush(): void;
}

/** Closed reports kept in the file store; the oldest go first. */
const FILE_KEEP_CLOSED = 1000;

export class FileReportStore implements ReportStore {
  private d: { reports: QuestionReport[] } = { reports: [] };
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private file: string | null) {}

  async init() {
    if (!this.file || !existsSync(this.file)) return;
    try { this.d = { reports: [], ...JSON.parse(readFileSync(this.file, 'utf8')) }; }
    catch (e) { console.error(`Could not read ${this.file}:`, e); }
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
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.d));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (e) { console.error('Could not save question reports:', e); }
  }
  async add(r: QuestionReport) {
    if (this.d.reports.some((x) => x.reporterKey === r.reporterKey && x.source === r.source && x.questionId === r.questionId)) return false;
    this.d.reports.push({ ...r });
    const closed = this.d.reports.filter((x) => x.status !== 'open');
    if (closed.length > FILE_KEEP_CLOSED) {
      const drop = new Set(closed.slice(0, closed.length - FILE_KEEP_CLOSED));
      this.d.reports = this.d.reports.filter((x) => !drop.has(x));
    }
    this.save();
    return true;
  }
  async open(limit: number) {
    return this.d.reports.filter((r) => r.status === 'open').sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map((r) => ({ ...r }));
  }
  async resolve(source: string, questionId: string, status: Exclude<ReportStatus, 'open'>, by: string, at = Date.now()) {
    let n = 0;
    for (const r of this.d.reports) {
      if (r.status !== 'open' || r.source !== source || r.questionId !== questionId) continue;
      Object.assign(r, { status, resolvedBy: by, resolvedAt: at });
      n++;
    }
    if (n) this.save();
    return n;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS question_reports (
  id TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  question_id TEXT NOT NULL,
  source TEXT NOT NULL,
  category TEXT NOT NULL,
  subcategory TEXT NOT NULL,
  set_name TEXT,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  reason TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  reporter TEXT NOT NULL,
  reporter_username TEXT,
  reporter_key TEXT NOT NULL,
  room_code TEXT NOT NULL,
  resolved_by TEXT,
  resolved_at BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS question_reports_once ON question_reports (reporter_key, source, question_id);
CREATE INDEX IF NOT EXISTS question_reports_open ON question_reports (status, created_at DESC);
`;

const fromDb = (r: any): QuestionReport => ({
  id: r.id, createdAt: Number(r.created_at), status: r.status, questionId: r.question_id, source: r.source,
  category: r.category, subcategory: r.subcategory, setName: r.set_name ?? null, question: r.question, answer: r.answer,
  reason: r.reason, note: r.note, reporter: r.reporter, reporterUsername: r.reporter_username ?? null, reporterKey: r.reporter_key,
  roomCode: r.room_code, resolvedBy: r.resolved_by ?? null, resolvedAt: r.resolved_at === null || r.resolved_at === undefined ? null : Number(r.resolved_at),
});

export class PgReportStore implements ReportStore {
  private pool: pg.Pool;
  constructor(url: string) {
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    this.pool = new pg.Pool({ connectionString: url, max: 2, ssl: local ? undefined : { rejectUnauthorized: false } });
    this.pool.on('error', (e) => console.error('Postgres pool error (reports):', e.message));
  }
  async init() { await this.pool.query(SCHEMA); }
  async add(x: QuestionReport) {
    const r = await this.pool.query(
      `INSERT INTO question_reports (id, created_at, status, question_id, source, category, subcategory, set_name, question, answer,
         reason, note, reporter, reporter_username, reporter_key, room_code, resolved_by, resolved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (reporter_key, source, question_id) DO NOTHING`,
      [x.id, x.createdAt, x.status, x.questionId, x.source, x.category, x.subcategory, x.setName, x.question, x.answer,
        x.reason, x.note, x.reporter, x.reporterUsername, x.reporterKey, x.roomCode, x.resolvedBy, x.resolvedAt],
    );
    return (r.rowCount ?? 0) > 0;
  }
  async open(limit: number) {
    const r = await this.pool.query(`SELECT * FROM question_reports WHERE status = 'open' ORDER BY created_at DESC LIMIT $1`, [limit]);
    return r.rows.map(fromDb);
  }
  async resolve(source: string, questionId: string, status: Exclude<ReportStatus, 'open'>, by: string, at = Date.now()) {
    const r = await this.pool.query(
      `UPDATE question_reports SET status = $1, resolved_by = $2, resolved_at = $3 WHERE status = 'open' AND source = $4 AND question_id = $5`,
      [status, by, at, source, questionId],
    );
    return r.rowCount ?? 0;
  }
  flush() { /* every write goes straight to the database */ }
}
