// Weekly review + planned vs actual (V4-F), pure — no DOM, no Supabase.
// Every number comes from data the app already has; when there's nothing
// to compare the functions say so (rate = null) instead of inventing one.
//
//   planned   minutes of study blocks generated for the day
//   done      minutes of those blocks completed (partial counts)
//   focus     minutes actually focused in focus sessions started that day
// A week runs Monday → Sunday (the app's weeks start on Monday).

import { addDays, dateRange, startOfWeek, todayStr } from '../shared/dates.js';
import { blockCompletedMinutes } from '../tasks/taskModel.js';

const localDay = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? todayStr(d) : null;
};

export function weekBounds(date) {
  const start = startOfWeek(date);
  return { start, end: addDays(start, 6) };
}

/**
 * Per-day planned / done / focus minutes in [from, to].
 * @returns {{ days: Array<{date, planned, done, focus, rate}>, planned, done, focus, rate }}
 */
export function plannedVsActual({ schedules = [], items = [], sessions = [], from, to }) {
  const dates = dateRange(from, to);
  const byDate = new Map(dates.map((d) => [d, { date: d, planned: 0, done: 0, focus: 0 }]));
  const dateById = new Map(schedules.map((s) => [s.id, s.for_date]));
  items.filter((i) => i.item_type === 'study').forEach((i) => {
    const day = byDate.get(dateById.get(i.schedule_id));
    if (!day) return;
    day.planned += Math.max(0, (i.end_minutes || 0) - (i.start_minutes || 0));
    day.done += blockCompletedMinutes(i);
  });
  sessions.forEach((s) => {
    const day = byDate.get(localDay(s.started_at));
    if (day) day.focus += Math.max(0, Number(s.actual_minutes) || 0);
  });
  const days = dates.map((d) => {
    const x = byDate.get(d);
    return { ...x, rate: x.planned ? x.done / x.planned : null };
  });
  const planned = days.reduce((s, d) => s + d.planned, 0);
  const done = days.reduce((s, d) => s + d.done, 0);
  const focus = days.reduce((s, d) => s + d.focus, 0);
  return { days, planned, done, focus, rate: planned ? done / planned : null };
}

/**
 * Planned vs done by area for the period. `keyOf(subjectId)` maps a study
 * block's task to an area key (course id, project id, …) or null.
 * @returns {Array<{ key, planned, done, rate }>} biggest planned first
 */
export function plannedVsActualBy({ schedules = [], items = [], from, to, keyOf }) {
  const dateById = new Map(schedules.map((s) => [s.id, s.for_date]));
  const totals = new Map();
  items.filter((i) => i.item_type === 'study').forEach((i) => {
    const d = dateById.get(i.schedule_id);
    if (!d || d < from || d > to) return;
    const key = keyOf(i.source_subject_id) ?? null;
    const x = totals.get(key) || { key, planned: 0, done: 0 };
    x.planned += Math.max(0, (i.end_minutes || 0) - (i.start_minutes || 0));
    x.done += blockCompletedMinutes(i);
    totals.set(key, x);
  });
  return [...totals.values()].map((x) => ({ ...x, rate: x.planned ? x.done / x.planned : null }))
    .sort((a, b) => b.planned - a.planned || String(a.key).localeCompare(String(b.key)));
}

/**
 * What happened to tasks in the week.
 *   completed — marked done during the week (completed_at in the week)
 *   slipped   — due in the week (up to `today`) and still open
 * @returns {{ completed: Array, slipped: Array }}
 */
export function weekTasks(groups = [], start, end, today) {
  const last = end < today ? end : addDays(today, -1);
  const completed = groups.filter((g) => {
    const d = localDay(g.completedAt);
    return g.done && d && d >= start && d <= end;
  }).sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)));
  const slipped = groups.filter((g) => !g.done && g.dueDate && g.dueDate >= start && g.dueDate <= last)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || String(a.name).localeCompare(String(b.name)));
  return { completed, slipped };
}

/** Milestones (project or goal) completed during the week. */
export function weekMilestones(milestones = [], start, end) {
  return milestones.filter((m) => {
    const d = m.status === 'done' ? localDay(m.completed_at) : null;
    return d && d >= start && d <= end;
  });
}

/**
 * Goal movement in the week from check-ins: per goal, the number of
 * check-ins and the change in value (sum aggregate) or the latest value.
 */
export function weekGoalCheckIns(goals = [], logs = [], start, end) {
  return goals.map((g) => {
    const inWeek = logs.filter((l) => l.goal_id === g.id && l.logged_on >= start && l.logged_on <= end);
    if (!inWeek.length) return null;
    const sorted = inWeek.slice().sort((a, b) => String(a.logged_on).localeCompare(String(b.logged_on)) || String(a.created_at || '').localeCompare(String(b.created_at || '')));
    const change = g.aggregate === 'latest' ? null : inWeek.reduce((s, l) => s + Number(l.value || 0), 0);
    return { goal: g, count: inWeek.length, change, latest: Number(sorted.at(-1).value) };
  }).filter(Boolean);
}

// ---------------- reflections (profiles.preferences.reviews) ----------------

export const REVIEW_FIELDS = ['well', 'blocked', 'focus'];
export const REVIEW_LIMIT = 1000;
export const REVIEW_KEEP = 26;
const WEEK = /^\d{4}-\d{2}-\d{2}$/;

/** Cleans the stored reviews: { 'YYYY-MM-DD' (Monday): { well, blocked, focus, doneAt } }, newest 26 kept. */
export function normalizeReviews(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const entries = Object.entries(src)
    .filter(([week, v]) => WEEK.test(week) && v && typeof v === 'object' && !Array.isArray(v))
    .map(([week, v]) => {
      const clean = {};
      REVIEW_FIELDS.forEach((f) => { clean[f] = typeof v[f] === 'string' ? v[f].slice(0, REVIEW_LIMIT) : ''; });
      clean.doneAt = typeof v.doneAt === 'string' && !Number.isNaN(Date.parse(v.doneAt)) ? v.doneAt : null;
      return [week, clean];
    })
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, REVIEW_KEEP);
  return Object.fromEntries(entries);
}

export function withReview(reviews, week, fields, doneAt = null) {
  const next = { ...normalizeReviews(reviews) };
  const prev = next[week] || {};
  const entry = {};
  REVIEW_FIELDS.forEach((f) => { entry[f] = typeof fields[f] === 'string' ? fields[f].slice(0, REVIEW_LIMIT) : (prev[f] || ''); });
  entry.doneAt = prev.doneAt || doneAt || null; // the first "reviewed" time is kept
  next[week] = entry;
  return normalizeReviews(next);
}

/** Is a review "due"? From Friday on, for the current week, until it's marked done. */
export function reviewDue(reviews, today) {
  const { start } = weekBounds(today);
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const r = normalizeReviews(reviews)[start];
  return (dow === 5 || dow === 6 || dow === 0) && !(r && r.doneAt);
}
