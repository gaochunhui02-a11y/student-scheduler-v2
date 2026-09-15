// Service worker (Phase 11) — caches ONLY the static app shell. It never
// touches Supabase requests or the AI Edge Functions: both live on a
// different origin (your Supabase project's domain), and the fetch
// handler below bails out immediately for anything that isn't a same-
// origin GET request, before ever calling event.respondWith(). That means
// authenticated API responses and AI responses are never cached, never
// served stale, and never intercepted at all — this worker is invisible
// to them.
//
// Bump CACHE_NAME whenever this file or the app-shell list changes, so
// returning users pick up the new version instead of a stale cache.
const CACHE_NAME = 'student-scheduler-shell-v1';

// Stable, unhashed paths only — the actual bundled JS/CSS files Vite
// produces get hashed filenames that change on every build, so they
// can't be listed here; they're cached opportunistically at runtime
// instead (see the fetch handler below), which stays correct across
// deploys without this file needing to know the current hashes.
const APP_SHELL = [
  '/',
  '/index.html',
  '/login.html',
  '/signup.html',
  '/forgot-password.html',
  '/reset-password.html',
  '/dashboard.html',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch((err) => {
        // A single missing/failed shell resource (e.g. running from a
        // dev server without every page built yet) must never stop the
        // service worker from installing at all.
        console.error('Service worker precache failed:', err);
      })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only ever handle same-origin GET requests. Everything else (Supabase
  // REST/Auth/Storage/Functions calls, any other cross-origin request,
  // and any non-GET method) is left completely alone — no respondWith,
  // no caching, the browser handles it exactly as if this worker didn't
  // exist. This is what keeps authenticated data and AI responses out of
  // the cache entirely, by construction rather than by a denylist.
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Cache-first for the app shell, falling back to network and caching
  // whatever comes back (this is how the hashed JS/CSS bundles end up
  // cached without being precached by name) — and falling back to
  // whatever's cached if the network is unavailable, which is the
  // offline app-shell behavior.
  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
