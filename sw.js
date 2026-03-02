/* ============================================================
   KPR Parking — Service Worker
   Strategy:
     • App shell (HTML/CSS/JS/icons) → Cache First
     • API calls (/api/*) → Network First, fallback to cache
     • Everything else → Network with cache fallback
   ============================================================ */

const CACHE_NAME    = 'kpr-parking-v1';
const API_CACHE     = 'kpr-api-v1';

// App shell — cache on install, serve from cache forever
const SHELL_ASSETS = [
  '/',
  '/app.js',
  '/style.css',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
  'https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=Share+Tech+Mono&family=Exo+2:wght@300;400;600;700&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'
];

// ── Install: cache the app shell ─────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())   // activate immediately
  );
});

// ── Activate: clean up old caches ────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== API_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())  // take control immediately
  );
});

// ── Fetch: routing strategy ───────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-GET and cross-origin requests (except CDN)
  if (event.request.method !== 'GET') return;

  // ── API calls: Network First ──────────────────────────────
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirstAPI(event.request));
    return;
  }

  // ── App shell: Cache First ────────────────────────────────
  event.respondWith(cacheFirstShell(event.request));
});

async function networkFirstAPI(request) {
  try {
    const response = await fetch(request.clone());
    if (response.ok) {
      // Cache successful API responses for offline fallback
      const cache = await caches.open(API_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (_) {
    // Offline — serve last cached API response if available
    const cached = await caches.match(request);
    if (cached) return cached;
    // Return a graceful offline JSON response for API calls
    return new Response(
      JSON.stringify({ ok: false, error: 'Offline — no cached data available' }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }
}

async function cacheFirstShell(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request.clone());
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (_) {
    // If offline and nothing cached, serve the app shell index
    const fallback = await caches.match('/');
    return fallback || new Response('Offline', { status: 503 });
  }
}

// ── Background Sync: retry failed entries when back online ───
self.addEventListener('sync', event => {
  if (event.tag === 'kpr-sync') {
    event.waitUntil(syncPendingData());
  }
});

async function syncPendingData() {
  // Notify all open clients to re-sync with the server
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(client => client.postMessage({ type: 'SYNC_NOW' }));
}

// ── Push Notifications (future use) ──────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  self.registration.showNotification(data.title || 'KPR Parking', {
    body:    data.body || '',
    icon:    '/icons/icon-192x192.png',
    badge:   '/icons/icon-72x72.png',
    vibrate: [200, 100, 200]
  });
});