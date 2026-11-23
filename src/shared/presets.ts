// Game presets: named sets of room rules. A few built-in ones, plus up to PRESET_SLOTS of a signed-in player's own,
// saved on their account. Any preset can be shared as a link (the rules travel in the link itself).

import type { Filters, Settings } from './types';

/** The rules a preset can carry. Everything in Settings except an uploaded packet, which only exists in one room. */
export type PresetSettings = Partial<Omit<Settings, 'source' | 'filters'>> & { source?: 'qbreader' | 'sample' | 'lightning'; filters?: Filters };

export interface Preset { id: string; name: string; settings: PresetSettings }

/** How many presets an account can keep. */
export const PRESET_SLOTS = 5;
export const PRESET_NAME_MAX = 30;

/** Built-in presets. They set only the rules they're about (Party also picks free-for-all). */
export const DEFAULT_PRESETS: (Preset & { blurb: string })[] = [
  {
    id: 'casual', name: 'Casual', blurb: 'Relaxed: no penalty for wrong answers, extra time to answer.',
    settings: { powers: true, negs: false, bonuses: false, bounty: false, topicVote: false, wpm: 180, answerSeconds: 12, deadSeconds: 6, gameLength: 20 },
  },
  {
    id: 'tournament', name: 'Tournament rules', blurb: 'Standard quiz bowl scoring: powers, negs and bonuses.',
    settings: { powers: true, powerValue: 15, tenValue: 10, negs: true, negValue: -5, bonuses: true, bonusPartValue: 10, bonusSeconds: 20, bounty: false, topicVote: false, wpm: 220, answerSeconds: 7, deadSeconds: 5, gameLength: 20 },
  },
  {
    id: 'quick10', name: 'Quick 10', blurb: 'A fast 10-tossup game.',
    settings: { powers: true, negs: true, bonuses: false, bounty: false, topicVote: false, wpm: 240, answerSeconds: 8, deadSeconds: 4, gameLength: 10 },
  },
  {
    id: 'party', name: 'Party', blurb: 'Everyone for themselves, vote on topics, and bounty tossups worth double.',
    settings: { mode: 'ffa', topicVote: true, bounty: true, powers: true, negs: false, bonuses: false, wpm: 200, answerSeconds: 10, deadSeconds: 5, gameLength: 20 },
  },
];

const NUMBERS = ['wpm', 'answerSeconds', 'bonusSeconds', 'deadSeconds', 'powerValue', 'tenValue', 'negValue', 'bonusPartValue', 'gameLength'] as const;
const FLAGS = ['powers', 'negs', 'bonuses', 'showTextToPlayers', 'readerRules', 'topicVote', 'bounty'] as const;
const strings = (v: unknown, max: number) => (Array.isArray(v) ? v.map(String).map((x) => x.slice(0, 60)).slice(0, max) : []);

/** Keeps only known rules with the right types. The room still clamps every number when a preset is applied. */
export function cleanPresetSettings(v: unknown): PresetSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const out: PresetSettings = {};
  for (const k of NUMBERS) if (typeof o[k] === 'number' && Number.isFinite(o[k])) out[k] = Math.round(o[k] as number);
  for (const k of FLAGS) if (typeof o[k] === 'boolean') out[k] = o[k] as boolean;
  if (o.mode === 'ffa' || o.mode === 'teams') out.mode = o.mode;
  if (o.source === 'qbreader' || o.source === 'sample' || o.source === 'lightning') out.source = o.source;
  if (o.filters && typeof o.filters === 'object') {
    const f = o.filters as Record<string, unknown>;
    out.filters = {
      categories: strings(f.categories, 30), subcategories: strings(f.subcategories, 60), topics: strings(f.topics, 40),
      difficulties: Array.isArray(f.difficulties) ? f.difficulties.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 10).slice(0, 11) : [],
      ...(typeof f.minYear === 'number' ? { minYear: f.minYear } : {}), ...(typeof f.maxYear === 'number' ? { maxYear: f.maxYear } : {}),
    };
  }
  return out;
}

export function cleanPresetName(v: unknown): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, PRESET_NAME_MAX);
}

/** An account's saved presets: at most PRESET_SLOTS, each with a name and an id. */
export function cleanPresets(v: unknown): Preset[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: Preset[] = [];
  for (const x of v) {
    if (!x || typeof x !== 'object') continue;
    const p = x as Record<string, unknown>;
    const name = cleanPresetName(p.name);
    const id = String(p.id ?? '').replace(/[^\w-]/g, '').slice(0, 24);
    if (!name || !id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name, settings: cleanPresetSettings(p.settings) });
    if (out.length >= PRESET_SLOTS) break;
  }
  return out;
}

/** The rules worth saving from a room's current settings (an uploaded packet falls back to QBReader). */
export function presetFrom(s: Settings): PresetSettings {
  const { source, ...rest } = s;
  return cleanPresetSettings({ ...rest, source: source === 'upload' ? 'qbreader' : source });
}

/** True when the room's settings already follow every rule in the preset. */
export function presetMatches(p: PresetSettings, s: Settings): boolean {
  return (Object.keys(p) as (keyof PresetSettings)[]).every((k) => JSON.stringify(normalize(k, p[k])) === JSON.stringify(normalize(k, s[k as keyof Settings])));
}
function normalize(k: string, v: unknown) {
  if (k !== 'filters' || !v) return v;
  const f = v as Filters;
  return { c: [...f.categories].sort(), s: [...f.subcategories].sort(), t: [...(f.topics ?? [])].sort(), d: [...f.difficulties].sort(), a: f.minYear ?? null, b: f.maxYear ?? null };
}

/** One line in plain words: "Powers 15 · negs −5 · bonuses · 20 tossups · 220 wpm". */
export function presetSummary(p: PresetSettings): string {
  const parts: string[] = [];
  if (p.mode === 'teams') parts.push('teams');
  if (p.topicVote) parts.push('topic voting');
  if (p.powers !== undefined) parts.push(p.powers ? `powers${p.powerValue !== undefined ? ` ${p.powerValue}` : ''}` : 'no powers');
  if (p.negs !== undefined) parts.push(p.negs ? `negs${p.negValue !== undefined ? ` ${String(p.negValue).replace('-', '−')}` : ''}` : 'no negs');
  if (p.bonuses) parts.push('bonuses');
  if (p.bounty) parts.push('bounty tossups');
  if (p.gameLength !== undefined) parts.push(p.gameLength ? `${p.gameLength} tossups` : 'no set length');
  if (p.wpm !== undefined) parts.push(`${p.wpm} wpm`);
  if (p.answerSeconds !== undefined) parts.push(`${p.answerSeconds}s to answer`);
  if (p.source === 'lightning') parts.push('lightning round');
  else if (p.source === 'sample') parts.push('built-in questions');
  const f = p.filters;
  if (f && (f.categories.length || (f.topics?.length ?? 0))) parts.push([...(f.topics ?? []), ...f.categories].slice(0, 3).join(', ') + ((f.topics?.length ?? 0) + f.categories.length > 3 ? '…' : ''));
  const s = parts.join(' · ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------- share links: the preset travels in the URL ----------

export function encodePreset(name: string, settings: PresetSettings): string {
  const json = JSON.stringify({ v: 1, n: cleanPresetName(name), s: settings });
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodePreset(code: string): { name: string; settings: PresetSettings } | null {
  try {
    const bin = atob(code.replace(/-/g, '+').replace(/_/g, '/'));
    const json = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    const o = JSON.parse(json);
    const name = cleanPresetName(o?.n);
    if (!name || o?.v !== 1) return null;
    return { name, settings: cleanPresetSettings(o.s) };
  } catch {
    return null;
  }
}
