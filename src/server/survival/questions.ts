// Questions for a survival run: endless mixed-category tossups, a little harder as the run goes on.
// QBReader when it answers, otherwise the built-in catalog (works offline).

import type { Filters } from '../../shared/types';
import { CATALOG_TOSSUPS } from '../questions/catalog';
import { LocalProvider } from '../questions/providers';
import { SAMPLE_TOSSUPS } from '../questions/sample';
import type { QuestionProvider, Tossup } from '../questions/types';

const builtin = new LocalProvider([...SAMPLE_TOSSUPS, ...CATALOG_TOSSUPS], []);
const ANY: Filters = { categories: [], subcategories: [], difficulties: [] };
/** After QBReader fails, every run uses the built-in questions for this long before trying it again. */
const RETRY_MS = 5 * 60_000;

/** QBReader difficulty for the nth tossup of a run: easy high school first, then regular, then harder. */
export function survivalDifficulties(n: number): number[] {
  if (n <= 8) return [2];
  if (n <= 20) return [2, 3];
  if (n <= 40) return [3, 4];
  return [4, 5];
}

export class SurvivalProvider implements QuestionProvider {
  /** Shared by every run, so a down QBReader costs one wait, not one per tossup. */
  static qbreaderDownUntil = 0;

  constructor(private qbreader: QuestionProvider, private nextNum: () => number) {}

  async nextTossup(_filters: Filters, seen: Set<string>): Promise<Tossup | null> {
    if (Date.now() >= SurvivalProvider.qbreaderDownUntil) {
      try {
        const q = await this.qbreader.nextTossup({ ...ANY, difficulties: survivalDifficulties(this.nextNum()) }, seen);
        if (q && !seen.has(q.id)) return q;
      } catch {
        SurvivalProvider.qbreaderDownUntil = Date.now() + RETRY_MS;
      }
    }
    // The built-in questions are all regular high school, so they're not filtered by difficulty.
    return builtin.nextTossup(ANY, seen);
  }

  async nextBonus() { return null; }
}
