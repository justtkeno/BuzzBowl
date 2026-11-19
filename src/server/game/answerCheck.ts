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

export interface CheckResult {
  verdict: Verdict;
  /** Set when a misspelled answer was accepted: what it was read as ("mitochondria"). */
  correctedTo?: string;
}

/** True when the player typed one of the alternative's words exactly, so no auto-correction happened. */
function exactly(g: string, alt: Alt): boolean {
  if (g === alt.full || g === alt.required.join(' ')) return true;
  const words = new Set(alt.full.split(' '));
  return g.split(' ').every((t) => words.has(t) || STOPWORDS.has(t));
}

export function checkDetailed(given: string, line: AnswerLine): CheckResult {
  const g = normalize(given);
  if (!g) return { verdict: 'incorrect' };
  if (line.reject.some((a) => matchesAlt(g, a, true))) return { verdict: 'incorrect' };
  const hit = line.accept.find((a) => matchesAlt(g, a));
  if (hit) return exactly(g, hit) ? { verdict: 'correct' } : { verdict: 'correct', correctedTo: hit.display ?? hit.full };
  if (line.prompt.some((a) => matchesAlt(g, a))) return { verdict: 'prompt' };
  return { verdict: 'incorrect' };
}

export function checkAgainst(given: string, line: AnswerLine): Verdict {
  return checkDetailed(given, line).verdict;
}

export function checkAnswer(given: string, answerLine: string): Verdict {
  return checkAgainst(given, parseAnswerLine(answerLine));
}

export function checkAnswerDetailed(given: string, answerLine: string): CheckResult {
  return checkDetailed(given, parseAnswerLine(answerLine));
}
