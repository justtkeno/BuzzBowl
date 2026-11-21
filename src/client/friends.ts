import { useCallback, useEffect, useState } from 'react';
import type { FriendsList } from '../shared/accounts';
import { api, useAccount } from './account';

const POLL_MS = 15_000;

export const sendFriendRequest = (username: string) => api<FriendsList>('/friends', { method: 'POST', body: { username } });
export const removeFriend = (username: string) => api<FriendsList>(`/friends/${encodeURIComponent(username)}`, { method: 'DELETE' });

/** The logged-in account's friends and requests. With `live`, refreshes while the page is visible so statuses stay current. */
export function useFriends(live: boolean) {
  const { me } = useAccount();
  const [list, setList] = useState<FriendsList | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setList(await api<FriendsList>('/friends')); setError(null); } catch (e: any) { setError(e.message); }
  }, []);

  useEffect(() => {
    setList(null);
    if (!me) return;
    void refresh();
    if (!live) return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [me?.id, live, refresh]);

  /** Run a change (add, accept, remove) and show the list it returns. */
  const change = useCallback(async (fn: () => Promise<FriendsList>) => { setList(await fn()); }, []);

  return { me, list, error, refresh, change };
}
