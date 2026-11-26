import { useSyncExternalStore } from 'react';
import { pingQuality, type PingQuality } from '../shared/types';
import { socket } from './socket';

// The server times everyone's ping itself (shown in Scores); this answers its message.
socket.on('net:ping', (ack: () => void) => { if (typeof ack === 'function') ack(); });

/** This device's own ping, timed here every few seconds while the page is open, for the chip in the room's top bar. */
export interface PingView { ms: number | null; quality: PingQuality | null; online: boolean }

const EVERY_MS = 3000;
const samples: number[] = [];
let view: PingView = { ms: null, quality: null, online: socket.connected };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function publish(next: PingView) {
  if (next.ms === view.ms && next.online === view.online) return;
  view = next;
  listeners.forEach((l) => l());
}

function measure() {
  if (!socket.connected || document.visibilityState !== 'visible') return;
  const t = performance.now();
  socket.timeout(4000).emit('net:echo', (err: Error | null) => {
    if (err) return;
    samples.push(performance.now() - t);
    if (samples.length > 5) samples.shift();
    // The median of the last few, so one slow message doesn't make it jump.
    const ms = Math.round([...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]);
    publish({ ms, quality: pingQuality(ms), online: true });
  });
}

socket.on('connect', () => { samples.length = 0; publish({ ms: null, quality: null, online: true }); measure(); });
socket.on('disconnect', () => publish({ ms: null, quality: null, online: false }));

/** Your ping right now. Measuring runs only while something shows it. */
export function usePing() {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    if (!timer) { measure(); timer = setInterval(measure, EVERY_MS); }
    return () => {
      listeners.delete(l);
      if (!listeners.size && timer) { clearInterval(timer); timer = null; }
    };
  }, () => view);
}
