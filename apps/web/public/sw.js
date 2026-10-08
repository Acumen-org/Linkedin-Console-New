// Service worker: shows push notifications for new LinkedIn messages and opens the
// conversation when clicked. No offline caching (the inbox needs a live connection).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'New message', {
      body: data.body || '',
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: data.tag,
      renotify: true,
      data: { url: data.url || '/inbox' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/inbox', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if (w.url.startsWith(self.location.origin) && 'focus' in w) {
          // Navigate inside the open app (a reload would lose a reply being typed).
          w.postMessage({ type: 'navigate', url });
          return w.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
