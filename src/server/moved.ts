// "Trivio moved": a tiny server for an old address that forwards everyone to the new one.
// Run with MOVED_TO=https://new.host (npm run serve:moved). It never touches the database or rooms.
//  - Pages and links: a permanent redirect to the same path on the new address.
//  - sw.js: a service worker that clears the old saved app, unregisters itself and sends open
//    home-screen apps to the new address (the old worker would otherwise keep opening its saved copy).
//  - /healthz stays up so the host keeps the service healthy.
import express from 'express';
import { pathToFileURL } from 'node:url';

/** A service worker that removes the old app from this address and moves its open windows to `to`. */
export function movedWorker(to: string) {
  return `// Trivio moved to ${to}. This replaces the old app's service worker, clears it, and sends open windows there.
const TO = ${JSON.stringify(to)};
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key);
    await self.clients.claim();
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    await self.registration.unregister();
    for (const w of wins) {
      const u = new URL(w.url);
      try { await w.navigate(TO + u.pathname + u.search + u.hash); } catch (e) { /* not navigable */ }
    }
  })());
});
self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') {
    const u = new URL(event.request.url);
    event.respondWith(Response.redirect(TO + u.pathname + u.search, 302));
  }
});
`;
}

export function movedApp(to: string) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => res.json({ ok: true, movedTo: to }));
  app.get('/sw.js', (_req, res) => {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(movedWorker(to));
  });
  // Live game traffic from an old open tab: say where to go instead of redirecting (it can't follow anyway).
  app.all(/^\/socket\.io(\/|$)/, (_req, res) => res.status(410).json({ error: 'Trivio moved.', to }));
  app.use((req, res) => res.redirect(req.method === 'GET' || req.method === 'HEAD' ? 301 : 308, to + req.originalUrl));
  return app;
}

/** The new address from MOVED_TO: https and a host only. */
export function movedTarget(raw: string | undefined): string | null {
  const to = String(raw ?? '').trim().replace(/\/+$/, '');
  return /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(to) ? to : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const to = movedTarget(process.env.MOVED_TO);
  if (!to) {
    console.error('Set MOVED_TO to the new address, like https://example.onrender.com');
    process.exit(1);
  }
  const port = Number(process.env.PORT) || 3000;
  movedApp(to).listen(port, () => console.log(`Trivio moved: forwarding everything on :${port} to ${to}`));
}
