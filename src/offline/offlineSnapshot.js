// Offline read mode (V3-P). After the Dashboard loads, a small read-only
// snapshot (today's timeline, open tasks, courses, upcoming exams) is kept
// in localStorage under the signed-in user's id. If the app is opened or
// reloaded without a connection, the Dashboard shows that snapshot,
// clearly labelled, instead of an error. Nothing is written back from it.
// Snapshots are removed on sign-out. The service worker never caches
// Supabase responses — this is the only offline copy of user data, it
// stays on this device, and it is deliberately small.

const PREFIX = 'student-scheduler-offline:';
const ENABLED_KEY = 'student-scheduler-offline-copy'; // V4-I privacy switch (per device)
const MAX_ROUTINES = 20;
const MAX_TASKS = 25;
const MAX_EXAMS = 8;
const MAX_COURSES = 30;
// Older snapshots are discarded (and deleted) rather than shown: they would
// be misleading, and there's no reason to keep personal data around.
export const SNAPSHOT_MAX_AGE_DAYS = 14;

const str = (v, max = 200) => String(v ?? '').slice(0, max);

/** Pure: reduce the Dashboard's loaded data to the snapshot shape. */
export function buildOfflineSnapshot(d, savedAt) {
  const courses = (d.courses || []).slice(0, MAX_COURSES).map((c) => ({ id: c.id, name: str(c.name, 120), code: str(c.code, 32), color: /^#[0-9a-fA-F]{6}$/.test(c.color || '') ? c.color : null }));
  const known = new Set(courses.map((c) => c.id));
  const tasks = (d.groups || [])
    .filter((g) => !g.done)
    .sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'))
    .slice(0, MAX_TASKS)
    .map((g) => ({ name: str(g.name), dueDate: g.dueDate || null, remainingMinutes: Number(g.remainingMinutes) || 0, courseId: known.has(g.courseId) ? g.courseId : null }));
  const timeline = (d.todayEvents || [])
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((e) => ({ kind: e.kind, title: str(e.title), start: e.start, end: e.end, completed: Boolean(e.completed), courseId: known.has(e.courseId) ? e.courseId : null }));
  const exams = (d.exams || [])
    .filter((x) => x.exam_date >= d.today)
    .sort((a, b) => a.exam_date.localeCompare(b.exam_date))
    .slice(0, MAX_EXAMS)
    .map((x) => ({ name: str(x.name, 120), date: x.exam_date, courseId: known.has(x.course_id) ? x.course_id : null }));
  // V4-I (v2): today's routines, titles + ticked state only.
  const routines = (d.routinesToday || []).slice(0, MAX_ROUTINES).map((x) => ({ title: str(x.routine ? x.routine.title : x.title, 120), done: (x.status || (x.done ? 'done' : null)) === 'done' }));
  return { v: 2, savedAt, date: d.today, timeline, tasks, courses, exams, routines };
}

/** V4-I: is keeping an offline copy on this device allowed? (default yes) */
export function offlineCopyEnabled() {
  try { return localStorage.getItem(ENABLED_KEY) !== 'off'; } catch { return false; }
}
export function setOfflineCopyEnabled(on) {
  try {
    if (on) localStorage.removeItem(ENABLED_KEY);
    else {
      localStorage.setItem(ENABLED_KEY, 'off');
      clearOfflineSnapshots();
    }
  } catch { /* storage blocked */ }
}

/** Pure: is a stored value a usable snapshot? */
export function isValidSnapshot(s) {
  return Boolean(s && (s.v === 1 || s.v === 2) && typeof s.savedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.date || '')
    && Array.isArray(s.timeline) && Array.isArray(s.tasks) && Array.isArray(s.courses) && Array.isArray(s.exams));
}

/** Pure: is the snapshot recent enough to show? */
export function isFreshSnapshot(s, now = Date.now(), maxAgeDays = SNAPSHOT_MAX_AGE_DAYS) {
  const t = Date.parse(s && s.savedAt);
  return Number.isFinite(t) && t <= now + 60000 && now - t <= maxAgeDays * 86400000;
}

export function saveOfflineSnapshot(userId, snapshot) {
  if (!userId || !offlineCopyEnabled()) return;
  try {
    localStorage.setItem(PREFIX + userId, JSON.stringify(snapshot));
  } catch {
    // storage full or blocked — offline mode just won't have a snapshot
  }
}

export function loadOfflineSnapshot(userId) {
  if (!userId) return null;
  try {
    const s = JSON.parse(localStorage.getItem(PREFIX + userId));
    if (!isValidSnapshot(s)) return null;
    if (!isFreshSnapshot(s)) {
      localStorage.removeItem(PREFIX + userId);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

// Sign-out: remove every user's snapshot from this device.
export function clearOfflineSnapshots() {
  try {
    Object.keys(localStorage).filter((k) => k.startsWith(PREFIX)).forEach((k) => localStorage.removeItem(k));
  } catch {
    // nothing stored
  }
}

export function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}
