import express from 'express';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server, type Socket } from 'socket.io';
import { ActionError, Room, type RoomIO } from './rooms/room';
import { botsFor } from './rooms/bots';
import { MemoryRoomStore, newRoomCode, type RoomStore } from './rooms/store';
import { SPECTATOR, type Settings } from '../shared/types';
import { Accounts, type Presence } from './accounts/accounts';
import { FileAccountStore, PgAccountStore } from './accounts/store';
import { Daily, dailyNumber, dayKey, playerKeyFor } from './daily/daily';
import { FileDailyStore, PgDailyStore } from './daily/store';
import { QBReaderProvider } from './questions/providers';
import { ReportError, Reports } from './reports/reports';
import { FileReportStore, PgReportStore } from './reports/store';
import { Survival } from './survival/survival';
import { FileSurvivalStore, PgSurvivalStore } from './survival/store';

const PORT = Number(process.env.PORT ?? 3000);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CLIENT_DIR = join(ROOT, 'dist/client');
const IDLE_ROOM_MS = 30 * 60_000;
/** Rooms are saved here so a restart (or a deploy) doesn't wipe running games. */
const DATA_DIR = process.env.DATA_DIR ?? join(ROOT, 'data');
// One file per port, so two local servers (say dev and a preview) don't overwrite each other.
const SAVE_FILE = join(DATA_DIR, `rooms-${PORT}.json`);
/** Saved rooms older than this are dropped when the server starts. */
const RESTORE_MAX_AGE_MS = 6 * 60 * 60_000;

const app = express();
const http = createServer(app);
const io = new Server(http, { maxHttpBufferSize: 8e6, pingInterval: 10_000 });
const store: RoomStore = new MemoryRoomStore();

// Accounts live in Postgres when DATABASE_URL is set (production), otherwise in a local JSON file.
const fileAccounts = process.env.DATABASE_URL ? null : new FileAccountStore(join(DATA_DIR, `accounts-${PORT}.json`));
const accounts = new Accounts(fileAccounts ?? new PgAccountStore(process.env.DATABASE_URL!));
// The daily challenge's questions and leaderboard sit next to the accounts.
const daily = new Daily(
  process.env.DATABASE_URL ? new PgDailyStore(process.env.DATABASE_URL) : new FileDailyStore(join(DATA_DIR, `daily-${PORT}.json`)),
  new QBReaderProvider(),
);
// Players' reports of questions with a problem, for site admins to review.
const reportStore = process.env.DATABASE_URL ? new PgReportStore(process.env.DATABASE_URL) : new FileReportStore(join(DATA_DIR, `reports-${PORT}.json`));
const reports = new Reports(reportStore);

// Survival runs and their leaderboards, stored the same way.
const survival = new Survival(
  process.env.DATABASE_URL ? new PgSurvivalStore(process.env.DATABASE_URL) : new FileSurvivalStore(join(DATA_DIR, `survival-${PORT}.json`)),
);

// Profiles show each account's daily challenge record and best survival run.
accounts.profileExtras = async (u) => {
  const key = playerKeyFor(u.id, null)!;
  const [d, sv] = await Promise.all([daily.profile(key), survival.profile(key).catch((e) => { console.error('Survival profile failed:', e); return null; })]);
  return { ...(d ? { daily: d } : {}), ...(sv ? { survival: sv } : {}) };
};
// Games saved before records carried their daily-challenge number: match them to that day's result.
accounts.findDaily = async (accountId, at, points) => {
  const day = dayKey(new Date(at));
  const r = await daily.result(day, playerKeyFor(accountId, null)!);
  return r && r.points === points ? dailyNumber(day) : null;
};

/** Hook a daily room up to the leaderboard (also after a restart). */
function attachDaily(room: Room) {
  const d = room.s.daily;
  if (!d) return;
  room.onDailyDone = (o) => {
    const username = (room.s.players.find((p) => p.id === o.playerId) as { username?: string } | undefined)?.username;
    daily.record(o, username).catch((e) => console.error('Could not save a daily result:', e)).finally(() => room.broadcast());
  };
  if (!d.done) {
    daily.active.set(d.playerKey, room.s.code);
    daily.set(d.day).then((t) => room.useDailyQuestions(t)).catch(() => { /* the room shows an error when it asks for a question */ });
  }
}
/** Hook a survival room up to the leaderboard (also after a restart). */
function attachSurvival(room: Room) {
  const sv = room.s.survival;
  if (!sv) return;
  room.onSurvivalDone = (o) => {
    const username = room.s.players.find((p) => p.id === o.playerId)?.username;
    survival.record(o, username).catch((e) => console.error('Could not save a survival run:', e)).finally(() => room.broadcast());
  };
  if (!sv.done) survival.active.set(sv.playerKey, room.s.code);
}
/** The player's survival run in progress, if any. */
function runningSurvival(playerKey: string): Room | undefined {
  const code = survival.active.get(playerKey);
  const room = code ? store.get(code) : undefined;
  return room?.s.survival && !room.s.survival.done && room.s.survival.playerKey === playerKey ? room : undefined;
}
/** Solo rooms nobody else may see or join: the daily challenge, survival. Players there aren't interrupted. */
const playingSolo = (room: Room) => (!!room.s.daily && !room.s.daily.done) || (!!room.s.survival && !room.s.survival.done);

/** Friends list: who is online, and which room they're in. Daily-challenge and survival rooms stay hidden. */
accounts.presence = (ids) => {
  const want = new Set(ids);
  const out = new Map<string, Presence>();
  if (!want.size) return out;
  for (const sock of io.sockets.sockets.values()) {
    const a = accounts.of(sock);
    if (a && want.has(a.id)) out.set(a.id, { status: 'online' });
  }
  // In several rooms at once (several tabs): show the most recently active one.
  const seen = new Map<string, number>();
  for (const room of store.all()) {
    for (const p of room.s.players) {
      if (!p.accountId || !p.online || p.bot || !want.has(p.accountId)) continue;
      const rank = room.s.daily || room.s.survival ? 0 : 1;
      const prev = seen.get(p.accountId);
      const score = rank * 1e15 + room.s.lastActive;
      if (prev !== undefined && prev >= score) continue;
      seen.set(p.accountId, score);
      if (room.s.daily) { out.set(p.accountId, { status: 'daily' }); continue; }
      if (room.s.survival) { out.set(p.accountId, { status: 'survival' }); continue; }
      const phase = room.s.phase === 'lobby' ? 'lobby' : room.s.phase === 'gameOver' ? 'over' : 'playing';
      const players = room.s.players.filter((x) => x.online && !x.bot).length;
      out.set(p.accountId, { status: 'room', room: { code: room.s.code, phase, mode: room.s.settings.mode, players } });
    }
  }
  return out;
};

// Behind Render's / Fly's proxy: trust it for the client IP and https.
app.set('trust proxy', 1);

app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: [...store.all()].length, accounts: accounts.ready ? accounts.kind : 'off' }));
app.use('/api', accounts.router());
if (existsSync(CLIENT_DIR)) {
  app.use(express.static(CLIENT_DIR, {
    setHeaders(res, path) {
      // The service worker and page must always be re-checked; hashed assets never change.
      if (path.endsWith('sw.js') || path.endsWith('.html') || path.endsWith('.webmanifest')) res.setHeader('Cache-Control', 'no-cache');
      else if (path.includes('/assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  }));
  app.get('*', (_req, res) => res.sendFile(join(CLIENT_DIR, 'index.html')));
} else {
  app.get('/', (_req, res) => res.send('Client not built. Run "npm run dev" and open http://localhost:5173, or "npm start".'));
}

interface SocketData { code?: string; playerId?: string; watching?: boolean }

function roomIO(code: string): RoomIO {
  return {
    emitEach(event, payload) {
      let spectatorPayload: unknown;
      for (const s of io.sockets.adapter.rooms.get(code) ?? []) {
        const sock = io.sockets.sockets.get(s);
        const data = sock?.data as SocketData | undefined;
        if (!sock || !data) continue;
        if (data.watching) sock.emit(event, (spectatorPayload ??= payload(SPECTATOR)));
        else if (data.playerId) sock.emit(event, payload(data.playerId));
      }
    },
    emitTo(playerIds, event, payload) {
      for (const id of playerIds) io.to(id === SPECTATOR ? `w:${code}` : `p:${code}:${id}`).emit(event, payload);
    },
    gameOver(records) {
      accounts.record(records);
    },
    remove(playerId) {
      detach(code, playerId);
    },
  };
}

/** Disconnect a removed player's tabs from the room so they stop getting its updates. */
function detach(code: string, playerId: string) {
  const seat = `p:${code}:${playerId}`;
  for (const id of [...(io.sockets.adapter.rooms.get(seat) ?? [])]) {
    const sock = io.sockets.sockets.get(id);
    if (!sock) continue;
    sock.leave(seat);
    sock.leave(code);
    sock.data = {} satisfies SocketData;
  }
}

function makeRoom(): Room {
  const code = newRoomCode(store);
  const room = new Room(code, roomIO(code));
  store.set(room);
  return room;
}

// ---------- saving rooms across restarts ----------

let lastSaved = 0;
function saveRooms(force = false) {
  const rooms = [...store.all()];
  if (!force && !rooms.some((r) => r.s.lastActive > lastSaved)) return;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${SAVE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), rooms: rooms.map((r) => r.toJSON()) }));
    renameSync(tmp, SAVE_FILE);
    lastSaved = Date.now();
  } catch (e) {
    console.error('Could not save rooms:', e);
  }
}

function restoreRooms() {
  if (!existsSync(SAVE_FILE)) return;
  try {
    const data = JSON.parse(readFileSync(SAVE_FILE, 'utf8'));
    let n = 0;
    for (const saved of data.rooms ?? []) {
      if (Date.now() - (saved.lastActive ?? 0) > RESTORE_MAX_AGE_MS) continue;
      const room = Room.restore(saved, roomIO(saved.code));
      attachDaily(room);
      attachSurvival(room);
      store.set(room);
      n++;
    }
    if (n) console.log(`Restored ${n} room${n === 1 ? '' : 's'} from ${SAVE_FILE}`);
  } catch (e) {
    console.error('Could not restore saved rooms:', e);
  }
}
restoreRooms();
setInterval(() => saveRooms(), 3000).unref();
// Bots watch every room a few times a second and buzz / answer when their moment comes.
setInterval(() => { for (const room of store.all()) botsFor(room).tick(); }, 100).unref();
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { saveRooms(true); fileAccounts?.flush(); reportStore.flush(); process.exit(0); });
}

/** Last invite per sender and friend, so nobody can spam someone with invites. */
const lastInvite = new Map<string, number>();
const INVITE_GAP_MS = 20_000;
setInterval(() => { const cut = Date.now() - INVITE_GAP_MS; for (const [k, t] of lastInvite) if (t < cut) lastInvite.delete(k); }, 60_000).unref();

type Ack = (res: { ok: true; [k: string]: unknown } | { ok: false; error: string }) => void;

/** Wrap a handler so thrown ActionErrors come back to the client as { ok: false, error }. */
function handle(socket: Socket, fn: (room: Room, playerId: string, ...args: any[]) => unknown) {
  return (...args: any[]) => {
    const ack: Ack = typeof args[args.length - 1] === 'function' ? args.pop() : () => {};
    const { code, playerId } = socket.data as SocketData;
    const room = code ? store.get(code) : undefined;
    if (!room || !playerId) return ack({ ok: false, error: 'Join a room first.' });
    try {
      const result = fn(room, playerId, ...args);
      ack({ ok: true, ...(result && typeof result === 'object' ? result : {}) });
    } catch (e) {
      if (!(e instanceof ActionError)) console.error(e);
      ack({ ok: false, error: e instanceof ActionError ? e.message : 'Something went wrong.' });
    }
  };
}

// Logged-in players: the session cookie rides along with the socket handshake.
io.use(accounts.socketMiddleware);

io.on('connection', (socket) => {
  socket.on('time', (ack: (t: number) => void) => typeof ack === 'function' && ack(Date.now()));

  /** Moving to another room: stop getting the old room's updates, and go offline there unless another tab is still in it. */
  const leaveSeat = (code: string, playerId: string) => {
    const seat = `p:${code}:${playerId}`;
    socket.leave(code);
    socket.leave(seat);
    if (!io.sockets.adapter.rooms.get(seat)?.size) store.get(code)?.disconnect(playerId);
  };

  const enter = (room: Room, name: string, token: string | undefined, ack: Ack) => {
    try {
      const prev = socket.data as SocketData;
      if (prev.code && prev.playerId && prev.code !== room.s.code) leaveSeat(prev.code, prev.playerId);
      if (prev.watching && prev.code) { socket.leave(prev.code); socket.leave(`w:${prev.code}`); }
      const { playerId, token: tok } = room.join(name, token, accounts.of(socket));
      socket.data = { code: room.s.code, playerId } satisfies SocketData;
      socket.join(room.s.code);
      socket.join(`p:${room.s.code}:${playerId}`);
      ack({ ok: true, code: room.s.code, playerId, token: tok, chat: room.chatHistory(playerId) });
      room.broadcast();
    } catch (e) {
      ack({ ok: false, error: e instanceof ActionError ? e.message : 'Could not join.' });
    }
  };

  socket.on('room:create', ({ name, solo, settings }: { name: string; solo?: boolean; settings?: Partial<Settings> }, ack: Ack) => {
    if (!String(name ?? '').trim()) return ack({ ok: false, error: 'Pick a display name.' });
    const room = makeRoom();
    enter(room, name, undefined, ack);
    const host = (socket.data as SocketData).playerId;
    // Start from the settings this host used last time (saved in their browser).
    if (host && settings && typeof settings === 'object') {
      const { source, ...rest } = settings;
      // 7 s was the old default answer time; hosts who never changed it get the new default.
      if ((rest as Partial<Settings>).answerSeconds === 7) delete (rest as Partial<Settings>).answerSeconds;
      try { room.updateSettings(host, { ...rest, ...(source && source !== 'upload' ? { source } : {}) }); } catch { /* ignore bad saved settings */ }
    }
    if (solo) { room.s.settings.deadSeconds = 3; room.broadcast(); }
  });

  // Big-screen spectator view: receives state, never plays.
  socket.on('room:watch', ({ code }: { code: string }, ack: Ack) => {
    if (typeof ack !== 'function') return;
    const room = store.get(String(code ?? '').trim());
    if (!room) return ack({ ok: false, error: `No room with code ${String(code).toUpperCase()}.` });
    const prev = socket.data as SocketData;
    if (prev.code && prev.playerId) leaveSeat(prev.code, prev.playerId);
    socket.data = { code: room.s.code, watching: true } satisfies SocketData;
    socket.join(room.s.code);
    socket.join(`w:${room.s.code}`);
    ack({ ok: true, code: room.s.code, state: room.snapshot(SPECTATOR) });
  });

  // ---------- daily challenge ----------

  socket.on('daily:status', async ({ key }: { key?: string } = {}, ack: Ack) => {
    if (typeof ack !== 'function') return;
    try {
      const status = await daily.status(playerKeyFor(accounts.of(socket)?.id, key));
      ack({ ok: true, status });
    } catch (e) {
      console.error('daily:status failed:', e);
      ack({ ok: false, error: 'The daily challenge is unavailable right now.' });
    }
  });

  socket.on('daily:start', async ({ name, key }: { name?: string; key?: string } = {}, ack: Ack) => {
    if (typeof ack !== 'function') return;
    const playerKey = playerKeyFor(accounts.of(socket)?.id, key);
    if (!playerKey) return ack({ ok: false, error: 'Could not identify this browser. Reload and try again.' });
    if (!String(name ?? '').trim()) return ack({ ok: false, error: 'Pick a display name.' });
    try {
      const day = daily.today();
      if (await daily.result(day, playerKey)) return ack({ ok: false, error: 'You’ve already played today’s challenge. A new one comes out at midnight Eastern.' });
      // Reloaded mid-challenge: send them back to their own room.
      const activeCode = daily.active.get(playerKey);
      const activeRoom = activeCode ? store.get(activeCode) : undefined;
      if (activeRoom?.s.daily && !activeRoom.s.daily.done && activeRoom.s.daily.day === day) return ack({ ok: true, resume: activeRoom.s.code });
      const tossups = await daily.set(day);
      const room = makeRoom();
      room.makeDaily({ day, number: (await daily.status(null, day)).number, playerKey }, tossups);
      attachDaily(room);
      enter(room, String(name), undefined, ack);
      const host = (socket.data as SocketData).playerId;
      if (host) room.start(host);
    } catch (e) {
      console.error('daily:start failed:', e);
      ack({ ok: false, error: e instanceof ActionError ? e.message : 'Could not start the daily challenge.' });
    }
  });

  // ---------- survival ----------

  socket.on('survival:status', async ({ key }: { key?: string } = {}, ack: Ack) => {
    if (typeof ack !== 'function') return;
    try {
      const playerKey = playerKeyFor(accounts.of(socket)?.id, key);
      ack({ ok: true, status: await survival.status(playerKey, !!playerKey && !!runningSurvival(playerKey)) });
    } catch (e) {
      console.error('survival:status failed:', e);
      ack({ ok: false, error: 'Survival is unavailable right now.' });
    }
  });

  socket.on('survival:start', async ({ name, key }: { name?: string; key?: string } = {}, ack: Ack) => {
    if (typeof ack !== 'function') return;
    const playerKey = playerKeyFor(accounts.of(socket)?.id, key);
    if (!playerKey) return ack({ ok: false, error: 'Could not identify this browser. Reload and try again.' });
    if (!String(name ?? '').trim()) return ack({ ok: false, error: 'Pick a display name.' });
    try {
      // One run at a time: a reload, or Play from the home page, goes back to the run in progress.
      const running = runningSurvival(playerKey);
      if (running) return ack({ ok: true, resume: running.s.code });
      await survival.ready;
      const room = makeRoom();
      room.makeSurvival(playerKey);
      attachSurvival(room);
      enter(room, String(name), undefined, ack);
      const host = (socket.data as SocketData).playerId;
      if (host && (socket.data as SocketData).code === room.s.code) room.start(host);
    } catch (e) {
      console.error('survival:start failed:', e);
      ack({ ok: false, error: e instanceof ActionError ? e.message : 'Could not start a survival run.' });
    }
  });

  socket.on('room:join', ({ code, name, token }: { code: string; name: string; token?: string }, ack: Ack) => {
    const room = store.get(String(code ?? '').trim());
    if (!room) return ack({ ok: false, error: `No room with code ${String(code).toUpperCase()}.` });
    enter(room, name, token, ack);
  });

  // ---------- site admin, from any page ----------

  const siteAdmin = (ack: Ack) => {
    const a = accounts.of(socket);
    if (!a?.admin) { ack({ ok: false, error: 'Admins only.' }); return null; }
    return a;
  };

  // Everyone on the site right now, and every live room.
  socket.on('site:overview', (ack: Ack) => {
    if (typeof ack !== 'function' || !siteAdmin(ack)) return;
    const accountIds = new Set<string>();
    for (const s of io.sockets.sockets.values()) { const a = accounts.of(s); if (a) accountIds.add(a.id); }
    const rooms = [...store.all()].map((r) => {
      const people = r.s.players.filter((p) => !p.bot);
      return {
        code: r.s.code, phase: r.s.phase, mode: r.s.settings.mode, paused: r.s.paused, lastActive: r.s.lastActive,
        daily: r.s.daily ? { number: r.s.daily.number, done: r.s.daily.done } : null,
        survival: r.s.survival ? { lives: r.s.survival.lives, done: r.s.survival.done } : null,
        tossup: r.s.tossupNum, bots: r.s.players.length - people.length,
        host: r.s.players.find((p) => p.id === r.s.hostId)?.name ?? null,
        players: people.map((p) => ({ name: p.name, username: p.username ?? null, online: p.online })),
      };
    }).sort((a, b) => b.players.filter((p) => p.online).length - a.players.filter((p) => p.online).length || b.lastActive - a.lastActive);
    ack({ ok: true, connections: io.sockets.sockets.size, accounts: accountIds.size, rooms });
  });

  // A big message on every screen on the site. Players mid-daily-challenge or mid-survival-run are skipped so it can't cost them a buzz.
  socket.on('site:announce', (text: unknown, ack: Ack) => {
    if (typeof ack !== 'function' || !siteAdmin(ack)) return;
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!clean) return ack({ ok: false, error: 'Type a message first.' });
    const msg = { text: clean, at: Date.now() };
    let sent = 0;
    for (const s of io.sockets.sockets.values()) {
      const d = s.data as SocketData;
      const room = d.code && d.playerId ? store.get(d.code) : undefined;
      if (room && playingSolo(room)) continue;
      s.emit('announce', msg);
      sent++;
    }
    console.log(`Admin @${accounts.of(socket)!.username} announced to ${sent} screens: ${clean}`);
    ack({ ok: true, sent });
  });

  // Shut a room down: everyone in it goes back to the home screen.
  socket.on('site:closeRoom', (code: unknown, ack: Ack) => {
    if (typeof ack !== 'function' || !siteAdmin(ack)) return;
    const room = store.get(String(code ?? ''));
    if (!room) return ack({ ok: false, error: 'That room is already gone.' });
    const c = room.s.code;
    room.recordIfUnfinished();
    room.dispose();
    io.to(c).emit('kicked', { banned: false, closed: true });
    for (const id of [...(io.sockets.adapter.rooms.get(c) ?? [])]) {
      const s = io.sockets.sockets.get(id);
      if (!s) continue;
      const d = s.data as SocketData;
      s.leave(c); s.leave(`w:${c}`);
      if (d.playerId) s.leave(`p:${c}:${d.playerId}`);
      s.data = {} satisfies SocketData;
    }
    store.delete(c);
    console.log(`Admin @${accounts.of(socket)!.username} closed room ${c}`);
    ack({ ok: true });
  });

  // Open question reports, grouped by question.
  socket.on('site:reports', async (ack: Ack) => {
    if (typeof ack !== 'function' || !siteAdmin(ack)) return;
    try {
      ack({ ok: true, ...(await reports.openGroups()) });
    } catch (e) {
      console.error('site:reports failed:', e);
      ack({ ok: false, error: 'Could not load question reports.' });
    }
  });

  // Close every open report of one question, as fixed (resolved) or not a problem (dismissed).
  socket.on('site:resolveReport', async (p: { source?: unknown; questionId?: unknown; status?: unknown } | undefined, ack: Ack) => {
    if (typeof ack !== 'function') return;
    const admin = siteAdmin(ack);
    if (!admin) return;
    try {
      const closed = await reports.resolve(p?.source, p?.questionId, p?.status, admin.username);
      ack({ ok: true, closed });
    } catch (e) {
      if (!(e instanceof ReportError)) console.error('site:resolveReport failed:', e);
      ack({ ok: false, error: e instanceof ReportError ? e.message : 'Could not update the reports.' });
    }
  });

  // A player flags a finished question in their room. The client only names the review item; the room looks up the question.
  socket.on('question:report', async (num: unknown, reason: unknown, note: unknown, ack: Ack) => {
    if (typeof ack !== 'function') return;
    const { code, playerId } = socket.data as SocketData;
    const room = code ? store.get(code) : undefined;
    const seat = room?.s.players.find((p) => p.id === playerId);
    if (!room || !playerId || !seat) return ack({ ok: false, error: 'Join a room first.' });
    try {
      const target = room.reportTarget(playerId, num);
      const a = accounts.of(socket);
      const reporter = a ? { name: a.username, username: a.username, key: `a:${a.id}` } : { name: seat.name, username: null, key: `g:${room.s.code}:${playerId}` };
      const added = await reports.submit(target, reporter, room.s.code, reason, note, [`s:${socket.id}`]);
      room.markReported(playerId, Number(num));
      ack({ ok: true, duplicate: !added });
    } catch (e) {
      const known = e instanceof ActionError || e instanceof ReportError;
      if (!known) console.error('question:report failed:', e);
      ack({ ok: false, error: known ? (e as Error).message : 'Could not send the report.' });
    }
  });

  // Invite a friend into the room you're in. They get a banner wherever they are on the site.
  socket.on('friend:invite', async (username: unknown, ack: Ack) => {
    if (typeof ack !== 'function') return;
    const me = accounts.of(socket);
    if (!me) return ack({ ok: false, error: 'Log in to invite friends.' });
    const { code, playerId } = socket.data as SocketData;
    const room = code ? store.get(code) : undefined;
    const seat = room?.s.players.find((p) => p.id === playerId);
    if (!room || !seat) return ack({ ok: false, error: 'Join a room first.' });
    if (room.s.daily) return ack({ ok: false, error: 'The daily challenge is solo.' });
    if (room.s.survival) return ack({ ok: false, error: 'Survival is solo.' });
    try {
      const them = await accounts.friendOf(me.id, String(username ?? ''));
      if (!them) return ack({ ok: false, error: 'You can only invite friends.' });
      if (room.s.players.some((p) => p.accountId === them.id && p.online)) return ack({ ok: false, error: 'They’re already here.' });
      const key = `${me.id}>${them.id}`;
      if (Date.now() - (lastInvite.get(key) ?? 0) < INVITE_GAP_MS) return ack({ ok: false, error: 'You just invited them.' });
      const targets = [...io.sockets.sockets.values()].filter((s) => accounts.of(s)?.id === them.id);
      if (!targets.length) return ack({ ok: false, error: 'They’re offline right now.' });
      lastInvite.set(key, Date.now());
      const invite = { code: room.s.code, from: { username: me.username, displayName: seat.name }, at: Date.now() };
      for (const s of targets) s.emit('invite', invite);
      ack({ ok: true });
    } catch (e) {
      console.error('friend:invite failed:', e);
      ack({ ok: false, error: 'Could not send the invite.' });
    }
  });

  socket.on('player:rename', handle(socket, (r, p, name) => r.renamePlayer(p, name)));
  socket.on('host:claim', handle(socket, (r, p) => r.claimHost(p)));
  socket.on('bot:add', handle(socket, (r, p, skill) => botsFor(r).add(p, skill)));
  socket.on('bot:skill', handle(socket, (r, p, id, skill) => botsFor(r).setSkill(p, id, skill)));
  socket.on('bot:remove', handle(socket, (r, p, id) => botsFor(r).remove(p, id)));
  socket.on('settings:update', handle(socket, (r, p, patch) => r.updateSettings(p, patch ?? {})));
  socket.on('team:create', handle(socket, (r, p, name) => r.createTeam(p, name)));
  socket.on('team:rename', handle(socket, (r, p, teamId, name) => r.renameTeam(p, teamId, name)));
  socket.on('team:remove', handle(socket, (r, p, teamId) => r.removeTeam(p, teamId)));
  socket.on('team:join', handle(socket, (r, p, teamId) => r.joinTeam(p, teamId)));
  socket.on('team:captain', handle(socket, (r, p, target) => r.makeCaptain(p, target)));
  socket.on('team:move', handle(socket, (r, p, playerId, teamId) => r.movePlayer(p, String(playerId), teamId ? String(teamId) : null)));
  socket.on('reader:set', handle(socket, (r, p, target) => r.setReader(p, target ?? null)));
  socket.on('admin:host', handle(socket, (r, p, target) => r.adminSetHost(p, String(target))));
  socket.on('admin:reader', handle(socket, (r, p, target) => r.adminSetReader(p, target ? String(target) : null)));
  socket.on('admin:peek', handle(socket, (r, p, on) => r.setPeek(p, !!on)));
  socket.on('admin:freeze', handle(socket, (r, p, target, mode) => r.freeze(p, String(target), mode === 'always' || mode === 'tossup' ? mode : 'off')));
  socket.on('admin:rename', handle(socket, (r, p, target, name) => r.adminRename(p, String(target), name)));
  socket.on('admin:announce', handle(socket, (r, p, text) => r.announce(p, text)));
  socket.on('player:kick', handle(socket, (r, p, target, ban) => r.kick(p, String(target), !!ban)));
  socket.on('player:mute', handle(socket, (r, p, target, muted) => r.mute(p, String(target), !!muted)));
  socket.on('player:rebuzz', handle(socket, (r, p, target) => r.allowRebuzz(p, String(target))));
  socket.on('game:start', handle(socket, (r, p) => r.start(p)));
  socket.on('game:next', handle(socket, (r, p) => r.next(p)));
  socket.on('game:end', handle(socket, (r, p) => r.end(p)));
  socket.on('reader:skipUpcoming', handle(socket, (r, p, id) => r.skipUpcoming(p, String(id ?? ''))));
  socket.on('game:pause', handle(socket, (r, p, paused) => r.setPaused(p, !!paused)));
  socket.on('game:hold', handle(socket, (r, p, paused) => r.pauseGame(p, !!paused)));
  socket.on('game:revealTo', handle(socket, (r, p, count) => r.revealTo(p, count)));
  socket.on('buzz', handle(socket, (r, p, count) => r.buzz(p, count)));
  socket.on('answer:typing', (text: string) => {
    const { code, playerId } = socket.data as SocketData;
    if (code && playerId) store.get(code)?.typing(playerId, text);
  });
  socket.on('answer:submit', handle(socket, (r, p, text) => r.submitAnswer(p, text)));
  socket.on('bonus:submit', handle(socket, (r, p, text) => r.bonusSubmit(p, text)));
  socket.on('reader:rule', handle(socket, (r, p, verdict) => r.rule(p, verdict)));
  socket.on('chat', handle(socket, (r, p, text, scope) => r.chat(p, text, scope === 'team' ? 'team' : 'all')));
  socket.on('protest', handle(socket, (r, p, rulingId, note) => r.protest(p, rulingId, note)));
  socket.on('protest:resolve', handle(socket, (r, p, id, accept) => r.resolveProtest(p, id, !!accept)));
  socket.on('ruling:override', handle(socket, (r, p, rulingId) => r.override(p, rulingId)));
  socket.on('score:adjust', handle(socket, (r, p, target, delta) => r.adjust(p, target, delta)));
  socket.on('packet:upload', handle(socket, (r, p, packet) => r.upload(p, packet)));
  socket.on('vote', handle(socket, (r, p, category) => r.castVote(p, String(category ?? ''))));

  socket.on('disconnect', () => {
    const { code, playerId } = socket.data as SocketData;
    if (!code || !playerId) return;
    // A player may have several tabs; only mark offline when their last socket leaves.
    if (io.sockets.adapter.rooms.get(`p:${code}:${playerId}`)?.size) return;
    store.get(code)?.disconnect(playerId);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const room of [...store.all()]) {
    if (room.connectedCount() === 0 && now - room.s.lastActive > IDLE_ROOM_MS) {
      room.recordIfUnfinished();
      store.delete(room.s.code);
    }
  }
}, 60_000).unref();

Promise.all([accounts.init(), daily.ready, reports.ready, survival.ready]).finally(() => {
  http.listen(PORT, () => console.log(`Quiz bowl server on http://localhost:${PORT} (accounts: ${accounts.ready ? accounts.kind : 'off'})`));
});
