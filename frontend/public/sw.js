// SlimChat service worker.
// Provides PWA installability and a basic offline app shell. API, /files and
// WebSocket traffic are never cached; hashed static assets are cached at runtime.
const CACHE_NAME = 'slimchat-shell-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(['/', '/manifest.json', '/logo.svg', '/icon-192.png']))
      .catch(() => undefined)
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/files')) return;

  // Navigations: network first so upgrades are picked up, cache fallback offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put('/', response.clone()));
          return response;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Hashed build assets: cache first, then fill the cache in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
        return response;
      });
    })
  );
});

// Focus (or open) the app when a system notification is clicked, and tell the
// page which room it belongs to so it can navigate there.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        const client = clientList.find((c) => 'focus' in c);
        if (client) {
          client.postMessage({ type: 'edgechat:notification-click', data });
          return client.focus();
        }
        const url = new URL('/', self.location.origin);
        if (data.roomKind && Number.isSafeInteger(Number(data.roomId)) && Number(data.roomId) > 0) {
          url.searchParams.set('notificationRoomKind', data.roomKind);
          url.searchParams.set('notificationRoomId', String(data.roomId));
        }
        return self.clients.openWindow(url.href);
      })
  );
});
