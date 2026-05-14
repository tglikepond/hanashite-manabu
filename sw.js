// Service Worker for PWA — v1.8
// Versioned to force browser to detect changes and update the SW
const SW_VERSION = 'v1.8';

self.addEventListener('install', () => {
  console.log(`[SW ${SW_VERSION}] Installing...`);
  // CRITICAL: Skip waiting immediately so this new SW activates right away
  // This is essential for users stuck on old versions without update banner
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  console.log(`[SW ${SW_VERSION}] Activating...`);
  e.waitUntil(
    // Step 1: Clear ALL old caches
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => caches.delete(k)))
    )
    // Step 2: Take control of all clients
    .then(() => self.clients.claim())
    // Step 3: Force reload ALL open windows/tabs
    // This is critical for PWA standalone mode where the old app code
    // doesn't have the update banner. By reloading, we ensure the
    // latest HTML/JS/CSS is fetched from the network.
    .then(() => {
      return self.clients.matchAll({ type: 'window' }).then(clients => {
        clients.forEach(client => {
          client.navigate(client.url);
        });
      });
    })
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

// Listen for messages from the main app (for future update banner flow)
self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') {
    self.skipWaiting();
  }
});
