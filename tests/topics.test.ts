import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalProvider, QBReaderProvider, TopicMix } from '../src/server/questions/providers';
import type { Tossup } from '../src/server/questions/types';
import { TOPICS, TOPIC_BY_ID, cleanTopics, inTopic } from '../src/shared/topics';
import { CATEGORIES } from '../src/shared/types';
import { Room, type RoomIO } from '../src/server/rooms/room';
import { CATALOG_TOSSUPS } from '../src/server/questions/catalog';
import { LIGHTNING } from '../src/server/questions/catalog/lightning';

const f0 = { categories: [] as string[], subcategories: [] as string[], difficulties: [] as number[] };
const tu = (id: string, category: string, subcategory: string, extra: Partial<Tossup> = {}): Tossup =>
  ({ id, category, subcategory, question: 'a b c (*) d', answer: '<b>x</b>', ...extra });

describe('topics', () => {
  it('only use QBReader names that exist', () => {
    for (const t of TOPICS) for (const s of t.sources) {
      expect(CATEGORIES[s.category], `${t.id}: ${s.category}`).toBeDefined();
      if (s.subcategory) expect(CATEGORIES[s.category], `${t.id}: ${s.subcategory}`).toContain(s.subcategory);
    }
    expect(cleanTopics(['space', 'nope', 'space', 'food'])).toEqual(['space', 'food']);
  });

  it('match questions by QBReader slice or by tag', () => {
    expect(inTopic(tu('1', 'Science', 'Physics', { alternate: 'Astronomy' }), TOPIC_BY_ID.get('space')!)).toBe(true);
    expect(inTopic(tu('2', 'Science', 'Physics'), TOPIC_BY_ID.get('space')!)).toBe(false);
    expect(inTopic(tu('3', 'Pop Culture', 'Video Games'), TOPIC_BY_ID.get('video-games')!)).toBe(true);
    expect(inTopic(tu('4', 'Pop Culture', 'Other Pop Culture', { topics: ['food'] }), TOPIC_BY_ID.get('food')!)).toBe(true);
  });

  it('ask QBReader for the topic’s slice and drop results without its alternate subcategory', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ tossups: [
        { _id: 'untagged', question: 'q (*) q', answer: 'a', category: 'Science', subcategory: 'Physics' },
        { _id: 'astro', question: 'q (*) q', answer: 'a', category: 'Science', subcategory: 'Physics', alternate_subcategory: 'Astronomy' },
      ] }));
    }) as unknown as typeof fetch;
    const mix = new TopicMix(new QBReaderProvider(fetchImpl), new LocalProvider([], []), true);
    const q = await mix.nextTossup({ ...f0, topics: ['space'] }, new Set());
    expect(q?.id).toBe('astro');
    const u = new URL(urls[0]);
    expect(u.searchParams.get('categories')).toBe('Science');
    expect(u.searchParams.get('alternateSubcategories')).toBe('Astronomy');
    expect(await mix.nextTossup({ ...f0, topics: ['space'] }, new Set(['astro']))).toBeNull();
  });

  it('fall back to built-in questions when QBReader is down or has no such topic', async () => {
    const down = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    const local = new LocalProvider([tu('pizza', 'Pop Culture', 'Other Pop Culture', { topics: ['food'] }), tu('vg', 'Pop Culture', 'Video Games')], []);
    const mix = new TopicMix(new QBReaderProvider(down), local, true);
    expect((await mix.nextTossup({ ...f0, topics: ['food'] }, new Set()))?.id).toBe('pizza');
    expect((await mix.nextTossup({ ...f0, topics: ['video-games'] }, new Set()))?.id).toBe('vg');
    // Nothing built in and QBReader down: the error comes through so the room can say so.
    await expect(mix.nextTossup({ ...f0, topics: ['space'] }, new Set())).rejects.toThrow(/offline/);
  });

  it('mix picked topics with picked categories', async () => {
    const local = new LocalProvider([tu('h', 'History', 'World History'), tu('m', 'Pop Culture', 'Video Games', { topics: ['minecraft'] }), tu('s', 'Science', 'Biology')], []);
    const mix = new TopicMix(local, local, false);
    const seen = new Set<string>();
    const got = [];
    for (let i = 0; i < 3; i++) { const q = await mix.nextTossup({ ...f0, categories: ['History'], topics: ['minecraft'] }, seen); if (q) { seen.add(q.id); got.push(q.id); } }
    expect(got.sort()).toEqual(['h', 'm']);
  });

  it('every fun topic has built-in questions', () => {
    for (const t of TOPICS.filter((x) => !x.sources.length)) {
      const tossups = CATALOG_TOSSUPS.filter((q) => inTopic(q, t)).length;
      const lightning = LIGHTNING.filter((q) => inTopic(q, t)).length;
      expect(tossups, `${t.id} tossups`).toBeGreaterThanOrEqual(5);
      expect(lightning, `${t.id} lightning`).toBeGreaterThanOrEqual(8);
    }
  });
});

describe('topics in a room', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const io: RoomIO = { emitEach: () => {}, emitTo: () => {} };

  it('keeps valid topics, labels them, and shows the topic on the card', async () => {
    const room = new Room('TOP', io, {});
    const host = room.join('Host').playerId;
    room.updateSettings(host, { source: 'sample', filters: { ...f0, topics: ['minecraft', 'bogus'] } });
    expect(room.s.settings.filters.topics).toEqual(['minecraft']);
    room.start(host);
    for (let i = 0; i < 50 && room.s.phase !== 'reading'; i++) await vi.advanceTimersByTimeAsync(20);
    expect(room.snapshot(host).tossup?.topic).toEqual({ name: 'Minecraft', icon: '⛏️' });
  });

  it('puts picked topics on the party-mode ballot', async () => {
    const room = new Room('VOTE', io, {});
    const host = room.join('Host').playerId;
    room.join('Guest');
    room.updateSettings(host, { source: 'sample', topicVote: true, wpm: 900, deadSeconds: 1, filters: { ...f0, topics: ['food', 'animals', 'minecraft'] } });
    room.start(host);
    for (let i = 0; i < 2000 && !room.s.vote; i++) await vi.advanceTimersByTimeAsync(20);
    expect(room.s.vote?.options.sort()).toEqual(['Animals', 'Food & Drink', 'Minecraft']);
  });
});
