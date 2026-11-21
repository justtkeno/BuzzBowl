import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATEGORIES, DIFFICULTIES } from '../src/shared/types';
import { checkAnswerDetailed } from '../src/server/game/answerCheck';
import { parseTossupText } from '../src/server/game/scoring';
import { LIGHTNING } from '../src/server/questions/catalog/lightning';
import { Room, TIMING } from '../src/server/rooms/room';

/** The answer line's main answer as plain text, as a player would type it. */
const mainAnswer = (line: string) => line.replace(/\[.*$/, '').replace(/<[^>]+>/g, '').trim();

describe('lightning question set', () => {
  it('has a good spread of well-formed questions', () => {
    expect(LIGHTNING.length).toBeGreaterThanOrEqual(150);
    expect(new Set(LIGHTNING.map((q) => q.id)).size).toBe(LIGHTNING.length);
    const levels = new Set(LIGHTNING.map((q) => q.difficulty));
    expect(levels.size).toBeGreaterThanOrEqual(6);
    for (const q of LIGHTNING) {
      expect(Object.keys(CATEGORIES), q.id).toContain(q.category);
      const subs = CATEGORIES[q.category];
      if (subs.length) expect(subs, q.id).toContain(q.subcategory);
      expect(DIFFICULTIES[q.difficulty!], q.id).toBeDefined();
      expect(q.question, q.id).not.toContain('(*)');
      expect(parseTossupText(q.question).words.length, q.id).toBeLessThanOrEqual(25);
      expect(q.answer, q.id).toMatch(/<u>/);
    }
  });

  it('accepts the main answer of every question', () => {
    for (const q of LIGHTNING) {
      const main = mainAnswer(q.answer);
      expect(checkAnswerDetailed(main, q.answer).verdict, `${q.id}: ${main}`).toBe('correct');
    }
  });
});

describe('lightning round in a room', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows the whole prompt at once, scores a flat ten and skips bonuses', async () => {
    const room = new Room('TEST', { emitEach: () => {}, emitTo: () => {} });
    const ann = room.join('Ann').playerId;
    const bob = room.join('Bob').playerId;
    room.updateSettings(ann, { source: 'lightning', mode: 'teams' });
    room.start(ann);
    await vi.advanceTimersByTimeAsync(TIMING.startDelayMs + 10);
    const t = room.s.tossup!;
    expect(t.revealed).toBe(t.words.length);
    expect(t.deadline! - Date.now()).toBeGreaterThan(7000);
    room.buzz(bob, t.revealed);
    await vi.advanceTimersByTimeAsync(TIMING.graceMs + 1);
    room.submitAnswer(bob, mainAnswer(t.q.answer));
    expect(room.s.rulings[0]).toMatchObject({ points: 10, kind: 'ten' });
    expect(room.s.tossup?.bonusTeam).toBeNull();
  });
});
