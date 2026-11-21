import { useCallback, useEffect, useState } from 'react';
import type { FriendsList } from '../shared/accounts';
import { api, useAccount } from './account';


export const sendFriendRequest = (username: string) => api<FriendsList>('/friends', { method: 'POST', body: { username } });
export const removeFriend = (username: string) => api<FriendsList>(`/friends/${encodeURIComponent(username)}`, { method: 'DELETE' });

/** The logged-in account's friends and requests. With `pollMs`, refreshes that often while the page is visible so statuses stay current. */
export function useFriends(pollMs: number | null) {
  const { me } = useAccount();
  const [list, setList] = useState<FriendsList | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setList(await api<FriendsList>('/friends')); setError(null); } catch (e: any) { setError(e.message); }
  }, []);

  useEffect(() => {
    if (!me) { setList(null); return; }
    void refresh();
    if (!pollMs) return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, pollMs);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [me?.id, pollMs, refresh]);

  /** Run a change (add, accept, remove) and show the list it returns. */
  const change = useCallback(async (fn: () => Promise<FriendsList>) => { setList(await fn()); }, []);

  return { me, list, error, refresh, change };
}
