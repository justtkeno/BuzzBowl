import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Feedback, FeedbackError } from '../src/server/feedback/feedback';
import { FileFeedbackStore } from '../src/server/feedback/store';
import { FEEDBACK_MAX } from '../src/shared/feedback';

describe('feedback', () => {
  it('cleans and stores a message, newest first, and marks it done', async () => {
    const f = new Feedback(new FileFeedbackStore(null));
    const a = await f.submit({ kind: 'bug', message: '  The buzzer\u0007 froze  ', where: 'room ABCD', device: 'iPhone · Safari · app' }, 'Ann', 'ann', ['s:1']);
    expect(a).toMatchObject({ kind: 'bug', message: 'The buzzer froze', from: 'Ann', username: 'ann', where: 'room ABCD', done: false });
    const b = await f.submit({ kind: 'nonsense', message: 'x'.repeat(FEEDBACK_MAX + 50) }, '', null, ['s:2']);
    expect(b.kind).toBe('other');
    expect(b.message).toHaveLength(FEEDBACK_MAX);
    expect(b.from).toBe('Someone');
    expect(b.where).toBe('app');
    expect((await f.list()).map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(await f.setDone(a.id, true)).toBe(true);
    expect((await f.list()).find((x) => x.id === a.id)?.done).toBe(true);
    expect(await f.setDone('nope', true)).toBe(false);
  });

  it('rejects empty messages', async () => {
    const f = new Feedback(new FileFeedbackStore(null));
    await expect(f.submit({ message: '  ' }, 'Ann', null, ['s:1'])).rejects.toBeInstanceOf(FeedbackError);
  });

  it('rate-limits by any of its keys', async () => {
    const f = new Feedback(new FileFeedbackStore(null), 2, 60_000);
    await f.submit({ message: 'one' }, 'A', null, ['s:1', 'ip:x']);
    await f.submit({ message: 'two' }, 'A', null, ['s:2', 'ip:x']);
    await expect(f.submit({ message: 'three' }, 'A', null, ['s:3', 'ip:x'])).rejects.toThrow(/plenty/);
    await f.submit({ message: 'other person' }, 'B', null, ['s:4', 'ip:y']);
  });

  it('keeps feedback in its file across restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-'));
    try {
      const file = join(dir, 'feedback.json');
      const s1 = new FileFeedbackStore(file);
      const f1 = new Feedback(s1);
      const item = await f1.submit({ kind: 'idea', message: 'More topics please' }, 'Ann', null, ['s:1']);
      f1.flush();
      const f2 = new Feedback(new FileFeedbackStore(file));
      expect((await f2.list()).map((x) => x.message)).toEqual(['More topics please']);
      expect(await f2.setDone(item.id, true)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
