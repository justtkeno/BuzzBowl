import { describe, expect, it } from 'vitest';
import { CATEGORIES } from '../src/shared/types';
import { checkAnswerDetailed } from '../src/server/game/answerCheck';
import { parseTossupText } from '../src/server/game/scoring';
import { CATALOG_BONUSES, CATALOG_TOSSUPS } from '../src/server/questions/catalog';
import { SAMPLE_BONUSES, SAMPLE_TOSSUPS } from '../src/server/questions/sample';

/** The plain required answer: text of the answer line before any [bracket], tags stripped. */
const mainAnswer = (html: string) => html.split('[')[0].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const validSub = (cat: string, sub: string) => (CATEGORIES[cat]?.length ? CATEGORIES[cat].includes(sub) : sub === cat);

describe('question catalog', () => {
  const all = [...CATALOG_TOSSUPS, ...CATALOG_BONUSES, ...SAMPLE_TOSSUPS, ...SAMPLE_BONUSES];
  it('has unique ids', () => {
    const ids = all.map((q) => q.id);
    expect(ids.length - new Set(ids).size).toBe(0);
  });

  for (const t of CATALOG_TOSSUPS) {
    it(`tossup ${t.id}`, () => {
      expect(CATEGORIES[t.category], `unknown category ${t.category}`).toBeDefined();
      expect(validSub(t.category, t.subcategory), `bad subcategory ${t.subcategory}`).toBe(true);
      expect(t.question.split('(*)').length, 'exactly one (*)').toBe(2);
      const { words, powerIndex } = parseTossupText(t.question);
      expect(words.length, 'length 45-140 words').toBeGreaterThanOrEqual(45);
      expect(words.length).toBeLessThanOrEqual(140);
      const frac = (powerIndex ?? 0) / words.length;
      expect(frac, '(*) between 40% and 90% of the way in').toBeGreaterThan(0.4);
      expect(frac).toBeLessThan(0.9);
      expect(t.answer).toMatch(/<b><u>.+?<\/u><\/b>/);
      expect(checkAnswerDetailed(mainAnswer(t.answer), t.answer).verdict, `own answer "${mainAnswer(t.answer)}" accepted`).toBe('correct');
      const ans = mainAnswer(t.answer).toLowerCase().split(' ').filter((w) => w.length > 4);
      for (const w of ans) expect(t.question.toLowerCase().split(/[^a-z0-9']+/), `answer word "${w}" leaks into the question`).not.toContain(w);
    });
  }

  for (const b of CATALOG_BONUSES) {
    it(`bonus ${b.id}`, () => {
      expect(CATEGORIES[b.category]).toBeDefined();
      expect(validSub(b.category, b.subcategory), `bad subcategory ${b.subcategory}`).toBe(true);
      expect(b.parts.length).toBe(3);
      expect(b.answers.length).toBe(3);
      b.answers.forEach((a, i) => {
        expect(a).toMatch(/<b><u>.+?<\/u><\/b>/);
        expect(checkAnswerDetailed(mainAnswer(a), a).verdict, `part ${i + 1} answer accepted`).toBe('correct');
      });
    });
  }
});
