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
import { Accounts } from './accounts/accounts';
import { FileAccountStore, PgAccountStore } from './accounts/store';

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
// Behind Render's / Fly's proxy: trust it for the client IP and https.
app.set('trust proxy', 1);

app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: [...store.all()].length, accounts: accounts.ready ? accounts.kind : 'off' }));
app.use('/api', accounts.router());
if (existsSync(CLIENT_DIR)) {
  app.use(express.static(CLIENT_DIR));
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
  };
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
      store.set(Room.restore(saved, roomIO(saved.code)));
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
  process.on(sig, () => { saveRooms(true); fileAccounts?.flush(); process.exit(0); });
}

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

  const enter = (room: Room, name: string, token: string | undefined, ack: Ack) => {
    try {
      const prev = socket.data as SocketData;
      if (prev.code && prev.playerId && prev.code !== room.s.code) store.get(prev.code)?.disconnect(prev.playerId);
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
    if (prev.code && prev.playerId) store.get(prev.code)?.disconnect(prev.playerId);
    socket.data = { code: room.s.code, watching: true } satisfies SocketData;
    socket.join(room.s.code);
    socket.join(`w:${room.s.code}`);
    ack({ ok: true, code: room.s.code, state: room.snapshot(SPECTATOR) });
  });

  socket.on('room:join', ({ code, name, token }: { code: string; name: string; token?: string }, ack: Ack) => {
    const room = store.get(String(code ?? '').trim());
    if (!room) return ack({ ok: false, error: `No room with code ${String(code).toUpperCase()}.` });
    enter(room, name, token, ack);
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
  socket.on('reader:set', handle(socket, (r, p, target) => r.setReader(p, target ?? null)));
  socket.on('game:start', handle(socket, (r, p) => r.start(p)));
  socket.on('game:next', handle(socket, (r, p) => r.next(p)));
  socket.on('game:end', handle(socket, (r, p) => r.end(p)));
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

accounts.init().finally(() => {
  http.listen(PORT, () => console.log(`Quiz bowl server on http://localhost:${PORT} (accounts: ${accounts.ready ? accounts.kind : 'off'})`));
});
