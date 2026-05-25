const CACHE_NAME = 'mi-vocabulario-v4';
const TTS_CACHE  = 'mv-tts-v1';          // keep in sync with app.js

const ASSETS = [
  './index.html',
  './app.js',
  './styles.css',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // Delete stale app-shell caches but always preserve the TTS audio cache.
  const KEEP = new Set([CACHE_NAME, TTS_CACHE]);
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => !KEEP.has(k)).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Only handle GET requests for same-origin assets.
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'KEEP_ALIVE') {
    e.ports[0].postMessage({ type: 'ALIVE' });
  }
});
