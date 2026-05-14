// Service Worker for PWA — v1.4
// Versioned to force browser to detect changes and update the SW
const SW_VERSION = 'v1.4';

self.addEventListener('install', () => {
  console.log(`[SW ${SW_VERSION}] Installing...`);
  // Skip waiting to activate immediately (don't wait for old tabs to close)
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  console.log(`[SW ${SW_VERSION}] Activating...`);
  e.waitUntil(
    // Clear ALL caches from any previous versions
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => caches.delete(k)))
    ).then(() => {
      // Take control of all open clients immediately
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', (e) => {
  // Network-only: always go to network, never cache
  // This ensures users always get the latest version
  if (e.request.method !== 'GET') return;

  e.respondWith(
    fetch(e.request).catch(() => {
      // If network fails and it's a navigation request, show offline message
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

// Listen for messages from the main app
self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') {
    self.skipWaiting();
  }
});
