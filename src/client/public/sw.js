// Trivio service worker: makes the app installable and quick to open.
// Pages load network-first (so updates show up right away) with a cached copy as fallback.
// Built assets are content-hashed, so they are cached forever. Live game traffic is never touched.
const VERSION = 'trivio-v4';
// A sleeping free server can take a minute to answer. After this long, open the saved copy and let the app show a wake-up screen.
const SLOW_MS = 3000;
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

// Render answers a sleeping free service with its own "waking up" page (HTTP 200). Only a page carrying
// this marker is Trivio; anything else is never cached, and the saved Trivio app opens instead.
const MARK = 'name="trivio-app"';
const isTrivio = (res) => (res && res.ok ? res.clone().text().then((t) => t.includes(MARK), () => false) : Promise.resolve(false));

/** Save a fetched file only if it's the real thing (the app page has the marker; other files aren't HTML). */
async function keep(cache, url, res) {
  if (!res || !res.ok) return;
  if (url === '/' ? await isTrivio(res) : !(res.headers.get('content-type') || '').includes('text/html')) await cache.put(url, res);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((c) => Promise.all(SHELL.map((url) => fetch(url, { cache: 'no-store' }).then((res) => keep(c, url, res), () => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/socket.io') || url.pathname.startsWith('/api') || url.pathname === '/healthz') return;

  // Hashed build files never change: cache first.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      })),
    );
    return;
  }

  // Pages: network first, fall back to the cached app shell (all routes render the same page).
  // If the network is slow (the server waking up), the cached shell opens after SLOW_MS; the fresh page still updates the cache.
  if (req.mode === 'navigate') {
    const net = fetch(req).then((res) => isTrivio(res).then((ours) => ({ res, ours })));
    // Keep the newest real page as the saved app.
    event.waitUntil(net.then(({ res, ours }) => {
      if (!ours) return;
      const copy = res.clone();
      return caches.open(VERSION).then((c) => c.put('/', copy));
    }).catch(() => {}));
    event.respondWith(new Promise((resolve) => {
      let done = false;
      const finish = (r) => { if (!done && r) { done = true; resolve(r); } };
      const saved = () => caches.match('/');
      const timer = setTimeout(() => saved().then(finish), SLOW_MS);
      net.then(async ({ res, ours }) => {
        clearTimeout(timer);
        if (ours) return finish(res);
        // The host's wake-up page (or an error page): open the saved app, which shows Trivio's own waking screen.
        finish((await saved()) || res);
      }).catch(async () => { clearTimeout(timer); finish((await saved()) || Response.error()); });
    }));
  }
});
