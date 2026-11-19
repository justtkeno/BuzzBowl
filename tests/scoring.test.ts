import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Ruling } from '../src/shared/types';
import { computePlayerStats, computeTeamTotals, parseTossupText, scoreTossup } from '../src/server/game/scoring';

const S = DEFAULT_SETTINGS;

describe('parseTossupText', () => {
  it('finds the power mark as its own token', () => {
    const t = parseTossupText('one two (*) three four');
    expect(t.words).toEqual(['one', 'two', 'three', 'four']);
    expect(t.powerIndex).toBe(2);
  });
  it('handles a mark glued to a word', () => {
    expect(parseTossupText('one two(*) three').powerIndex).toBe(2);
    expect(parseTossupText('one (*)two three').powerIndex).toBe(1);
  });
  it('returns null without a mark', () => expect(parseTossupText('a b c').powerIndex).toBeNull());
});

describe('scoreTossup', () => {
  // 10-word question, power mark after word 4.
  const total = 10;
  const power = 4;
  it('powers before or exactly at the mark', () => {
    expect(scoreTossup(true, 0, total, power, S)).toEqual({ points: 15, kind: 'power' });
    expect(scoreTossup(true, 4, total, power, S)).toEqual({ points: 15, kind: 'power' });
  });
  it('gets 10 after the mark', () => expect(scoreTossup(true, 5, total, power, S)).toEqual({ points: 10, kind: 'ten' }));
  it('gets 10 when there is no power mark', () => expect(scoreTossup(true, 1, total, null, S).kind).toBe('ten'));
  it('negs a wrong interrupt', () => expect(scoreTossup(false, 9, total, power, S)).toEqual({ points: -5, kind: 'neg' }));
  it('does not neg once the question is finished', () => expect(scoreTossup(false, 10, total, power, S)).toEqual({ points: 0, kind: 'zero' }));
  it('respects the powers and negs toggles', () => {
    expect(scoreTossup(true, 1, total, power, { ...S, powers: false }).kind).toBe('ten');
    expect(scoreTossup(false, 1, total, power, { ...S, negs: false })).toEqual({ points: 0, kind: 'zero' });
  });
  it('uses custom point values', () => {
    expect(scoreTossup(true, 1, total, power, { ...S, powerValue: 20 }).points).toBe(20);
    expect(scoreTossup(false, 1, total, power, { ...S, negValue: -10 }).points).toBe(-10);
  });
});

describe('stats', () => {
  const r = (over: Partial<Ruling>): Ruling => ({
    id: Math.random().toString(), type: 'tossup', num: 1, playerId: 'p1', playerName: 'P', teamId: 't1', category: 'Science',
    given: 'x', correct: true, overridden: false, points: 10, kind: 'ten', wordIndex: 5, totalWords: 10, powerIndex: 3, ...over,
  });
  it('derives player and team totals from rulings', () => {
    const rulings = [
      r({ num: 1, points: 15, kind: 'power', wordIndex: 2 }),
      r({ num: 2, points: -5, kind: 'neg', correct: false }),
      r({ num: 2, playerId: 'p2', points: 10, kind: 'ten', wordIndex: 8, category: 'History' }),
      r({ type: 'bonus', num: 1, points: 10, partIndex: 0 }),
      r({ type: 'bonus', num: 1, points: 0, correct: false, partIndex: 1 }),
    ];
    const heard = [{ num: 1, category: 'Science', playerIds: ['p1', 'p2'] }, { num: 2, category: 'History', playerIds: ['p1', 'p2'] }];
    const stats = computePlayerStats(['p1', 'p2'], rulings, [{ playerId: 'p1', teamId: 't1', delta: 5 }], heard);
    expect(stats.p1).toMatchObject({ points: 15, powers: 1, negs: 1, buzzes: 2, heard: 2 });
    expect(stats.p1.avgCorrectDepth).toBeCloseTo(0.2);
    expect(stats.p2.categories.History).toMatchObject({ heard: 1, points: 10, tens: 1 });
    expect(computeTeamTotals('t1', rulings, [])).toEqual({ points: 30, bonusPoints: 10, bonusesHeard: 1, bonusPartsCorrect: 1 });
  });
});
