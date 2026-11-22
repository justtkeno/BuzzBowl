import { CATEGORIES, type Filters } from '../../shared/types';
import { TOPIC_BY_ID, cleanTopics, inTopic, type TopicSource } from '../../shared/topics';
import { normalizeBonus, normalizeTossup, type Bonus, type QuestionProvider, type Tossup } from './types';

/** Filters narrowed to one topic (and, for QBReader, one of its slices). Only TopicMix builds these. */
export type Query = Filters & { topic?: string; source?: TopicSource };

const QBREADER = process.env.QBREADER_URL ?? 'https://www.qbreader.org/api';

function matchesFilters(q: Tossup | Bonus, f: Query): boolean {
  if (f.topic) {
    const t = TOPIC_BY_ID.get(f.topic);
    if (!t || !inTopic(q, t)) return false;
  } else if (f.categories.length && !f.categories.includes(q.category)) return false;
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

export function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Questions from a fixed list (the built-in questions or an uploaded file). */
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
  /** Fetched but not yet used, per query. Topic mixes alternate between queries, so each keeps its own. */
  private bufs = new Map<string, { tossups: Tossup[]; bonuses: Bonus[] }>();

  constructor(private fetchImpl: typeof fetch = fetch) {}

  private params(f: Query): URLSearchParams {
    const p = new URLSearchParams({ number: '20' });
    if (f.source) {
      p.set('categories', f.source.category);
      if (f.source.subcategory) p.set('subcategories', f.source.subcategory);
      if (f.source.alternate) p.set('alternateSubcategories', f.source.alternate);
    } else {
      if (f.categories.length) p.set('categories', f.categories.join(','));
      if (f.subcategories.length) p.set('subcategories', f.subcategories.join(','));
    }
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

  private buf(f: Query) {
    const key = JSON.stringify(f);
    let b = this.bufs.get(key);
    if (!b) {
      b = { tossups: [], bonuses: [] };
      this.bufs.set(key, b);
      // Keep only the most recent few queries.
      while (this.bufs.size > 24) this.bufs.delete(this.bufs.keys().next().value!);
    }
    return b;
  }

  /**
   * QBReader's alternate-subcategory filter also lets through questions with no alternate subcategory,
   * so results are checked against the topic here. Plain category filters are trusted as they are.
   */
  private fits(q: Tossup | Bonus, f: Query) {
    const t = f.topic ? TOPIC_BY_ID.get(f.topic) : undefined;
    return !t || inTopic(q, t);
  }

  async nextTossup(f: Query, seen: Set<string>) {
    const b = this.buf(f);
    for (let attempt = 0; attempt < 4; attempt++) {
      const next = this.takeUnseen(b.tossups, seen);
      if (next) return next;
      const data = await this.get('random-tossup', this.params(f));
      const list: unknown[] = data?.tossups ?? (Array.isArray(data) ? data : []);
      b.tossups = list.map(normalizeTossup).filter((t): t is Tossup => !!t && this.fits(t, f));
      if (!list.length) return null;
    }
    return null;
  }

  async nextBonus(f: Query, seen: Set<string>) {
    const b = this.buf(f);
    for (let attempt = 0; attempt < 4; attempt++) {
      const next = this.takeUnseen(b.bonuses, seen);
      if (next) return next;
      const p = this.params(f);
      p.set('threePartBonuses', 'true');
      const data = await this.get('random-bonus', p);
      const list: unknown[] = data?.bonuses ?? (Array.isArray(data) ? data : []);
      b.bonuses = list.map(normalizeBonus).filter((x): x is Bonus => !!x && this.fits(x, f));
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

/**
 * Mixes a room's picked topics with its category filters: each question comes from one of them, chosen at
 * random. A topic with a QBReader slice asks QBReader first (when `remote`); otherwise, or when QBReader has
 * nothing or can't be reached, it uses the built-in questions tagged with the topic (`local`).
 */
export class TopicMix implements QuestionProvider {
  constructor(private base: QuestionProvider, private local: QuestionProvider, private remote: boolean) {}

  private buckets(f: Filters): Query[] {
    const topics = cleanTopics(f.topics);
    if (!topics.length) return [f];
    const plain: Query[] = f.categories.length || f.subcategories.length ? [{ ...f, topics: [] }] : [];
    return shuffle([...plain, ...topics.map((topic) => ({ ...f, categories: [], subcategories: [], topics: [], topic }))]);
  }

  async nextTossup(f: Filters, seen: Set<string>) { return this.next(f, seen, 'nextTossup'); }
  async nextBonus(f: Filters, seen: Set<string>) { return this.next(f, seen, 'nextBonus'); }

  private async next<K extends 'nextTossup' | 'nextBonus'>(f: Filters, seen: Set<string>, kind: K): Promise<Awaited<ReturnType<QuestionProvider[K]>>> {
    let failure: unknown = null;
    for (const q of this.buckets(f)) {
      try {
        const got = await this.fromBucket(q, seen, kind);
        if (got) return got as any;
      } catch (e) { failure = e; }
    }
    if (failure) throw failure;
    return null as any;
  }

  private async fromBucket(q: Query, seen: Set<string>, kind: 'nextTossup' | 'nextBonus') {
    if (!q.topic) return this.base[kind](q, seen);
    const t = TOPIC_BY_ID.get(q.topic)!;
    let failure: unknown = null;
    if (this.remote) {
      for (const source of shuffle(t.sources)) {
        try {
          const got = await this.base[kind]({ ...q, source } as Query, seen);
          if (got) return got;
        } catch (e) { failure = e; }
      }
    }
    const got = await this.local[kind](q, seen);
    if (!got && failure) throw failure;
    return got;
  }
}
