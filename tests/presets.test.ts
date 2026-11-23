import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import {
  DEFAULT_PRESETS, DEFAULT_RULES, PRESET_SLOTS, cleanPresetSettings, cleanPresets, decodePreset, encodePreset, presetFrom, presetMatches, presetSummary,
} from '../src/shared/presets';

describe('presets', () => {
  it('keeps only known rules with the right types, and never an uploaded packet', () => {
    expect(cleanPresetSettings({ wpm: 250.4, negs: 'yes', powers: false, source: 'upload', mode: 'teams', evil: 1, filters: { categories: ['Science', 3], difficulties: [2, 99, 'x'] } }))
      .toEqual({ wpm: 250, powers: false, mode: 'teams', filters: { categories: ['Science', '3'], subcategories: [], topics: [], difficulties: [2] } });
    expect(presetFrom({ ...DEFAULT_SETTINGS, source: 'upload' }).source).toBe('qbreader');
  });

  it('caps an account at five presets, each named, with unique ids', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, name: `  Preset   ${i} `, settings: { wpm: 200 } }));
    const out = cleanPresets([...many, { id: 'p1', name: 'dupe' }, { id: 'x', name: '   ' }, null]);
    expect(out).toHaveLength(PRESET_SLOTS);
    expect(out[0]).toEqual({ id: 'p0', name: 'Preset 0', settings: { wpm: 200 } });
    expect(cleanPresets('nope')).toEqual([]);
  });

  it('knows when a room already follows a preset', () => {
    const tournament = DEFAULT_PRESETS.find((p) => p.id === 'tournament')!;
    expect(presetMatches(tournament.settings, DEFAULT_SETTINGS)).toBe(false);
    const applied = { ...DEFAULT_SETTINGS, ...tournament.settings };
    expect(presetMatches(tournament.settings, applied)).toBe(true);
    const own = presetFrom({ ...applied, filters: { ...applied.filters, categories: ['History', 'Science'] } });
    expect(presetMatches(own, { ...applied, filters: { ...applied.filters, categories: ['Science', 'History'] } })).toBe(true); // order doesn't matter
  });

  it('travels in a share link and comes back the same, even with non-English names', () => {
    const settings = presetFrom({ ...DEFAULT_SETTINGS, gameLength: 15, filters: { ...DEFAULT_SETTINGS.filters, topics: ['movies'] } });
    const code = encodePreset('Noche de trivia 🎉', settings);
    expect(code).toMatch(/^[\w-]+$/); // safe in a URL
    expect(decodePreset(code)).toEqual({ name: 'Noche de trivia 🎉', settings });
    expect(decodePreset('garbage!!')).toBeNull();
  });

  it('describes a preset in plain words', () => {
    expect(presetSummary(DEFAULT_PRESETS.find((p) => p.id === 'tournament')!.settings)).toBe('Powers 15 · negs −5 · bonuses · 20 tossups · 220 wpm · 7s to answer');
    expect(presetSummary(DEFAULT_PRESETS.find((p) => p.id === 'casual')!.settings)).toBe('Powers · no negs · 20 tossups · 180 wpm · 12s to answer');
  });

  it('default rules undo a preset but keep the questions', () => {
    const picked = { ...DEFAULT_SETTINGS, ...DEFAULT_PRESETS.find((p) => p.id === 'party')!.settings, source: 'lightning' as const, filters: { ...DEFAULT_SETTINGS.filters, categories: ['Science'] } };
    expect(presetMatches(DEFAULT_RULES, picked)).toBe(false);
    const reset = { ...picked, ...DEFAULT_RULES };
    expect(presetMatches(DEFAULT_RULES, reset)).toBe(true);
    expect(reset).toEqual({ ...DEFAULT_SETTINGS, source: 'lightning', filters: picked.filters });
  });
});
