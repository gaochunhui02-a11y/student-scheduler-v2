// V4-I reminders: routines not ticked yet, and the weekly review. Opt-in
// (off by default), per device, never asks for notification permission by
// itself, and fires each reminder at most once (sent keys kept per device).
//
// Routine reminder times by time of day: morning 08:00, afternoon 13:00,
// evening 19:00, any time 18:00 — only while the routine is still unticked
// for today. Weekly review: Friday from 17:00, once per week, until the
// week is marked reviewed.

const PREFS_KEY = 'student-scheduler-v4-reminders';
const SENT_KEY = 'student-scheduler-v4-reminders-sent';
const POLL_MS = 10 * 60 * 1000;
export const ROUTINE_TIMES = { morning: 8 * 60, afternoon: 13 * 60, evening: 19 * 60, anytime: 18 * 60 };

export function normalizeReminderPrefs(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return { routines: src.routines === true, weeklyReview: src.weeklyReview === true };
}

export function readReminderPrefs() {
  try { return normalizeReminderPrefs(JSON.parse(localStorage.getItem(PREFS_KEY))); } catch { return normalizeReminderPrefs(null); }
}
export function writeReminderPrefs(prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(normalizeReminderPrefs(prefs))); } catch { /* per device */ }
}

/**
 * Pure: routine reminders due now.
 * @param {Array<{routine, status}>} todayList  from routinesForDay()
 * @returns {Array<{ key, routine }>}
 */
export function dueRoutineReminders(todayList = [], today, nowMinutes, sent = []) {
  return todayList
    .filter((x) => !x.status && nowMinutes >= (ROUTINE_TIMES[x.routine.time_of_day] ?? ROUTINE_TIMES.anytime))
    .map((x) => ({ key: `routine:${x.routine.id}:${today}`, routine: x.routine }))
    .filter((x) => !sent.includes(x.key));
}

/** Pure: is the weekly review reminder due? (Friday 17:00+, not yet reviewed, not yet sent.) */
export function weeklyReviewReminderDue({ today, dow, nowMinutes, weekStart, reviewed, sent = [] }) {
  const key = `review:${weekStart}`;
  const due = dow === 5 && nowMinutes >= 17 * 60 && !reviewed && !sent.includes(key);
  return due ? key : null;
}

function readSent() {
  try { return (JSON.parse(localStorage.getItem(SENT_KEY)) || []).filter((k) => typeof k === 'string').slice(-300); } catch { return []; }
}
function writeSent(list) {
  try { localStorage.setItem(SENT_KEY, JSON.stringify(list.slice(-300))); } catch { /* per device */ }
}

/**
 * @param {object} p
 * @param {() => Promise<{ today: string, dow: number, nowMinutes: number, todayList: Array, weekStart: string, reviewed: boolean }>} p.load
 * @param {(kind: 'routine'|'review', payload) => { title: string, body: string }} p.format
 */
export function startV4Reminders({ load, format }) {
  async function check() {
    const prefs = readReminderPrefs();
    if (!prefs.routines && !prefs.weeklyReview) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    let ctx;
    try { ctx = await load(); } catch { return; }
    const sent = readSent();
    const fire = (key, msg) => {
      sent.push(key);
      try {
        // eslint-disable-next-line no-new
        new Notification(msg.title, { body: msg.body, icon: '/icons/icon-192.png', tag: key });
      } catch { /* notifications unavailable */ }
    };
    if (prefs.routines) dueRoutineReminders(ctx.todayList, ctx.today, ctx.nowMinutes, sent).forEach((x) => fire(x.key, format('routine', x.routine)));
    if (prefs.weeklyReview) {
      const key = weeklyReviewReminderDue({ ...ctx, sent });
      if (key) fire(key, format('review', null));
    }
    writeSent(sent);
  }
  check();
  const timer = setInterval(check, POLL_MS);
  return () => clearInterval(timer);
}
