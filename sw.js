const CACHE_NAME = 'perfectpitch-v70';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/app.js',
  './js/db.js',
  './js/lalalai.js',
  './js/note-utils.js',
  './js/pitch.js',
  './js/analyze.js',
  './js/scoring.js',
  './js/recorder.js',
  './js/audio-worklet-processor.js',
  './js/mic.js',
  './js/player.js',
  './js/visualizer.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let LALAL.AI API requests pass through untouched

  // Network-first: always prefer the freshest deployed files when online.
  // Cache is only a fallback for offline use, so updates show up immediately
  // instead of waiting on the browser's service-worker update cycle.
  //
  // `cache: 'no-store'` matters here and isn't redundant with that goal:
  // without it, this fetch() still consults the browser's ordinary HTTP
  // cache first (separate from the Cache Storage this file manages below),
  // which can transparently return a stale response the browser considers
  // "fresh enough" by normal heuristics — silently defeating "network-first"
  // even though a real network fetch never happens. Confirmed live: a JS
  // file edit didn't take effect across repeated reloads until this was added.
  event.respondWith(
    fetch(req, { cache: 'no-store' })
      .then((res) => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
