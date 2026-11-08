/* BookNd service worker: caches the app shell so the library and reader open offline.
 * Books themselves live in IndexedDB on the device; they are never put in this cache,
 * and nothing from /api/ (catalog, downloads) is cached here. */
const VERSION = 'booknd-v4';
const SHELL = ['/', '/read/', '/discover/', '/manifest.webmanifest', '/assets/brand/logo.svg', '/assets/icons/icon.svg', '/assets/icons/icon-192.png', '/fonts/libre-baskerville-400.woff2', '/fonts/libre-baskerville-400-italic.woff2', '/fonts/libre-baskerville-700.woff2', '/fonts/inter-var.woff2'];

async function precache() {
  const cache = await caches.open(VERSION);
  await Promise.all(
    SHELL.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (!res.ok) return;
        await cache.put(url, res.clone());
        if ((res.headers.get('content-type') || '').includes('text/html')) {
          // Cache every script and stylesheet the page needs, so routes render offline on first launch.
          const html = await res.text();
          const assets = new Set([...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)].map((m) => m[1]));
          await Promise.all([...assets].map((a) => cache.add(a).catch(() => {})));
        }
      } catch {
        /* offline during install: runtime caching fills in later */
      }
    }),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// The page sends the app chunks it has loaded (including the on-demand EPUB engine) so they survive offline.
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'cache-urls' || !Array.isArray(data.urls)) return;
  event.waitUntil(
    caches.open(VERSION).then((cache) =>
      Promise.all(
        data.urls
          .filter((u) => typeof u === 'string' && new URL(u).origin === self.location.origin && /^\/(_next\/static|fonts)\//.test(new URL(u).pathname))
          .map(async (u) => {
            if (!(await cache.match(u))) await cache.add(u).catch(() => {});
          }),
      ),
    ),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Pages: network first (fresh deploys), cache fallback keyed by path (query strings like ?book= share the shell).
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(VERSION);
        try {
          const res = await fetch(req);
          if (res.ok) cache.put(url.pathname, res.clone());
          return res;
        } catch {
          return (await cache.match(url.pathname)) || (await cache.match('/')) || Response.error();
        }
      })(),
    );
    return;
  }

  // Next.js build assets are content-hashed: cache first. Fonts and icons too.
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/assets/') || url.pathname.startsWith('/_next/image')) {
    event.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  // Everything else (RSC payloads for client navigation, manifest): network, falling back to cache.
  event.respondWith(
    (async () => {
      const cache = await caches.open(VERSION);
      try {
        const res = await fetch(req);
        if (res.ok && !url.search.includes('_rsc')) cache.put(req, res.clone());
        return res;
      } catch {
        return (await cache.match(req, { ignoreSearch: true })) || Response.error();
      }
    })(),
  );
});
