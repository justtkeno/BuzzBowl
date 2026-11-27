import { describe, expect, it } from 'vitest';
import { voiceScore } from '../src/client/speech';

const v = (name: string, lang = 'en-US', localService = true) => ({ name, lang, localService });

describe('read-aloud voice choice', () => {
  it('prefers natural-sounding voices and never picks novelty or robotic ones', () => {
    const voices = [
      v('Fred'), v('Zarvox'), v('Bad News'), v('Samantha'), v('Google US English', 'en-US', false),
      v('Microsoft Aria Online (Natural) - English (United States)', 'en-US', false), v('Ava (Premium)'), v('Daniel', 'en-GB'),
      v('Thomas', 'fr-FR'),
    ];
    const ranked = [...voices].sort((a, b) => voiceScore(b) - voiceScore(a)).map((x) => x.name);
    expect(ranked[0]).toMatch(/Natural/);
    expect(ranked.indexOf('Ava (Premium)')).toBeLessThan(ranked.indexOf('Samantha'));
    expect(ranked.indexOf('Google US English')).toBeLessThan(ranked.indexOf('Samantha'));
    for (const bad of ['Fred', 'Zarvox', 'Bad News']) expect(voiceScore(voices.find((x) => x.name === bad)!)).toBeLessThan(0);
    expect(voiceScore(v('Thomas', 'fr-FR'))).toBe(-1000); // not English
  });
});
