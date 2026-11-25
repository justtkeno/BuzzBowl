import type { Verdict } from '../../shared/types';
import { parseAnswerLine, type Alt, type AnswerLine } from './answerLine';
import { fuzzyEq, normalize } from './text';

const STOPWORDS = new Set(['of', 'and', 'in', 'on', 'for', 'to', 'a', 'an', 'the', 'de', 'la', 'le', 'von', 'van']);

function tokensMatch(given: string[], wanted: string[], loose = false): boolean {
  return wanted.every((w) => given.some((g) => fuzzyEq(g, w, loose)));
}

/** Abbreviations the player clearly meant as such: in capitals ("DC", "US") or dotted ("D.C.", "u.s."). */
export function typedAbbreviations(raw: string): Set<string> {
  const out = new Set<string>();
  for (const m of raw.matchAll(/\b[A-Z]{2,6}\b/g)) out.add(m[0].toLowerCase());
  for (const m of raw.matchAll(/(?:\b[A-Za-z]\.){2,6}/g)) out.add(m[0].replace(/\./g, '').toLowerCase());
  return out;
}

/**
 * Spell out initials the player typed: "dc" (or "d c" from "D.C.") for "district of columbia", "fdr" for
 * "franklin delano roosevelt". Phrases of three or more words match their initials however they're typed;
 * two-word phrases only when typed as an abbreviation ("US", "N.Y."), so "lt" doesn't count as "leo tolstoy".
 * Returns null when nothing was expanded.
 */
export function expandInitials(g: string, alt: Alt, typed: Set<string> = new Set()): string | null {
  const phrases = new Map<string, { phrase: string; strong: boolean }>();
  for (const phrase of new Set([...alt.required, alt.full])) {
    const words = phrase.split(' ');
    const content = words.filter((w) => !STOPWORDS.has(w));
    if (content.length < 2 || content.some((w) => /\d/.test(w))) continue;
    const key = content.map((w) => w[0]).join('');
    if (!phrases.has(key)) phrases.set(key, { phrase, strong: words.length >= 3 });
  }
  if (!phrases.size) return null;
  // Letters typed apart ("d c" after normalizing "D.C.") read as one abbreviation.
  const tokens: string[] = [];
  let run = ''; // consecutive single letters
  for (const t of [...g.split(' '), '']) {
    if (/^[a-z]$/.test(t)) { run += t; continue; }
    if (run) { tokens.push(run); run = ''; }
    if (t) tokens.push(t);
  }
  let changed = false;
  const out = tokens.map((t) => {
    const hit = phrases.get(t);
    if (hit && t.length >= 2 && (hit.strong || typed.has(t))) { changed = true; return hit.phrase; }
    return t;
  });
  return changed ? out.join(' ') : null;
}

/** Does the normalized answer `g` satisfy this alternative? `typed` = abbreviations from the raw answer. */
export function matchesAlt(g: string, alt: Alt, exactOnly = false, typed?: Set<string>): boolean {
  if (matchesPlain(g, alt, exactOnly)) return true;
  if (exactOnly) return false;
  const spelled = expandInitials(g, alt, typed);
  return !!spelled && matchesPlain(spelled, alt, false);
}

/** `loose`: one typo past what's accepted (see `fuzzyEq`), for asking the player to check their spelling. */
function matchesPlain(g: string, alt: Alt, exactOnly: boolean, loose = false): boolean {
  if (fuzzyEq(g, alt.full, loose) || fuzzyEq(g, alt.required.join(' '), loose)) return true;
  if (alt.required.length === 1 && fuzzyEq(g, alt.required[0], loose)) return true;
  if (exactOnly) return false;

  const gt = g.split(' ');
  const fullTokens = alt.full.split(' ');
  // Every word the player typed must belong to the full answer (ignoring small words),
  // so "tolstoy dostoevsky" does not count as "Leo Tolstoy".
  const allBelong = gt.every((t) => STOPWORDS.has(t) || fullTokens.some((f) => fuzzyEq(t, f, loose)));
  if (!allBelong) return false;
  if (alt.required.every((seg) => tokensMatch(gt, seg.split(' '), loose))) return true;
  // With several underlined pieces, the last one alone is usually enough (surnames, "Battle of Hastings").
  if (alt.required.length > 1 && tokensMatch(gt, alt.required[alt.required.length - 1].split(' '), loose)) return true;
  return false;
}

export interface CheckResult {
  verdict: Verdict;
  /** Set when a misspelled answer was accepted: what it was read as ("mitochondria"). */
  correctedTo?: string;
  /** A 'prompt' because the answer is one typo too far from an accepted one: ask them to check their spelling. */
  spelling?: boolean;
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
  const typed = typedAbbreviations(given);
  if (line.reject.some((a) => matchesAlt(g, a, true))) return { verdict: 'incorrect' };
  const hit = line.accept.find((a) => matchesAlt(g, a, false, typed));
  // An abbreviation isn't a typo, so "Washington DC" needs no "accepted as …" note.
  if (hit) return exactly(expandInitials(g, hit, typed) ?? g, hit) ? { verdict: 'correct' } : { verdict: 'correct', correctedTo: hit.display ?? hit.full };
  if (line.prompt.some((a) => matchesAlt(g, a, false, typed))) return { verdict: 'prompt' };
  // Nearly an accepted answer (and not nearly a rejected one): most likely a slip on a phone keyboard.
  if (line.accept.some((a) => matchesPlain(g, a, false, true)) && !line.reject.some((a) => matchesPlain(g, a, false, true))) {
    return { verdict: 'prompt', spelling: true };
  }
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
