import { afterAll, describe, expect, it } from 'vitest';
import { FileDailyStore, PgDailyStore, type DailyRow, type DailyStore } from '../src/server/daily/store';

// The file store always runs. The Postgres store runs too when TEST_DATABASE_URL points at a scratch database
// (the live site uses Postgres, so its queries need checking against the real thing).
const pgUrl = process.env.TEST_DATABASE_URL;
const stores: [string, () => DailyStore][] = [['file', () => new FileDailyStore(null)]];
if (pgUrl) stores.push(['postgres', () => new PgDailyStore(pgUrl)]);
const opened: DailyStore[] = [];
afterAll(async () => { for (const s of opened) await (s as any).pool?.end(); });

let n = 0;
const row = (day: string, playerKey: string, points: number, depth: number | null, createdAt: number): DailyRow =>
  ({ day, playerKey, name: playerKey, points, powers: 0, tens: 0, negs: 0, marks: '----------', depth, createdAt });

describe.each(stores)('daily store (%s)', (_name, make) => {
  it('follows an account to its new username', async () => {
    const store = make();
    opened.push(store);
    await store.init();
    const day = `test-${Date.now()}-${++n}`;
    const key = `a:rename-${day}`;
    await store.addResult({ ...row(day, key, 20, 0.5, 1), name: 'old_name', username: 'old_name' });
    await store.addResult({ ...row(day, `${key}-other`, 10, 0.5, 2), name: 'Someone', username: 'someone' });
    await store.rename(key, 'new_name');
    expect(await store.result(day, key)).toMatchObject({ name: 'new_name', username: 'new_name' });
    expect(await store.result(day, `${key}-other`)).toMatchObject({ name: 'Someone', username: 'someone' });
  });

  it('ranks players by points, then earlier buzzes, then who finished first, with fractional depths', async () => {
    const store = make();
    opened.push(store);
    await store.init();
    const day = `test-${Date.now()}-${++n}`;
    const t = 1_700_000_000_000;
    const rows = [
      row(day, 'a:ann', 25, 0.5348, t + 3),
      row(day, 'a:bob', 25, 0.41, t + 4), // same points, buzzed earlier on average: ahead of Ann
      row(day, 'a:cy', 25, 0.41, t + 9), // tied with Bob but finished later
      row(day, 'a:dee', 10, null, t + 1), // no correct buzz: depth unknown
      row(day, 'a:eve', 30, 0.9, t + 2),
    ];
    for (const r of rows) expect(await store.addResult(r)).not.toBe(false);
    const rank = async (key: string) => store.rankOf((await store.result(day, key))!);
    expect(await rank('a:eve')).toBe(1);
    expect(await rank('a:bob')).toBe(2);
    expect(await rank('a:cy')).toBe(3);
    expect(await rank('a:ann')).toBe(4);
    expect(await rank('a:dee')).toBe(5);
    expect((await store.top(day, 10)).map((r) => r.playerKey)).toEqual(['a:eve', 'a:bob', 'a:cy', 'a:ann', 'a:dee']);
    expect(await store.count(day)).toBe(5);
    expect((await store.result(day, 'a:ann'))!.depth).toBeCloseTo(0.5348);
  });
});
