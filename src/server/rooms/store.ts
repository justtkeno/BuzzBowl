import type { Room } from './room';

/**
 * Where rooms live. The in-memory version is enough for one server process.
 * To scale out, implement this over Redis: persist `room.s` (convert its Sets to arrays)
 * and route each room's sockets to one process (e.g. with the Socket.IO Redis adapter).
 */
export interface RoomStore {
  get(code: string): Room | undefined;
  set(room: Room): void;
  delete(code: string): void;
  all(): Iterable<Room>;
}

export class MemoryRoomStore implements RoomStore {
  private rooms = new Map<string, Room>();
  get(code: string) { return this.rooms.get(code.toUpperCase()); }
  set(room: Room) { this.rooms.set(room.s.code, room); }
  delete(code: string) { this.rooms.get(code)?.dispose(); this.rooms.delete(code); }
  all() { return this.rooms.values(); }
}

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export function newRoomCode(store: RoomStore): string {
  for (let len = 4; ; len++) {
    for (let tries = 0; tries < 50; tries++) {
      const code = Array.from({ length: len }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join('');
      if (!store.get(code)) return code;
    }
  }
}
