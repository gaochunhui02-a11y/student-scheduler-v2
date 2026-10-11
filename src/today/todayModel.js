// Today (V4-D), pure — no DOM, no Supabase.
//
// The Today page answers "what do I do today?" from the same task groups,
// calendar events and routines as everything else:
//   * planned today   — tasks SCHEDULED on today (taskDates.splitForDay)
//   * due today       — open tasks due today but planned elsewhere / nowhere
//   * overdue         — open tasks past their due date
//   * top three       — a deterministic, explained suggestion of what to do
//                       first (never stored; the student can ignore it)
// An unscheduled task is never a "today" task just because it is due today.

import { splitForDay, isOverdue, isScheduledOn } from '../tasks/taskDates.js';
import { todayStr } from '../shared/dates.js';

/** Local calendar day of an ISO timestamp (completed_at is stored in UTC). */
export function localDay(iso) {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? todayStr(d) : null;
}

const PRIORITY = { high: 0, medium: 1, low: 2 };

/**
 * @param {Array} groups task groups (taskModel)
 * @param {string} today
 * @param {{ blocked?: Map }} [opts] dependency state (blocked tasks are never suggested first)
 */
export function buildTodayLists(groups = [], today, { blocked = new Map() } = {}) {
  const { scheduled, dueOnly } = splitForDay(groups, today);
  const taken = new Set([...scheduled, ...dueOnly].map((g) => g.id));
  const overdue = groups.filter((g) => isOverdue(g, today) && !taken.has(g.id))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || String(a.name).localeCompare(String(b.name)));
  const doneToday = groups.filter((g) => g.done && (isScheduledOn(g, today) || localDay(g.completedAt) === today));
  const byStart = (a, b) => String(a.startTime || '99').localeCompare(String(b.startTime || '99'))
    || (PRIORITY[a.priority] ?? 1) - (PRIORITY[b.priority] ?? 1)
    || String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999'))
    || String(a.name).localeCompare(String(b.name));
  return {
    scheduled: scheduled.slice().sort(byStart),
    dueOnly: dueOnly.slice().sort(byStart),
    overdue,
    doneToday,
    top: pickTopThree({ scheduled, dueOnly, overdue }, today, blocked),
  };
}

/**
 * Up to three open tasks to do first, each with a reason:
 *   overdue (oldest first) → due today → high priority planned today →
 *   other planned today (earliest start time / due date).
 * Tasks blocked by an unfinished dependency are skipped.
 * @returns {Array<{ group, reason: 'overdue'|'dueToday'|'highPriority'|'planned' }>}
 */
export function pickTopThree({ scheduled = [], dueOnly = [], overdue = [] }, today, blocked = new Map()) {
  const seen = new Set();
  const out = [];
  const isBlocked = (g) => {
    const st = blocked.get && blocked.get(g.id);
    return Boolean(st && st.blocked);
  };
  const rank = (g) => {
    if (g.dueDate && g.dueDate < today) return 0;
    if (g.dueDate === today) return 1;
    if (g.priority === 'high') return 2;
    return 3;
  };
  const reasons = ['overdue', 'dueToday', 'highPriority', 'planned'];
  [...overdue, ...dueOnly, ...scheduled]
    .filter((g) => !g.done && !isBlocked(g))
    .sort((a, b) => rank(a) - rank(b)
      || String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999'))
      || (PRIORITY[a.priority] ?? 1) - (PRIORITY[b.priority] ?? 1)
      || String(a.startTime || '99').localeCompare(String(b.startTime || '99'))
      || String(a.name).localeCompare(String(b.name)))
    .forEach((g) => {
      if (out.length >= 3 || seen.has(g.id)) return;
      seen.add(g.id);
      out.push({ group: g, reason: reasons[rank(g)] });
    });
  return out;
}

/**
 * Today's timed events with a state relative to now.
 * @param {Array<{start:number,end:number}>} events
 * @returns {Array<object & { state: 'past'|'now'|'next'|'later' }>}
 */
export function timelineStates(events = [], nowMinutes) {
  const sorted = events.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  let nextMarked = false;
  return sorted.map((e) => {
    let state;
    if (e.end <= nowMinutes) state = 'past';
    else if (e.start <= nowMinutes) state = 'now';
    else if (!nextMarked) { state = 'next'; nextMarked = true; } else state = 'later';
    return { ...e, state };
  });
}

/**
 * Quick capture: "Read chapter 4 45m" → { name: 'Read chapter 4', minutes: 45 }.
 * Understands a trailing duration: 45m, 45 min, 1h, 1.5h, 1h30 / 1h30m.
 * Default 30 minutes; clamped to 5–1440.
 */
export function parseQuickTask(text, defaultMinutes = 30) {
  let s = String(text || '').trim().replace(/\s+/g, ' ');
  let minutes = defaultMinutes;
  const m = s.match(/(?:^|\s)(\d+(?:[.,]\d+)?)\s?(h|hr|hrs|hours?)\s?(\d{1,2})?\s?(m|min|mins)?$/i)
    || s.match(/(?:^|\s)(\d{1,4})\s?(m|min|mins|minutes?)$/i);
  if (m) {
    if (/^h/i.test(m[2])) {
      minutes = Math.round(Number(m[1].replace(',', '.')) * 60 + (m[3] ? Number(m[3]) : 0));
    } else minutes = Number(m[1]);
    s = s.slice(0, m.index).trim();
  }
  minutes = Math.max(5, Math.min(1440, Number.isFinite(minutes) ? minutes : defaultMinutes));
  return { name: s.slice(0, 200), minutes, ok: s.length > 0 };
}

/** Header numbers for the Today page. */
export function todaySummary(lists, events = [], today) {
  const studyEvents = events.filter((e) => e.kind === 'study');
  return {
    plannedTasks: lists.scheduled.length,
    dueToday: lists.dueOnly.length + lists.scheduled.filter((g) => g.dueDate === today).length,
    overdue: lists.overdue.length,
    doneToday: lists.doneToday.length,
    studyPlanned: studyEvents.reduce((s2, e) => s2 + (e.end - e.start), 0),
    studyDone: studyEvents.reduce((s2, e) => s2 + (e.completed ? e.end - e.start : 0), 0),
    classes: events.filter((e) => e.kind === 'class' || e.kind === 'external').length,
  };
}
