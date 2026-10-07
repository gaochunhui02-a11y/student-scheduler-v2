// V3 Insights aggregations, pure. Each function answers one student
// question with real data only, and says "not enough data" instead of
// inventing a pattern.

import { addDays, startOfWeek, dateRange } from '../shared/dates.js';
import { blockCompletedMinutes } from '../tasks/taskModel.js';

export const MIN_FOCUS_SESSIONS = 5;

/**
 * "Where does my study time go?" — completed study minutes per course in
 * [from, to], from study blocks (block date = its schedule's date).
 * @returns {Array<{courseId, minutes}>} sorted by minutes, plus a null-course bucket
 */
export function studyMinutesByCourse({ schedules, items, subjectCourse, from, to }) {
  const dateById = new Map(schedules.map((s) => [s.id, s.for_date]));
  const totals = new Map();
  items.filter((i) => i.item_type === 'study').forEach((i) => {
    const d = dateById.get(i.schedule_id);
    if (!d || d < from || d > to) return;
    const mins = blockCompletedMinutes(i);
    if (!mins) return;
    const course = subjectCourse.get(i.source_subject_id) || null;
    totals.set(course, (totals.get(course) || 0) + mins);
  });
  return [...totals.entries()].map(([courseId, minutes]) => ({ courseId, minutes })).sort((a, b) => b.minutes - a.minutes);
}

/**
 * "Am I keeping up?" — planned vs completed study per Monday-start week,
 * for the `weeks` weeks ending with the week containing `today`.
 */
export function weeklyCompletion({ schedules, items, today, weeks = 6 }) {
  const dateById = new Map(schedules.map((s) => [s.id, s.for_date]));
  const lastStart = startOfWeek(today);
  const starts = Array.from({ length: weeks }, (_, i) => addDays(lastStart, (i - weeks + 1) * 7));
  return starts.map((start) => {
    const end = addDays(start, 6);
    let planned = 0;
    let completed = 0;
    items.filter((i) => i.item_type === 'study').forEach((i) => {
      const d = dateById.get(i.schedule_id);
      if (!d || d < start || d > end) return;
      planned += Math.max(0, i.end_minutes - i.start_minutes);
      completed += blockCompletedMinutes(i);
    });
    return { start, end, planned, completed, rate: planned ? completed / planned : null, isCurrent: start === lastStart };
  });
}

function periodOf(date) {
  const h = date.getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

/**
 * "When do I focus best?" — focus sessions grouped by time of day, with
 * how much of the planned time was actually focused. Only answers once
 * MIN_FOCUS_SESSIONS sessions exist (and a period needs 3 of its own).
 */
export function focusByPeriod(sessions = [], { minSessions = MIN_FOCUS_SESSIONS } = {}) {
  const periods = { morning: [], afternoon: [], evening: [] };
  sessions.forEach((s) => {
    const started = new Date(s.started_at);
    if (Number.isNaN(started.getTime())) return;
    periods[periodOf(started)].push(s);
  });
  const rows = Object.entries(periods).map(([period, list]) => {
    const planned = list.reduce((sum, s) => sum + (Number(s.planned_minutes) || 0), 0);
    const actual = list.reduce((sum, s) => sum + (Number(s.actual_minutes) || 0), 0);
    const finished = list.filter((s) => s.outcome === 'completed').length;
    return { period, count: list.length, minutes: actual, followThrough: planned ? Math.min(1.5, actual / planned) : null, finishRate: list.length ? finished / list.length : null };
  });
  const enough = sessions.length >= minSessions;
  const eligible = rows.filter((r) => r.count >= 3 && r.followThrough !== null);
  const best = enough && eligible.length >= 2 ? eligible.slice().sort((a, b) => b.followThrough - a.followThrough || b.count - a.count)[0] : null;
  return { rows, enough, total: sessions.length, best: best ? best.period : null };
}

/** Recent focus sessions, newest first, for the history list. */
export function recentSessions(sessions = [], limit = 8) {
  return sessions.slice().sort((a, b) => String(b.started_at).localeCompare(String(a.started_at))).slice(0, limit);
}

/** Overdue open tasks, oldest due first. */
export function overdueTasks(groups = [], today, limit = 6) {
  return groups.filter((g) => !g.done && g.dueDate && g.dueDate < today).sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, limit);
}

export function daysInRange(from, to) {
  return dateRange(from, to).length;
}
