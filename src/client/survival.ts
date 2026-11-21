import { useCallback, useEffect, useState } from 'react';
import type { SurvivalStatus } from '../shared/types';
import { dailyKey } from './daily';
import { call, socket } from './socket';

/** Survival leaderboards and this player's best runs. Guests use the same browser key as the daily challenge. */
export function useSurvivalStatus(enabled = true) {
  const [status, setStatus] = useState<SurvivalStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    call<{ status: SurvivalStatus }>('survival:status', { key: dailyKey() }).then((r) => { setStatus(r.status); setError(null); }, (e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!enabled) return;
    if (socket.connected) refresh();
    socket.on('connect', refresh);
    return () => { socket.off('connect', refresh); };
  }, [enabled, refresh]);
  return { status, error, refresh };
}
