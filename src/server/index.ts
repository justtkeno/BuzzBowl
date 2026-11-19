import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server, type Socket } from 'socket.io';
import { ActionError, Room } from './rooms/room';
import { MemoryRoomStore, newRoomCode, type RoomStore } from './rooms/store';

const PORT = Number(process.env.PORT ?? 3000);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CLIENT_DIR = join(ROOT, 'dist/client');
const IDLE_ROOM_MS = 30 * 60_000;

const app = express();
const http = createServer(app);
const io = new Server(http, { maxHttpBufferSize: 8e6, pingInterval: 10_000 });
const store: RoomStore = new MemoryRoomStore();

app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: [...store.all()].length }));
if (existsSync(CLIENT_DIR)) {
  app.use(express.static(CLIENT_DIR));
  app.get('*', (_req, res) => res.sendFile(join(CLIENT_DIR, 'index.html')));
} else {
  app.get('/', (_req, res) => res.send('Client not built. Run "npm run dev" and open http://localhost:5173, or "npm start".'));
}

interface SocketData { code?: string; playerId?: string }

function makeRoom(): Room {
  const code = newRoomCode(store);
  const room = new Room(code, {
    emitEach(event, payload) {
      for (const s of io.sockets.adapter.rooms.get(code) ?? []) {
        const sock = io.sockets.sockets.get(s);
        const pid = (sock?.data as SocketData | undefined)?.playerId;
        if (sock && pid) sock.emit(event, payload(pid));
      }
    },
    emitTo(playerIds, event, payload) {
      for (const id of playerIds) io.to(`p:${code}:${id}`).emit(event, payload);
    },
  });
  store.set(room);
  return room;
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

io.on('connection', (socket) => {
  socket.on('time', (ack: (t: number) => void) => typeof ack === 'function' && ack(Date.now()));

  const enter = (room: Room, name: string, token: string | undefined, ack: Ack) => {
    try {
      const prev = socket.data as SocketData;
      if (prev.code && prev.playerId && prev.code !== room.s.code) store.get(prev.code)?.disconnect(prev.playerId);
      const { playerId, token: tok } = room.join(name, token);
      socket.data = { code: room.s.code, playerId } satisfies SocketData;
      socket.join(room.s.code);
      socket.join(`p:${room.s.code}:${playerId}`);
      ack({ ok: true, code: room.s.code, playerId, token: tok, chat: room.chatHistory(playerId) });
      room.broadcast();
    } catch (e) {
      ack({ ok: false, error: e instanceof ActionError ? e.message : 'Could not join.' });
    }
  };

  socket.on('room:create', ({ name, solo }: { name: string; solo?: boolean }, ack: Ack) => {
    if (!String(name ?? '').trim()) return ack({ ok: false, error: 'Pick a display name.' });
    const room = makeRoom();
    if (solo) room.s.settings.deadSeconds = 3;
    enter(room, name, undefined, ack);
  });

  socket.on('room:join', ({ code, name, token }: { code: string; name: string; token?: string }, ack: Ack) => {
    const room = store.get(String(code ?? '').trim());
    if (!room) return ack({ ok: false, error: `No room with code ${String(code).toUpperCase()}.` });
    enter(room, name, token, ack);
  });

  socket.on('player:rename', handle(socket, (r, p, name) => r.renamePlayer(p, name)));
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
    if (room.connectedCount() === 0 && now - room.s.lastActive > IDLE_ROOM_MS) store.delete(room.s.code);
  }
}, 60_000).unref();

http.listen(PORT, () => console.log(`Quiz bowl server on http://localhost:${PORT}`));
