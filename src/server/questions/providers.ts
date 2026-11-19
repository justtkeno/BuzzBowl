import { CATEGORIES, type Filters } from '../../shared/types';
import { normalizeBonus, normalizeTossup, type Bonus, type QuestionProvider, type Tossup } from './types';

const QBREADER = process.env.QBREADER_URL ?? 'https://www.qbreader.org/api';

function matchesFilters(q: Tossup | Bonus, f: Filters): boolean {
  if (f.categories.length && !f.categories.includes(q.category)) return false;
  // A subcategory filter only narrows the categories that have subcategories selected.
  const narrowing = f.subcategories.filter((s) => SUBCAT_PARENT[s] === q.category);
  if (narrowing.length && !narrowing.includes(q.subcategory)) return false;
  if (f.difficulties.length && q.difficulty !== undefined && !f.difficulties.includes(q.difficulty)) return false;
  if (f.minYear && q.year !== undefined && q.year < f.minYear) return false;
  if (f.maxYear && q.year !== undefined && q.year > f.maxYear) return false;
  return true;
}

const SUBCAT_PARENT: Record<string, string> = {};
for (const [cat, subs] of Object.entries(CATEGORIES)) for (const s of subs) SUBCAT_PARENT[s] = cat;

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Questions from a fixed list (the built-in sample packet or an uploaded file). */
export class LocalProvider implements QuestionProvider {
  constructor(private tossups: Tossup[], private bonuses: Bonus[]) {}

  async nextTossup(f: Filters, seen: Set<string>) {
    return shuffle(this.tossups).find((t) => !seen.has(t.id) && matchesFilters(t, f)) ?? null;
  }

  async nextBonus(f: Filters, seen: Set<string>) {
    const unseen = shuffle(this.bonuses).filter((b) => !seen.has(b.id));
    // Fall back to any unseen bonus if none match the category filters.
    return unseen.find((b) => matchesFilters(b, f)) ?? unseen[0] ?? null;
  }
}

/** Random questions from the QBReader API (https://www.qbreader.org/api-docs). */
export class QBReaderProvider implements QuestionProvider {
  private tossupBuf: Tossup[] = [];
  private bonusBuf: Bonus[] = [];
  private bufKey = '';

  constructor(private fetchImpl: typeof fetch = fetch) {}

  private params(f: Filters): URLSearchParams {
    const p = new URLSearchParams({ number: '20' });
    if (f.categories.length) p.set('categories', f.categories.join(','));
    if (f.subcategories.length) p.set('subcategories', f.subcategories.join(','));
    if (f.difficulties.length) p.set('difficulties', f.difficulties.join(','));
    if (f.minYear) p.set('minYear', String(f.minYear));
    if (f.maxYear) p.set('maxYear', String(f.maxYear));
    return p;
  }

  private async get(path: string, params: URLSearchParams): Promise<any> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await this.fetchImpl(`${QBREADER}/${path}?${params}`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`QBReader returned HTTP ${res.status}`);
      return await res.json();
    } catch (e: any) {
      throw new Error(e?.name === 'AbortError' ? 'QBReader timed out' : `Could not reach QBReader: ${e?.message ?? e}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private resetIfFiltersChanged(f: Filters) {
    const key = JSON.stringify(f);
    if (key !== this.bufKey) { this.bufKey = key; this.tossupBuf = []; this.bonusBuf = []; }
  }

  async nextTossup(f: Filters, seen: Set<string>) {
    this.resetIfFiltersChanged(f);
    for (let attempt = 0; attempt < 4; attempt++) {
      const next = this.takeUnseen(this.tossupBuf, seen);
      if (next) return next;
      const data = await this.get('random-tossup', this.params(f));
      const list: unknown[] = data?.tossups ?? (Array.isArray(data) ? data : []);
      this.tossupBuf = list.map(normalizeTossup).filter((t): t is Tossup => !!t);
      if (!list.length) return null;
    }
    return null;
  }

  async nextBonus(f: Filters, seen: Set<string>) {
    this.resetIfFiltersChanged(f);
    for (let attempt = 0; attempt < 4; attempt++) {
      const next = this.takeUnseen(this.bonusBuf, seen);
      if (next) return next;
      const p = this.params(f);
      p.set('threePartBonuses', 'true');
      const data = await this.get('random-bonus', p);
      const list: unknown[] = data?.bonuses ?? (Array.isArray(data) ? data : []);
      this.bonusBuf = list.map(normalizeBonus).filter((b): b is Bonus => !!b);
      if (!list.length) return null;
    }
    return null;
  }

  private takeUnseen<T extends { id: string }>(buf: T[], seen: Set<string>): T | null {
    while (buf.length) {
      const q = buf.shift()!;
      if (!seen.has(q.id)) return q;
    }
    return null;
  }
}

export function parseUpload(raw: unknown): { tossups: Tossup[]; bonuses: Bonus[] } {
  const obj: any = Array.isArray(raw) ? { tossups: raw } : raw ?? {};
  const tossups = (Array.isArray(obj.tossups) ? obj.tossups : []).slice(0, 5000).map(normalizeTossup).filter(Boolean) as Tossup[];
  const bonuses = (Array.isArray(obj.bonuses) ? obj.bonuses : []).slice(0, 5000).map(normalizeBonus).filter(Boolean) as Bonus[];
  return { tossups, bonuses };
}
