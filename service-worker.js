const VERSION = '0.1.0';
const APP_VERSION = VERSION;
const ICO_VERSION = 'v1.0';

const CACHE_APP = `pokealbum-app-${APP_VERSION}`;
const CACHE_ICO = `pokealbum-ico-${ICO_VERSION}`;

const SCOPE_URL = new URL(self.registration.scope);
const ROOT = SCOPE_URL.pathname.replace(/\/$/, '');

function cacheKeyFor(req) {
  const url = new URL(req.url);
  url.search = '';
  url.hash = '';
  return url.toString();
}

const APP_URLS = [
  `${ROOT}/`,
  `${ROOT}/index.html`,
  `${ROOT}/app.css`,
  `${ROOT}/app.js`,
  `${ROOT}/manifest.webmanifest`
];

const ICO_URLS = [
  `${ROOT}/favicon.ico`,
  `${ROOT}/ico/favicon.ico`,
  `${ROOT}/ico/favicon-16.png`,
  `${ROOT}/ico/favicon-32.png`,
  `${ROOT}/ico/icon-192x192.png`,
  `${ROOT}/ico/icon-512x512.png`,
  `${ROOT}/ico/apple-touch-icon-180x180-flat.png`
];

function normalizeHTMLRequest(req) {
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) return req;

  const wantsHTML =
    req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  if (!wantsHTML) return req;

  if (url.pathname === ROOT || url.pathname === `${ROOT}/`) {
    return new Request(`${ROOT}/index.html`, {
      credentials: 'same-origin'
    });
  }

  return req;
}

async function handleHtmlFetch(event, req) {
  const htmlReq = normalizeHTMLRequest(req);
  const cache = await caches.open(CACHE_APP);
  const cacheKey = `${ROOT}/index.html`;
  const cached = await cache.match(cacheKey);

  if (cached) {
    event.waitUntil((async () => {
      try {
        const fresh = await fetch(htmlReq, {
          cache: 'no-store',
          credentials: 'same-origin'
        });
        await cache.put(cacheKey, fresh.clone());
      } catch {
        // Safari su iPhone ama fare il prezioso. La cache almeno non lo segue.
      }
    })());

    return cached;
  }

  try {
    const fresh = await fetch(htmlReq, {
      cache: 'no-store',
      credentials: 'same-origin'
    });

    await cache.put(cacheKey, fresh.clone());
    return fresh;
  } catch {
    return new Response(
      '<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Offline</title></head><body><h1>Offline</h1><p>PokeAlbum non è disponibile.</p></body></html>',
      {
        status: 503,
        headers: {
          'Content-Type': 'text/html; charset=utf-8'
        }
      }
    );
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const key = cacheKeyFor(req);
  const cached = await cache.match(key);

  if (cached) return cached;

  const fresh = await fetch(req);
  await cache.put(key, fresh.clone());
  return fresh;
}

async function staleWhileRevalidate(event, req, cacheName) {
  const cache = await caches.open(cacheName);
  const key = cacheKeyFor(req);
  const cached = await cache.match(key);

  if (cached) {
    event.waitUntil(
      fetch(req).then(res => cache.put(key, res.clone())).catch(()=>{})
    );
    return cached;
  }

  const fresh = await fetch(req);
  await cache.put(key, fresh.clone());
  return fresh;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const appCache = await caches.open(CACHE_APP);
    const icoCache = await caches.open(CACHE_ICO);

    await Promise.allSettled(APP_URLS.map(url => appCache.add(url)));
    await Promise.allSettled(ICO_URLS.map(url => icoCache.add(url)));

    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([CACHE_APP, CACHE_ICO]);
    const keys = await caches.keys();

    await Promise.all(
      keys.filter(key => !keep.has(key)).map(key => caches.delete(key))
    );

    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;

  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/service-worker.js')) return;

  const isHTML =
    req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    event.respondWith(handleHtmlFetch(event, req));
    return;
  }

  if (
    url.pathname.startsWith(`${ROOT}/ico/`) ||
    url.pathname === `${ROOT}/favicon.ico`
  ) {
    event.respondWith(cacheFirst(req, CACHE_ICO));
    return;
  }

  event.respondWith(staleWhileRevalidate(event, req, CACHE_APP));
});
