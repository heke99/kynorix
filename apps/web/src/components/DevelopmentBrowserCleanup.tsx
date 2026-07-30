'use client';

import { useEffect } from 'react';

/** Removes stale PWA state left by older local builds without reloading the page. */
export function DevelopmentBrowserCleanup() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;

    void Promise.all([
      unregisterServiceWorkers(),
      clearBrowserCaches(),
    ]).catch(() => {
      // Browser cleanup is best-effort and must never interrupt the application.
    });
  }, []);

  return null;
}

async function unregisterServiceWorkers(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));
}

async function clearBrowserCaches(): Promise<void> {
  if (!('caches' in window)) return;
  const keys = await window.caches.keys();
  await Promise.all(keys.map((key) => window.caches.delete(key)));
}
