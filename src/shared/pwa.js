// Shared PWA glue (Phase 11): service worker registration, the deferred
// install prompt, and an online/offline watcher. Imported by every page
// (not just dashboard.js) so installability and the service worker are
// active no matter which page the user lands on first — but only
// dashboard.html actually renders an "Install App" button or an offline
// banner; the other pages just register the service worker and stay
// otherwise unchanged.
//
// Nothing here talks to Supabase or any AI provider, and nothing here
// caches or intercepts those requests — that guarantee lives in
// public/sw.js's fetch handler (same-origin GET requests only).

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.error('Service worker registration failed:', err);
    });
  });
}

// Captures the browser's install prompt (Chrome/Edge/Android; Safari and
// Firefox don't fire this event at all — on those, isAvailable() simply
// never becomes true and an "Install App" button just stays hidden,
// which is the correct, honest behavior rather than a broken button).
export function initInstallPrompt({ onAvailable, onInstalled } = {}) {
  let deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (typeof onAvailable === 'function') onAvailable();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    if (typeof onInstalled === 'function') onInstalled();
  });

  return {
    isAvailable: () => deferredPrompt !== null,
    prompt: async () => {
      if (!deferredPrompt) return 'unavailable';
      deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      deferredPrompt = null;
      return choice.outcome; // 'accepted' | 'dismissed'
    },
  };
}

// Reflects navigator.onLine plus the online/offline window events. Calls
// the matching callback immediately with the current state, then again on
// every change — the caller (dashboard.js) owns what the offline
// indicator actually looks like.
export function initOfflineIndicator({ onOffline, onOnline } = {}) {
  function update() {
    if (navigator.onLine) {
      if (typeof onOnline === 'function') onOnline();
    } else if (typeof onOffline === 'function') {
      onOffline();
    }
  }
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
  return { isOnline: () => navigator.onLine };
}
