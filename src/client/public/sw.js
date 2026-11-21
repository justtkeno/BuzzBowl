// Trivio service worker: makes the app installable and quick to open.
// Pages load network-first (so updates show up right away) with a cached copy as fallback.
// Built assets are content-hashed, so they are cached forever. Live game traffic is never touched.
const VERSION = 'trivio-v3';
// A sleeping free server can take a minute to answer. After this long, open the saved copy and let the app show a wake-up screen.
const SLOW_MS = 3000;
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
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
    const net = fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put('/', copy)); }
      return res;
    });
    event.waitUntil(net.catch(() => {}));
    event.respondWith(new Promise((resolve) => {
      let done = false;
      const finish = (r) => { if (!done && r) { done = true; resolve(r); } };
      const timer = setTimeout(() => caches.match('/').then(finish), SLOW_MS);
      net.then((res) => { clearTimeout(timer); finish(res); })
        .catch(() => { clearTimeout(timer); caches.match('/').then((hit) => finish(hit || Response.error())); });
    }));
  }
});
