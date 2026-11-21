import * as arts from './arts-religion-pop';
import * as history from './history-geo-events';
import * as lit from './lit-myth-phil';
import * as science from './science-other-social';

/** Original questions written for Trivio, across every QBReader category. */
export const CATALOG_TOSSUPS = [...lit.TOSSUPS, ...history.TOSSUPS, ...science.TOSSUPS, ...arts.TOSSUPS];
export const CATALOG_BONUSES = [...lit.BONUSES, ...history.BONUSES, ...science.BONUSES, ...arts.BONUSES];
