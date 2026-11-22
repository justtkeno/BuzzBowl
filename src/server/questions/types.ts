import type { Filters } from '../../shared/types';
import { stripHtml } from '../game/text';

export interface Tossup {
  id: string;
  /** Plain text, may contain the (*) power marker. */
  question: string;
  /** Answer line, may contain <b>/<u> markup for required parts. */
  answer: string;
  category: string;
  subcategory: string;
  /** QBReader's alternate subcategory (Astronomy, Film, Economics, …). */
  alternate?: string;
  /** Topic ids (shared/topics.ts) for questions that belong to a topic outside QBReader's categories. */
  topics?: string[];
  difficulty?: number;
  setName?: string;
  year?: number;
}

export interface Bonus {
  id: string;
  leadin: string;
  parts: string[];
  answers: string[];
  category: string;
  subcategory: string;
  alternate?: string;
  topics?: string[];
  difficulty?: number;
  setName?: string;
  year?: number;
}

export interface QuestionProvider {
  nextTossup(filters: Filters, seen: Set<string>): Promise<Tossup | null>;
  nextBonus(filters: Filters, seen: Set<string>): Promise<Bonus | null>;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function hashId(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return 'h' + (h >>> 0).toString(36);
}

/** Accepts QBReader-shaped objects or the simple {question, answer, category} format. */
export function normalizeTossup(raw: any): Tossup | null {
  if (!raw || typeof raw !== 'object') return null;
  const question = str(raw.question_sanitized) || stripHtml(str(raw.question));
  const answer = str(raw.answer) || str(raw.answer_sanitized);
  if (!question || !answer) return null;
  return {
    id: str(raw._id) || str(raw.id) || hashId(question),
    question: question.replace(/^\s*\d+\.\s*/, ''),
    answer,
    category: str(raw.category) || 'Uncategorized',
    subcategory: str(raw.subcategory) || str(raw.category) || 'Uncategorized',
    ...extras(raw),
    difficulty: num(raw.difficulty),
    setName: str(raw.set?.name) || str(raw.setName) || undefined,
    year: num(raw.set?.year) ?? num(raw.year),
  };
}

/** QBReader's alternate subcategory, and topic tags in uploaded packets. */
function extras(raw: any): { alternate?: string; topics?: string[] } {
  const alternate = str(raw.alternate_subcategory) || str(raw.alternateSubcategory) || undefined;
  const topics = Array.isArray(raw.topics) ? raw.topics.map(str).filter(Boolean).slice(0, 10) : undefined;
  return { ...(alternate ? { alternate } : {}), ...(topics?.length ? { topics } : {}) };
}

export function normalizeBonus(raw: any): Bonus | null {
  if (!raw || typeof raw !== 'object') return null;
  const parts: string[] = Array.isArray(raw.parts_sanitized)
    ? raw.parts_sanitized.map(str)
    : Array.isArray(raw.parts) ? raw.parts.map((p: unknown) => stripHtml(str(p))) : [];
  const answers: string[] = Array.isArray(raw.answers) ? raw.answers.map(str)
    : Array.isArray(raw.answers_sanitized) ? raw.answers_sanitized.map(str) : [];
  if (!parts.length || parts.length !== answers.length || parts.some((p) => !p) || answers.some((a) => !a)) return null;
  const leadin = str(raw.leadin_sanitized) || stripHtml(str(raw.leadin));
  return {
    id: str(raw._id) || str(raw.id) || hashId(leadin + parts.join('|')),
    leadin,
    parts: parts.map((p) => p.replace(/^\s*\[\d+[a-z]?\]\s*/i, '')),
    answers,
    category: str(raw.category) || 'Uncategorized',
    subcategory: str(raw.subcategory) || str(raw.category) || 'Uncategorized',
    ...extras(raw),
    difficulty: num(raw.difficulty),
    setName: str(raw.set?.name) || str(raw.setName) || undefined,
    year: num(raw.set?.year) ?? num(raw.year),
  };
}
