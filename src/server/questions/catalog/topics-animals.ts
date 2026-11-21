import type { Bonus, Tossup } from '../types';
import { bn, tu } from './helpers';

// More original questions for the Animals topic (id 'animals', see shared/topics.ts).
// Every question here is tagged with the topic automatically.

const TOPIC = ['animals'];
const CAT = 'Science', SUB = 'Biology';

/** Full pyramidal tossups: tu(id, category, subcategory, question with one (*), answer line, difficulty 1-10, topics). */
export const TOSSUPS: Tossup[] = [
];

/** Three-part bonuses. */
export const BONUSES: Bonus[] = [
];

/** One-line lightning prompts (no power mark, at most 25 words). */
const lq = (id: string, question: string, answer: string, difficulty: number, category = CAT, subcategory = SUB): Tossup =>
  ({ id: `lt-${id}`, category, subcategory, question, answer, difficulty, setName: 'Trivio Lightning', year: 2026, topics: TOPIC });

export const LIGHTNING: Tossup[] = [
];

void tu; void bn;
