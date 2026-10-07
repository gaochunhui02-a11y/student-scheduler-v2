// Demo Mode flag. A visitor enters the demo through dashboard.html?demo=1
// (the "Try the demo" button on the landing/login pages). The flag lives in
// sessionStorage, so it only affects the current tab and ends when the tab
// closes. It is honoured ONLY on the dashboard page — auth pages always
// use the real client, so logging in from the same tab can never be
// intercepted by demo data.

const FLAG_KEY = 'student-scheduler-demo';

function isDashboardPath(pathname) {
  return /\/dashboard(\.html)?$/.test(pathname || '');
}

export function syncDemoFlagFromUrl(loc = typeof location !== 'undefined' ? location : null) {
  if (!loc) return;
  try {
    const params = new URLSearchParams(loc.search);
    if (params.get('demo') === '1') sessionStorage.setItem(FLAG_KEY, '1');
    if (params.get('demo') === '0') sessionStorage.removeItem(FLAG_KEY);
    // Auth pages always mean "use a real account" — leave demo behind.
    if (!isDashboardPath(loc.pathname) && /\/(login|signup|forgot-password|reset-password)(\.html)?$/.test(loc.pathname)) {
      sessionStorage.removeItem(FLAG_KEY);
    }
  } catch {
    // storage unavailable — demo simply isn't enabled
  }
}

export function isDemoMode(loc = typeof location !== 'undefined' ? location : null) {
  if (!loc || !isDashboardPath(loc.pathname)) return false;
  try {
    return sessionStorage.getItem(FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

export function exitDemoMode() {
  try {
    sessionStorage.removeItem(FLAG_KEY);
    sessionStorage.removeItem('student-scheduler-demo-db');
  } catch {
    // ignore
  }
}
