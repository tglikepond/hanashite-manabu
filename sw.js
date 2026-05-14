// Service Worker for PWA — v2.0
// Update strategy: install → wait → show banner → user clicks update → activate
const SW_VERSION = 'v2.3';

self.addEventListener('install', () => {
  console.log(`[SW ${SW_VERSION}] Installed. Waiting for activation...`);
  // Do NOT call skipWaiting() here!
  // We want the new SW to wait so the app can show an update banner.
  // skipWaiting() is called only when the user clicks "Update" in the banner,
  // which sends a 'skipWaiting' message (see below).
});

self.addEventListener('activate', (e) => {
  console.log(`[SW ${SW_VERSION}] Activating...`);
  e.waitUntil(
    // Clear all old caches
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

// When the user clicks "Update" in the banner, the app sends this message
self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') {
    console.log(`[SW ${SW_VERSION}] skipWaiting triggered by user`);
    self.skipWaiting();
  }
});
