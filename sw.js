/* Service Worker для офлайн-режима «Азимут и расстояние».
   Стратегия:
   - оболочка приложения (HTML/иконки/манифест): stale-while-revalidate
     -> мгновенно из кеша офлайн, в фоне обновляется при наличии сети;
   - зашифрованные данные базовых станций (data.enc.json): stale-while-revalidate
     с игнорированием query (?v=...), чтобы кеш срабатывал офлайн;
   - сторонние ресурсы (тайлы OpenStreetMap): cache-first
     с дозаписью в рантайм-кеш -> уже просмотренные тайлы доступны офлайн.
*/
const VERSION = 'v11';
const APP_CACHE = 'azimut-app-' + VERSION;
const DATA_CACHE = 'azimut-data-' + VERSION;
const RUNTIME_CACHE = 'azimut-runtime-' + VERSION;
const RUNTIME_MAX = 1200; // лимит записей рантайм-кеша (тайлы карты и т.п.)

const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './robots.txt',
  './assets/icon-192.png',
  './assets/icon-512.png',
];
const DATA_FILES = ['./data.enc.json', './rrl.enc.json'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const app = await caches.open(APP_CACHE);
    await app.addAll(APP_SHELL).catch(() => {});
    const data = await caches.open(DATA_CACHE);
    await Promise.allSettled(DATA_FILES.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (res && res.ok) await data.put(url, res.clone());
      } catch (e) { /* офлайн при установке — не критично */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([APP_CACHE, DATA_CACHE, RUNTIME_CACHE]);
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => keep.has(k) ? null : caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  const sameOrigin = url.origin === self.location.origin;

  if (sameOrigin) {
    const isData = /(?:data|rrl)\.enc\.json$/.test(url.pathname);
    event.respondWith(staleWhileRevalidate(req, isData ? DATA_CACHE : APP_CACHE, isData));
    return;
  }
  // сторонние ресурсы: API карт, тайлы, CDN
  event.respondWith(cacheFirstRuntime(req));
});

async function staleWhileRevalidate(req, cacheName, ignoreSearch) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req, { ignoreSearch: !!ignoreSearch });
  const network = fetch(req).then((res) => {
    if (res && res.ok && (res.type === 'basic' || res.type === 'default')) {
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  }).catch(() => null);

  if (cached) { network; return cached; }
  const res = await network;
  if (res) return res;
  if (req.mode === 'navigate') {
    const fallback = await cache.match('./index.html', { ignoreSearch: true });
    if (fallback) return fallback;
  }
  return new Response('Офлайн: ресурс недоступен', { status: 503, statusText: 'Offline' });
}

async function cacheFirstRuntime(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) {
      cache.put(req, res.clone()).then(() => trimCache(RUNTIME_CACHE, RUNTIME_MAX)).catch(() => {});
    }
    return res;
  } catch (e) {
    return cached || new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  const remove = keys.length - max;
  for (let i = 0; i < remove; i++) await cache.delete(keys[i]);
}
