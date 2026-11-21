import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Room, TIMING, type RoomIO } from '../src/server/rooms/room';
import type { QuestionProvider, Tossup } from '../src/server/questions/types';
import { FileReportStore, PgReportStore, type QuestionReport, type ReportStore } from '../src/server/reports/store';
import { RATE_LIMIT, ReportError, Reports, type ReportTarget } from '../src/server/reports/reports';

const TOSSUP: Tossup = {
  id: 't1', category: 'Science', subcategory: 'Biology',
  question: 'w1 w2 w3 w4 (*) w5 w6 w7 w8 w9 w10',
  answer: '<b><u>mitochondria</u></b> [prompt on <u>organelle</u>s]',
};
function fakeProvider(): QuestionProvider {
  let n = 0;
  return { nextTossup: async () => ({ ...TOSSUP, id: `t${++n}` }), nextBonus: async () => null };
}

// ---------- the store ----------

const pgUrl = process.env.TEST_DATABASE_URL;
const stores: [string, () => ReportStore][] = [['file', () => new FileReportStore(null)]];
if (pgUrl) stores.push(['postgres', () => new PgReportStore(pgUrl)]);
const opened: ReportStore[] = [];
afterAll(async () => { for (const s of opened) await (s as any).pool?.end(); });

let seq = 0;
const report = (questionId: string, reporterKey: string, createdAt: number, extra: Partial<QuestionReport> = {}): QuestionReport => ({
  id: `r-${Date.now()}-${++seq}`, createdAt, status: 'open', questionId, source: 'test', category: 'Science', subcategory: 'Biology',
  setName: null, question: 'Q', answer: '<b>A</b>', reason: 'typo', note: '', reporter: reporterKey, reporterUsername: null,
  reporterKey, roomCode: 'ABCD', resolvedBy: null, resolvedAt: null, ...extra,
});

describe.each(stores)('report store (%s)', (_name, make) => {
  it('adds once per reporter and question, lists open newest first, and resolves a whole question', async () => {
    const store = make();
    opened.push(store);
    await store.init();
    const q = `q-${Date.now()}-${++seq}`;
    const other = `${q}-other`;
    const t = 1_700_000_000_000;
    expect(await store.add(report(q, 'a:ann', t + 1))).toBe(true);
    expect(await store.add(report(q, 'a:ann', t + 2))).toBe(false); // same reporter, same question
    expect(await store.add(report(q, 'g:ROOM:bob', t + 3, { reason: 'answer', note: 'accept "mito"' }))).toBe(true);
    expect(await store.add(report(other, 'a:ann', t + 4))).toBe(true);
    const open = (await store.open(500)).filter((r) => r.questionId === q || r.questionId === other);
    expect(open.map((r) => [r.questionId, r.reporterKey])).toEqual([[other, 'a:ann'], [q, 'g:ROOM:bob'], [q, 'a:ann']]);
    expect(open[1]).toMatchObject({ reason: 'answer', note: 'accept "mito"', status: 'open', resolvedBy: null });

    expect(await store.resolve('test', q, 'dismissed', 'Hao', t + 10)).toBe(2);
    expect(await store.resolve('test', q, 'resolved', 'Hao', t + 11)).toBe(0); // already closed
    const left = (await store.open(500)).filter((r) => r.questionId === q || r.questionId === other);
    expect(left.map((r) => r.questionId)).toEqual([other]);
    // A closed report still counts for de-duplication.
    expect(await store.add(report(q, 'a:ann', t + 12))).toBe(false);
  });
});

describe('file report store on disk', () => {
  it('survives a restart after flush', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reports-'));
    try {
      const file = join(dir, 'reports-1.json');
      const a = new FileReportStore(file);
      await a.init();
      await a.add(report('q1', 'a:ann', 1));
      a.flush();
      const b = new FileReportStore(file);
      await b.init();
      expect((await b.open(10)).map((r) => r.questionId)).toEqual(['q1']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ---------- the service: validation, rate limit, grouping ----------

const target = (questionId: string): ReportTarget => ({
  questionId, source: 'sample', category: 'Science', subcategory: 'Biology', setName: null, question: 'Q', answer: 'A',
});

describe('Reports', () => {
  it('checks the reason, trims the note, and dedupes', async () => {
    const r = new Reports(new FileReportStore(null));
    const me = { name: 'Ann', username: null, key: 'g:ROOM:p1' };
    await expect(r.submit(target('x'), me, 'ROOM', 'nonsense', '')).rejects.toBeInstanceOf(ReportError);
    expect(await r.submit(target('x'), me, 'ROOM', 'other', `  long   ${'n'.repeat(400)} `)).toBe(true);
    expect(await r.submit(target('x'), me, 'ROOM', 'typo', '')).toBe(false);
    const { total, groups } = await r.openGroups();
    expect(total).toBe(1);
    expect(groups[0].reports[0].note.length).toBe(200);
    expect(groups[0].reports[0]).not.toHaveProperty('reporterKey');
  });

  it('limits how many reports one player or socket can send', async () => {
    let now = 1_000_000;
    const r = new Reports(new FileReportStore(null), () => now);
    const me = { name: 'Ann', username: 'ann', key: 'a:ann' };
    for (let i = 0; i < RATE_LIMIT.max; i++) expect(await r.submit(target(`q${i}`), me, 'ROOM', 'typo', '', ['s:1'])).toBe(true);
    await expect(r.submit(target('more'), me, 'ROOM', 'typo', '', ['s:1'])).rejects.toThrow(/a lot of reports/);
    // Another identity on the same socket is limited too.
    await expect(r.submit(target('more'), { ...me, key: 'g:X:p' }, 'ROOM', 'typo', '', ['s:1'])).rejects.toThrow(/a lot of reports/);
    now += RATE_LIMIT.windowMs + 1;
    expect(await r.submit(target('more'), me, 'ROOM', 'typo', '', ['s:1'])).toBe(true);
  });

  it('groups open reports by question with the latest first, and resolves a group', async () => {
    let now = 1;
    const r = new Reports(new FileReportStore(null), () => now);
    await r.submit(target('a'), { name: 'Ann', username: null, key: 'k1' }, 'R1', 'typo', '');
    now = 2; await r.submit(target('b'), { name: 'Bob', username: null, key: 'k2' }, 'R1', 'category', '');
    now = 3; await r.submit(target('a'), { name: 'Cy', username: 'cy', key: 'k3' }, 'R2', 'answer', 'accept X');
    const { total, groups } = await r.openGroups();
    expect(total).toBe(3);
    expect(groups.map((g) => [g.questionId, g.reports.map((x) => x.reporter)])).toEqual([['a', ['Cy', 'Ann']], ['b', ['Bob']]]);
    await expect(r.resolve('sample', 'a', 'maybe', 'Hao')).rejects.toBeInstanceOf(ReportError);
    expect(await r.resolve('sample', 'a', 'resolved', 'Hao')).toBe(2);
    await expect(r.resolve('sample', 'a', 'resolved', 'Hao')).rejects.toThrow(/already closed/);
    expect((await r.openGroups()).groups.map((g) => g.questionId)).toEqual(['b']);
  });
});

// ---------- the room looks the question up itself ----------

describe('Room.reportTarget', () => {
  const sent: { to: string[]; event: string; payload: any }[] = [];
  const io: RoomIO = { emitEach: () => {}, emitTo: (to, event, payload) => sent.push({ to, event, payload }) };
  beforeEach(() => { vi.useFakeTimers(); sent.length = 0; });
  afterEach(() => vi.useRealTimers());

  async function setup() {
    const room = new Room('TEST', io, { qbreader: fakeProvider() });
    const ann = room.join('Ann').playerId;
    const bob = room.join('Bob').playerId;
    room.updateSettings(ann, { wpm: 600 });
    room.start(ann);
    await vi.advanceTimersByTimeAsync(0);
    return { room, ann, bob };
  }

  it('refuses a tossup that is still being read, then returns the finished one from room state', async () => {
    const { room, ann, bob } = await setup();
    while ((room.s.tossup?.revealed ?? 0) < 2) await vi.advanceTimersByTimeAsync(20);
    expect(room.s.phase).toBe('reading');
    expect(() => room.reportTarget(ann, 1)).toThrow(/once it has been read/);
    expect(() => room.reportTarget(ann, 2)).toThrow(/once it has been read/);
    room.buzz(ann, 2);
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    expect(() => room.reportTarget(ann, 1)).toThrow(/once it has been read/); // mid-buzz is still unfinished
    room.submitAnswer(ann, 'mitochondria');
    expect(room.s.phase).toBe('tossupEnd');
    const t = room.reportTarget(bob, 1);
    expect(t).toEqual({
      questionId: 't1', source: 'qbreader', category: 'Science', subcategory: 'Biology', setName: null,
      question: 'w1 w2 w3 w4 (*) w5 w6 w7 w8 w9 w10', answer: room.s.review[0].answerHtml,
    });
    expect(() => room.reportTarget('nobody', 1)).toThrow(/not in this room/);
  });

  it('remembers who reported what, only in that player’s own state', async () => {
    const { room, ann, bob } = await setup();
    room.next(ann); // skip the first tossup
    await vi.advanceTimersByTimeAsync(0);
    room.markReported(ann, 1);
    expect(room.snapshot(ann).reported).toEqual([1]);
    expect(room.snapshot(bob).reported).toEqual([]);
    expect(sent.at(-1)).toMatchObject({ to: [ann], event: 'state' });
    expect(() => room.reportTarget(ann, 1)).toThrow(/already reported/);
    expect(room.reportTarget(bob, 1).questionId).toBe('t1');
    // Survives a restart.
    const back = Room.restore(JSON.parse(JSON.stringify(room.toJSON())), io, { qbreader: fakeProvider() });
    expect(back.snapshot(ann).reported).toEqual([1]);
  });

  it('marks daily-challenge questions with their own source', async () => {
    const room = new Room('DAY1', io, {});
    const me = room.join('Hao').playerId;
    room.makeDaily({ day: '2026-11-19', number: 1, playerKey: 'g:abcdef123456' }, [{ ...TOSSUP, id: 'd1' }, { ...TOSSUP, id: 'd2' }]);
    room.start(me);
    for (let i = 0; i < 100 && room.s.phase !== 'reading'; i++) await vi.advanceTimersByTimeAsync(20);
    expect(() => room.reportTarget(me, 1)).toThrow(/once it has been read/);
    for (let i = 0; i < 400 && room.s.phase !== 'tossupEnd'; i++) await vi.advanceTimersByTimeAsync(50);
    expect(room.reportTarget(me, 1)).toMatchObject({ questionId: 'd1', source: 'daily' });
    // The next question in the set can't be reached before it is read.
    expect(() => room.reportTarget(me, 2)).toThrow(/once it has been read/);
  });
});
