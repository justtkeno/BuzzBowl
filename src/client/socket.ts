import { io, type Socket } from 'socket.io-client';

export const socket: Socket = io({ autoConnect: true, transports: ['websocket', 'polling'] });

type AckResult = { ok: true; [k: string]: any } | { ok: false; error: string };

/** Emit an event and resolve with the server's ack. Rejects with the server's error message. */
export function call<T = Record<string, any>>(event: string, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    socket.timeout(10_000).emit(event, ...args, (err: Error | null, res: AckResult) => {
      if (err) return reject(new Error('The server did not respond.'));
      if (!res.ok) return reject(new Error(res.error));
      resolve(res as T);
    });
  });
}

/** Server clock minus local clock, estimated from the lowest-latency of a few pings. */
export let clockOffset = 0;

async function syncClock() {
  let best = Infinity;
  for (let i = 0; i < 5; i++) {
    const sent = Date.now();
    const server = await new Promise<number>((res) => socket.timeout(3000).emit('time', (_e: unknown, t: number) => res(t ?? sent)));
    const rtt = Date.now() - sent;
    if (rtt < best) { best = rtt; clockOffset = server + rtt / 2 - Date.now(); }
  }
}
socket.on('connect', () => void syncClock());

export const serverNow = () => Date.now() + clockOffset;

const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
export const prefs = {
  name: () => store.get('qb:name') ?? '',
  setName: (n: string) => store.set('qb:name', n),
  token: (code: string) => store.get(`qb:token:${code}`) ?? undefined,
  setToken: (code: string, t: string) => store.set(`qb:token:${code}`, t),
  theme: () => (store.get('qb:theme') as 'auto' | 'light' | 'dark' | null) ?? 'auto',
  setTheme: (t: string) => store.set('qb:theme', t),
  /** The last room settings this player used as host, reused when they create a new room. */
  settings: (): Record<string, unknown> | undefined => {
    try { return JSON.parse(store.get('qb:settings') ?? 'null') ?? undefined; } catch { return undefined; }
  },
  /** `sync` tells a logged-in account to save them too (see account.ts). */
  setSettings: (s: unknown, sync = true) => {
    const json = JSON.stringify(s);
    if (json === store.get('qb:settings')) return;
    store.set('qb:settings', json);
    if (sync) window.dispatchEvent(new CustomEvent('qb-settings', { detail: s }));
  },
};
