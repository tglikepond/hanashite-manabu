// Service Worker for PWA — v2.4
// Hybrid strategy: skipWaiting + update banner as fallback
const SW_VERSION = 'v2.6';

self.addEventListener('install', () => {
  console.log(`[SW ${SW_VERSION}] Installing...`);
  // Always skip waiting — activate immediately
  // The app-side banner serves as a "reload notification" via controllerchange
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  console.log(`[SW ${SW_VERSION}] Activating...`);
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // Network-only: always go to network, never cache
  if (e.request.method !== 'GET') return;

  e.respondWith(
    fetch(e.request).catch(() => {
      if (e.request.mode === 'navigate') {
        return new Response(
          '<html><body style="font-family:sans-serif;text-align:center;padding:60px 20px"><h2>오프라인 상태</h2><p>인터넷 연결을 확인하고 다시 시도해주세요.</p></body></html>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }
      return new Response('', { status: 408 });
    })
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') {
    self.skipWaiting();
  }
});
