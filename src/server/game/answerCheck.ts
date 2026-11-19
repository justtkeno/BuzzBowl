import type { Verdict } from '../../shared/types';
import { parseAnswerLine, type Alt, type AnswerLine } from './answerLine';
import { fuzzyEq, normalize } from './text';

const STOPWORDS = new Set(['of', 'and', 'in', 'on', 'for', 'to', 'a', 'an', 'the', 'de', 'la', 'le', 'von', 'van']);

function tokensMatch(given: string[], wanted: string[]): boolean {
  return wanted.every((w) => given.some((g) => fuzzyEq(g, w)));
}

/** Does the normalized answer `g` satisfy this alternative? */
export function matchesAlt(g: string, alt: Alt, exactOnly = false): boolean {
  if (fuzzyEq(g, alt.full) || fuzzyEq(g, alt.required.join(' '))) return true;
  if (alt.required.length === 1 && fuzzyEq(g, alt.required[0])) return true;
  if (exactOnly) return false;

  const gt = g.split(' ');
  const fullTokens = alt.full.split(' ');
  // Every word the player typed must belong to the full answer (ignoring small words),
  // so "tolstoy dostoevsky" does not count as "Leo Tolstoy".
  const allBelong = gt.every((t) => STOPWORDS.has(t) || fullTokens.some((f) => fuzzyEq(t, f)));
  if (!allBelong) return false;
  if (alt.required.every((seg) => tokensMatch(gt, seg.split(' ')))) return true;
  // With several underlined pieces, the last one alone is usually enough (surnames, "Battle of Hastings").
  if (alt.required.length > 1 && tokensMatch(gt, alt.required[alt.required.length - 1].split(' '))) return true;
  return false;
}

export function checkAgainst(given: string, line: AnswerLine): Verdict {
  const g = normalize(given);
  if (!g) return 'incorrect';
  if (line.reject.some((a) => matchesAlt(g, a, true))) return 'incorrect';
  if (line.accept.some((a) => matchesAlt(g, a))) return 'correct';
  if (line.prompt.some((a) => matchesAlt(g, a))) return 'prompt';
  return 'incorrect';
}

export function checkAnswer(given: string, answerLine: string): Verdict {
  return checkAgainst(given, parseAnswerLine(answerLine));
}
