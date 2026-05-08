// Minimal Service Worker for PWA install support
// Network-only strategy: never cache, always fetch latest

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  // Clear any old caches from previous versions
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // Network-only: always go to network, no caching
  // This ensures users always get the latest version
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request));
});
