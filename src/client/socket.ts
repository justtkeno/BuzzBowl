import { io, type Socket } from 'socket.io-client';
import { DEFAULT_SETTINGS, type Settings, type SourceKind } from '../shared/types';

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
  /** 'auto' | 'light' | 'dark', or a full theme from THEMES in App.tsx (midnight, sand, slate). */
  theme: () => store.get('qb:theme') ?? 'auto',
  /** Question text size on this device. */
  textSize: () => (store.get('qb:textSize') as 's' | 'm' | 'l' | null) ?? 'm',
  setTextSize: (t: 's' | 'm' | 'l') => store.set('qb:textSize', t),
  setTheme: (t: string) => store.set('qb:theme', t),
  /** Accent color on this device (see ACCENTS in App.tsx); 'ink' (the Packet look's blue) is the default. */
  accent: () => store.get('qb:accent') ?? 'ink',
  setAccent: (a: string) => store.set('qb:accent', a),
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
  /** Solo practice's own questions (source + topic filters), kept apart from the room settings above so a
   *  Lightning game with friends doesn't turn every practice into Lightning. */
  practice: (): PracticeQuestions => {
    try {
      const p = JSON.parse(store.get('qb:practice') ?? 'null');
      if (p && PRACTICE_SOURCES.includes(p.source) && p.filters && typeof p.filters === 'object') return { source: p.source, filters: { ...DEFAULT_SETTINGS.filters, ...p.filters } };
    } catch { /* fall through */ }
    return { source: DEFAULT_SETTINGS.source, filters: structuredClone(DEFAULT_SETTINGS.filters) };
  },
  setPractice: (p: PracticeQuestions) => {
    if (!PRACTICE_SOURCES.includes(p.source)) return;
    store.set('qb:practice', JSON.stringify({ source: p.source, filters: p.filters }));
    window.dispatchEvent(new Event('qb-practice'));
  },
  /** The code of the practice room this device last created, so changes made in it update practice, not room settings. */
  practiceRoom: () => store.get('qb:practiceRoom'),
  setPracticeRoom: (code: string | null) => store.set('qb:practiceRoom', code ?? ''),
};

export type PracticeQuestions = Pick<Settings, 'source' | 'filters'>;
/** Uploaded packets belong to one room, so practice never starts from one. */
export const PRACTICE_SOURCES: SourceKind[] = ['qbreader', 'sample', 'lightning'];
