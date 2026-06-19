// Service Worker for Band Chords PWA
const CACHE_NAME = 'band-chords-v2.1.2';
const ASSETS_CACHE = 'band-chords-assets-v2.1.2';
const DATA_CACHE = 'band-chords-data-v2.1.2';

// Assets to cache (critical for offline functionality)
const ASSETS_TO_CACHE = [
    '/',
    '/index.html',
    '/styles.css',
    '/app.js',
    '/sw-register.js',
    '/manifest.json',
    'https://cdn.jsdelivr.net/npm/markdown-it@14.0.0/dist/markdown-it.min.js',
    '/ChordSheetJS.bundle.min.js'
];

// Install: Cache all static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(ASSETS_CACHE)
      .then((cache) => {
        return cache.addAll(ASSETS_TO_CACHE);
      })
      .then(() => self.skipWaiting()) // NEU: Zwingt den SW, sofort aktiv zu werden!
  );
});

// Fetch: Serve from cache or fetch and cache
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Skip non-GET requests
    if (event.request.method !== 'GET') {
        return;
    }

    // Handle API requests separately
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(handleApiRequest(event));
        return;
    }

    // Handle static assets
    if (ASSETS_TO_CACHE.includes(url.pathname) ||
        ASSETS_TO_CACHE.includes(url.pathname + '/')) {
        event.respondWith(
            caches.match(event.request)
                .then((response) => {
                    // Return cached response or fetch
                    return response || fetch(event.request)
                        .then((fetchResponse) => {
                            // Clone and cache the response
                            const responseClone = fetchResponse.clone();
                            caches.open(ASSETS_CACHE)
                                .then((cache) => {
                                    cache.put(event.request, responseClone);
                                });
                            return fetchResponse;
                        });
                })
        );
        return;
    }

    // Default: try cache, then network
    event.respondWith(
        caches.match(event.request)
            .then((response) => {
                return response || fetch(event.request);
            })
    );
});

// Handle API requests with network-first, cache-fallback strategy
// Handle API requests with network-first, cache-fallback strategy
async function handleApiRequest(event) {
  const cache = await caches.open(DATA_CACHE);
  const url = new URL(event.request.url);

  // Definiert eine absolute Obergrenze von 1.5 Sekunden für das Netzwerk
  const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => reject(new Error('Network Timeout')), 1500)
  );

  try {
    // Rennen zwischen dem echten Go-Backend und dem 1.5s Timeout.
    const networkResponse = await Promise.race([
      fetch(event.request),
      timeoutPromise
    ]);

    if (networkResponse.ok) {
      // Use the exact URL as cache key for API requests
      await cache.put(event.request.url, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    console.log("Offline-Modus: Lade aus Cache für Pfad:", url.pathname);

    // Try to match using the exact request URL
    const cachedResponse = await cache.match(event.request.url);
    if (cachedResponse) {
      return cachedResponse;
    }

    // Handle specific song requests with error fallback
    if (url.pathname.startsWith('/api/songs/')) {
      const fallback = {
        id: "error",
        title: "Offline-Fehler",
        content: "# ⚠️ Song nicht im Cache\nBitte einmal online öffnen."
      };
      return new Response(JSON.stringify(fallback), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
  }
}

// Activate: Clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME && cacheName !== ASSETS_CACHE && cacheName !== DATA_CACHE) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim()) // NEU: Übernimmt sofort die Kontrolle über alle offenen Tabs!
  );
});

// Message: Allow clearing cache from client
self.addEventListener('message', (event) => {
    if (event.data && event.data.action === 'clearCache') {
        event.waitUntil(
            caches.keys().then((cacheNames) => {
                return Promise.all(
                    cacheNames.map((cacheName) => {
                        return caches.delete(cacheName);
                    })
                );
            })
        );
    }
});


