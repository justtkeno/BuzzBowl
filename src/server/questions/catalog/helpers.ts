import type { Bonus, Tossup } from '../types';

const SET = 'Trivio Catalog';

/** One tossup. `question` must contain a single (*) power mark; `answer` uses <b><u>required</u></b> markup. */
export const tu = (id: string, category: string, subcategory: string, question: string, answer: string, difficulty = 3): Tossup =>
  ({ id: `cat-t-${id}`, category, subcategory, question, answer, difficulty, setName: SET, year: 2026 });

/** One three-part bonus. */
export const bn = (id: string, category: string, subcategory: string, leadin: string, parts: string[], answers: string[], difficulty = 3): Bonus =>
  ({ id: `cat-b-${id}`, category, subcategory, leadin, parts, answers, difficulty, setName: SET, year: 2026 });
