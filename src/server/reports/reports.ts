import { randomBytes } from 'node:crypto';
import { REPORT_NOTE_MAX, REPORT_REASONS, type ReportGroup, type ReportReason } from '../../shared/reports';
import type { QuestionReport, ReportStore } from './store';

/** A finished question, looked up by the room from its own state (never sent by the client). */
export interface ReportTarget {
  questionId: string;
  source: string;
  category: string;
  subcategory: string;
  setName: string | null;
  question: string;
  answer: string;
}

export interface Reporter {
  name: string;
  username: string | null;
  /** Stable identity for de-duplication: `a:<accountId>` or `g:<room>:<playerId>`. */
  key: string;
}

/** Wrong input or too many reports: the message goes back to the player. */
export class ReportError extends Error {}

export const RATE_LIMIT = { max: 10, windowMs: 10 * 60_000 };
/** Open reports loaded for the admin list. */
const ADMIN_LIST_LIMIT = 500;

export class Reports {
  readonly ready: Promise<void>;
  /** Recent report times per rate-limit key (reporter, socket). */
  private recent = new Map<string, number[]>();

  constructor(private store: ReportStore, private now: () => number = Date.now) {
    this.ready = store.init().catch((e) => console.error('Question report storage failed to start:', e));
  }

  /** Save a report. Returns false when this reporter already reported this question. */
  async submit(target: ReportTarget, reporter: Reporter, roomCode: string, reason: unknown, note: unknown, rateKeys: string[] = []): Promise<boolean> {
    if (typeof reason !== 'string' || !(reason in REPORT_REASONS)) throw new ReportError('Pick a reason.');
    const cleanNote = String(note ?? '').replace(/\s+/g, ' ').trim().slice(0, REPORT_NOTE_MAX);
    const now = this.now();
    const keys = [reporter.key, ...rateKeys];
    for (const k of keys) {
      const times = (this.recent.get(k) ?? []).filter((t) => now - t < RATE_LIMIT.windowMs);
      this.recent.set(k, times);
      if (times.length >= RATE_LIMIT.max) throw new ReportError('You’ve sent a lot of reports. Try again in a few minutes.');
    }
    await this.ready;
    const added = await this.store.add({
      id: randomBytes(9).toString('base64url'), createdAt: now, status: 'open',
      ...target, reason: reason as ReportReason, note: cleanNote,
      reporter: reporter.name, reporterUsername: reporter.username, reporterKey: reporter.key, roomCode,
      resolvedBy: null, resolvedAt: null,
    });
    if (added) for (const k of keys) this.recent.get(k)!.push(now);
    this.prune(now);
    return added;
  }

  /** Open reports grouped by question, the most recently reported question first. */
  async openGroups(): Promise<{ total: number; groups: ReportGroup[] }> {
    await this.ready;
    const rows = await this.store.open(ADMIN_LIST_LIMIT);
    const groups = new Map<string, ReportGroup>();
    for (const r of rows) {
      const key = `${r.source}\n${r.questionId}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          source: r.source, questionId: r.questionId, category: r.category, subcategory: r.subcategory, setName: r.setName,
          question: r.question, answerHtml: r.answer, latest: r.createdAt, reports: [],
        };
        groups.set(key, g);
      }
      g.reports.push(view(r));
    }
    return { total: rows.length, groups: [...groups.values()].sort((a, b) => b.latest - a.latest) };
  }

  async resolve(source: unknown, questionId: unknown, status: unknown, by: string) {
    if (status !== 'resolved' && status !== 'dismissed') throw new ReportError('Resolve or dismiss.');
    await this.ready;
    const n = await this.store.resolve(String(source ?? ''), String(questionId ?? ''), status, by, this.now());
    if (!n) throw new ReportError('Those reports were already closed.');
    return n;
  }

  private prune(now: number) {
    if (this.recent.size < 1000) return;
    for (const [k, times] of this.recent) if (!times.some((t) => now - t < RATE_LIMIT.windowMs)) this.recent.delete(k);
  }
}

const view = (r: QuestionReport) => ({
  id: r.id, createdAt: r.createdAt, reason: r.reason, note: r.note, reporter: r.reporter, reporterUsername: r.reporterUsername, roomCode: r.roomCode,
});
