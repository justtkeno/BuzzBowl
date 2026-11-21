import * as arts from './arts-religion-pop';
import * as history from './history-geo-events';
import * as lit from './lit-myth-phil';
import * as science from './science-other-social';
import * as topics from './topics';
import type { Bonus, Tossup } from '../types';

/** Original questions written for Trivio, across every QBReader category. */
/** Existing questions that also belong to a topic (shared/topics.ts) beyond their QBReader category. */
export const TOPIC_TAGS: Record<string, string[]> = {
  'cat-t-sci-11': ['space'],
  'cat-t-sci-12': ['math'], 'cat-t-oa-6': ['math'], 'cat-t-oa-7': ['math'], 'cat-t-oa-12': ['math'], 'cat-b-oa-3': ['math'],
  'cat-t-oa-5': ['tech'], 'cat-t-oa-8': ['tech'],
  'cat-t-ss-3': ['economics'], 'cat-t-ss-4': ['economics'], 'cat-t-ss-5': ['economics'], 'cat-b-ss-1': ['economics'], 'cat-b-ss-4': ['economics'],
  'cat-t-ss-1': ['psychology'], 'cat-t-ss-2': ['psychology'], 'cat-t-ss-6': ['psychology'], 'cat-t-ss-7': ['psychology'], 'cat-t-ss-12': ['psychology'],
  'cat-b-ss-2': ['psychology'], 'cat-b-ss-3': ['psychology'],
  'cat-t-pop-11': ['minecraft'], 'cat-t-pop-10': ['memes'], 'cat-b-pop-4': ['memes'], 'cat-b-pop-movies-1': ['superheroes'],
};
const tag = <T extends Tossup | Bonus>(q: T): T => (TOPIC_TAGS[q.id] ? { ...q, topics: [...(q.topics ?? []), ...TOPIC_TAGS[q.id]] } : q);

export const CATALOG_TOSSUPS = [...lit.TOSSUPS, ...history.TOSSUPS, ...science.TOSSUPS, ...arts.TOSSUPS, ...topics.TOSSUPS].map(tag);
export const CATALOG_BONUSES = [...lit.BONUSES, ...history.BONUSES, ...science.BONUSES, ...arts.BONUSES, ...topics.BONUSES].map(tag);
