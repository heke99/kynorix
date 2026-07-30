/* Zoryqon currently ships without offline caching. This worker replaces and
 * removes any previously registered development worker so stale assets cannot
 * survive a rebrand or deployment. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))),
      self.registration.unregister(),
    ]).then(() => self.clients.claim()),
  );
});
