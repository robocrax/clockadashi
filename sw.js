/* =========================================================================
   CLOCKADASHI service worker
   - Precaches the app shell (html/css/js/manifest) so the kiosk can boot
     fully offline, even after a reboot.
   - Everything else (events.csv, tracks.json, music files, images) is
     network-first with a cache fallback. The actual downloading/pruning of
     music files is managed explicitly by player.js via the Cache API —
     this fetch handler just makes sure that if the network is down, any
     previously cached copy (of anything, including media) is served
     instead of failing.
   Bump SHELL_CACHE's version suffix whenever shell files change, so old
   caches get cleaned up on activate.
   ========================================================================= */
const SHELL_CACHE = 'clockadashi-shell-v1';
const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './player.js',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(
        names
          .filter(n => n.startsWith('clockadashi-shell-') && n !== SHELL_CACHE)
          .map(n => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

const SHELL_URLS = new Set(SHELL_FILES.map(f => new URL(f, self.location).toString()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const isShell = SHELL_URLS.has(req.url) || req.mode === 'navigate';

  if (isShell) {
    event.respondWith(
      caches.match(req.mode === 'navigate' ? './index.html' : req)
        .then(cached => cached || fetch(req))
    );
    return;
  }

  // data files & media: try network first, fall back to any matching cache entry
  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});
