// Topics: standalone categories players can pick on their own ("Video Games", "Space", "Food & Drink").
// Deep topics map onto parts of QBReader (category + subcategory or alternate subcategory; the exact names
// QBReader uses, from qbreader/website shared/categories.js). Fun topics have no QBReader equivalent and use
// built-in questions tagged with the topic's id.

export interface TopicSource {
  category: string;
  subcategory?: string;
  /** QBReader alternate subcategory (sent as `alternateSubcategories`, stored on questions as `alternate_subcategory`). */
  alternate?: string;
}

export interface Topic {
  id: string;
  name: string;
  icon: string;
  /** Where QBReader keeps it. Empty: built-in questions only. */
  sources: TopicSource[];
}

export const TOPICS: Topic[] = [
  { id: 'video-games', name: 'Video Games', icon: '🎮', sources: [{ category: 'Pop Culture', subcategory: 'Video Games' }] },
  { id: 'movies', name: 'Movies', icon: '🎬', sources: [{ category: 'Pop Culture', subcategory: 'Movies' }, { category: 'Fine Arts', alternate: 'Film' }] },
  { id: 'music', name: 'Music', icon: '🎵', sources: [{ category: 'Pop Culture', subcategory: 'Music' }, { category: 'Fine Arts', alternate: 'Jazz' }] },
  { id: 'tv', name: 'TV', icon: '📺', sources: [{ category: 'Pop Culture', subcategory: 'Television' }] },
  { id: 'sports', name: 'Sports', icon: '🏅', sources: [{ category: 'Pop Culture', subcategory: 'Sports' }] },
  { id: 'space', name: 'Space', icon: '🪐', sources: [{ category: 'Science', alternate: 'Astronomy' }] },
  { id: 'math', name: 'Math', icon: '➗', sources: [{ category: 'Science', alternate: 'Math' }] },
  { id: 'tech', name: 'Computers & Tech', icon: '💻', sources: [{ category: 'Science', alternate: 'Computer Science' }, { category: 'Science', alternate: 'Engineering' }] },
  { id: 'musicals', name: 'Broadway & Musicals', icon: '🎭', sources: [{ category: 'Fine Arts', alternate: 'Musicals' }] },
  { id: 'economics', name: 'Money & Economics', icon: '💰', sources: [{ category: 'Social Science', alternate: 'Economics' }] },
  { id: 'psychology', name: 'Psychology', icon: '🧠', sources: [{ category: 'Social Science', alternate: 'Psychology' }] },
  { id: 'myths', name: 'Myths & Legends', icon: '🐉', sources: [{ category: 'Mythology' }] },
  { id: 'food', name: 'Food & Drink', icon: '🍕', sources: [] },
  { id: 'animals', name: 'Animals', icon: '🐾', sources: [] },
  { id: 'superheroes', name: 'Superheroes & Comics', icon: '🦸', sources: [] },
  { id: 'memes', name: 'Internet & Memes', icon: '😂', sources: [] },
  { id: 'minecraft', name: 'Minecraft', icon: '⛏️', sources: [] },
];

export const TOPIC_BY_ID = new Map(TOPICS.map((t) => [t.id, t]));
export const TOPIC_BY_NAME = new Map(TOPICS.map((t) => [t.name, t]));

/** Anything with a category, subcategory, optional alternate subcategory and optional explicit topic tags. */
export interface Topical { category: string; subcategory: string; alternate?: string; topics?: string[] }

/** Whether a question belongs to a topic: tagged with it, or in one of the topic's QBReader slices. */
export function inTopic(q: Topical, t: Topic): boolean {
  if (q.topics?.includes(t.id)) return true;
  return t.sources.some((s) => s.category === q.category && (!s.subcategory || s.subcategory === q.subcategory) && (!s.alternate || s.alternate === q.alternate));
}

/** Keep only known topic ids, once each. */
export const cleanTopics = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.map(String).filter((id) => TOPIC_BY_ID.has(id)))] : []);
