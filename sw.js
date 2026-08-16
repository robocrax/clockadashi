const CACHE_NAME = 'ghanshyam-dj-v1';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './script.js',
  './events.csv',
  './tracks.json'
];

// Installs the service worker and caches the core static web shell assets
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Controls resource activation sweeps
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Network Proxy Interceptor: Serves matching items directly out of local cache
self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;
      
      // Fallback network fetching profile
      return fetch(e.request).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
          return networkResponse;
        }
        
        // Dynamically add newer unique media resource paths to the cache
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(e.request, responseToCache);
        });
        
        return networkResponse;
      });
    }).catch(() => {
      // Offline fallback handling checks
      if (e.request.mode === 'navigate') {
        return caches.match('./index.html');
      }
    })
  );
});