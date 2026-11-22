import { randomBytes } from 'node:crypto';
import { FEEDBACK_KINDS, FEEDBACK_MAX, type FeedbackItem, type FeedbackKind } from '../../shared/feedback';
import type { FeedbackStore } from './store';

export class FeedbackError extends Error {}

const clean = (s: unknown, max: number) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);

/** Accepts feedback from players (validated and rate-limited) and serves it to admins. */
export class Feedback {
  ready: Promise<void>;
  private recent = new Map<string, number[]>();
  constructor(private store: FeedbackStore, private max = 5, private windowMs = 10 * 60_000) {
    this.ready = store.init().catch((e) => console.error('Feedback store unavailable:', e));
  }

  async submit(input: { kind?: unknown; message?: unknown; where?: unknown; device?: unknown }, from: string, username: string | null, limitKeys: string[]) {
    const message = clean(input.message, FEEDBACK_MAX);
    if (message.length < 3) throw new FeedbackError('Write a little more first.');
    const kind: FeedbackKind = FEEDBACK_KINDS.some((k) => k.id === input.kind) ? (input.kind as FeedbackKind) : 'other';
    const now = Date.now();
    for (const k of limitKeys) {
      const hits = (this.recent.get(k) ?? []).filter((t) => now - t < this.windowMs);
      if (hits.length >= this.max) throw new FeedbackError('Thanks! That’s plenty for now. Try again in a few minutes.');
    }
    for (const k of limitKeys) this.recent.set(k, [...(this.recent.get(k) ?? []).filter((t) => now - t < this.windowMs), now]);
    const item: FeedbackItem = {
      id: randomBytes(8).toString('hex'), createdAt: now, kind, message,
      from: clean(from, 40) || 'Someone', username, where: clean(input.where, 40) || 'app', device: clean(input.device, 60), done: false,
    };
    await this.ready;
    await this.store.add(item);
    return item;
  }

  async list() { await this.ready; return this.store.list(200); }
  async setDone(id: unknown, done: unknown) { await this.ready; return this.store.setDone(String(id ?? ''), !!done); }
  flush() { this.store.flush(); }
}
