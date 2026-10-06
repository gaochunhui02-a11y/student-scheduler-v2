// Pure, DOM-free, Supabase-free logic for the Week View (V2-A). No network,
// no i18n (weekday/date labels are rendered by the UI layer via the existing
// getLocale()-aware formatting dashboard.js already uses for due dates —
// this module only ever deals in plain "YYYY-MM-DD" strings and numbers).
//
// Reuses addDaysToDateStr from dateUtils.js for every date calculation
// (deliberately not a second date-arithmetic implementation), and expects
// the same raw row shapes src/dashboard/data.js already returns
// (schedules: {id, for_date}; classes: {schedule_id, name, start_time,
// end_time}; schedule_items: {schedule_id, item_type, start_minutes,
// end_minutes}; study_subjects due-date rows: {id, name, due_date, priority}).

import { addDaysToDateStr } from '../dashboard/dateUtils.js';
import { resolveOccurrenceForDate } from '../dashboard/recurringClasses.js';
import { countBlockStatuses } from '../shared/statusModel.js';

const DAYS_PER_WEEK = 7;

// Monday of the week containing `dateStr` — Date#getDay() is 0 (Sun) through
// 6 (Sat); this project's Week View starts on Monday per the product spec
// ("Mon | Tue | Wed | Thu | Fri | Sat | Sun"), so Sunday needs the largest
// backward shift (-6) while every other day shifts back to the most recent
// Monday.
export function getWeekStart(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const dayOfWeek = d.getDay();
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  return addDaysToDateStr(dateStr, diffToMonday);
}

// The 7 date strings Mon..Sun for the week starting at `weekStartDateStr`
// (assumed to already be a Monday — callers that have an arbitrary date
// should pass it through getWeekStart first).
export function getWeekDates(weekStartDateStr) {
  const dates = [];
  for (let i = 0; i < DAYS_PER_WEEK; i++) dates.push(addDaysToDateStr(weekStartDateStr, i));
  return dates;
}

// Moves a week-start date by whole weeks — negative for previous, positive
// for next, 0 for the same week (never actually called with 0, but
// harmless: addDaysToDateStr(x, 0) === x).
export function shiftWeek(weekStartDateStr, deltaWeeks) {
  return addDaysToDateStr(weekStartDateStr, deltaWeeks * DAYS_PER_WEEK);
}

export function isCurrentWeek(weekStartDateStr, todayDateStr) {
  return getWeekStart(todayDateStr) === weekStartDateStr;
}

// A fixed, documented bar for "a lot of study in one day" — 4 hours.
// Deliberately NOT derived from any one day's actual scheduling capacity
// (computeDayCapacity in scheduler.js), which would require loading full
// day settings — wake/sleep/classes/meals/preferences — for all 7 days just
// to render an overview. A flat, explained threshold is honest about what
// it is: a simple heuristic, not a per-day capacity calculation.
export const OVERLOAD_THRESHOLD_MINUTES = 240;

export function isOverloadedDay(studyMinutes) {
  return Number.isFinite(studyMinutes) && studyMinutes > OVERLOAD_THRESHOLD_MINUTES;
}

function emptyDayShell(date) {
  return { date, classes: [], studyMinutes: 0, deadlines: [] };
}

// Builds one entry per date in `weekDates`, populated from already-fetched
// rows:
//   - schedules: this user's schedule rows whose for_date falls in the week
//     (gives the schedule_id -> date mapping classes/items are keyed by)
//   - classes: every class row across those schedule_ids
//   - items: every schedule_item row across those schedule_ids (only
//     item_type === 'study' contributes to studyMinutes)
//   - dueSubjects: study_subjects rows whose due_date falls in the week,
//     REGARDLESS of which schedule_id they were created under (a task's due
//     date is independent of the day it was typed in)
// Never mutates any input array. A date with no matching rows at all still
// gets a real entry (classes: [], studyMinutes: 0, deadlines: []), not an
// omission — so the UI never has to guess whether a day was "not loaded"
// vs. "genuinely empty."
//
// V2-E: recurring classes (V2-B) are never stored as `classes` rows — they
// are projected per date from `seriesList` + `exceptions` (optional; both
// default to none) with the same resolveOccurrenceForDate the Planner uses,
// including skipped/modified occurrences and dates with no schedule row.
export function aggregateWeekView({ weekDates, schedules, classes, items, dueSubjects, seriesList = [], exceptions = [] }) {
  const scheduleIdToDate = new Map((schedules || []).map((s) => [s.id, s.for_date]));
  const byDate = new Map((weekDates || []).map((d) => [d, emptyDayShell(d)]));

  (classes || []).forEach((c) => {
    const date = scheduleIdToDate.get(c.schedule_id);
    const day = byDate.get(date);
    if (day) day.classes.push({ name: c.name, start_time: c.start_time, end_time: c.end_time });
  });

  (items || []).forEach((item) => {
    if (item.item_type !== 'study') return;
    const date = scheduleIdToDate.get(item.schedule_id);
    const day = byDate.get(date);
    if (day) day.studyMinutes += Math.max(0, (item.end_minutes ?? 0) - (item.start_minutes ?? 0));
  });

  // One chip per task per day — per-day copies of the same task (same name,
  // same due date) are a single deadline (V2-G).
  (dueSubjects || []).forEach((s) => {
    const day = byDate.get(s.due_date);
    if (!day) return;
    const key = String(s.name || '').trim().toLowerCase();
    const existing = day.deadlines.find((d) => String(d.name || '').trim().toLowerCase() === key);
    const rank = { high: 3, medium: 2, low: 1 };
    if (existing) {
      if ((rank[s.priority] || 2) > (rank[existing.priority] || 2)) existing.priority = s.priority;
      return;
    }
    day.deadlines.push({ id: s.id, name: s.name, priority: s.priority || 'medium' });
  });

  (seriesList || []).forEach((series) => {
    byDate.forEach((day, date) => {
      const occurrence = resolveOccurrenceForDate(series, date, exceptions);
      if (occurrence) day.classes.push({ name: occurrence.name, start_time: occurrence.start_time, end_time: occurrence.end_time, recurring: true });
    });
  });

  byDate.forEach((day) => {
    day.classes.sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
    day.deadlines.sort((a, b) => a.name.localeCompare(b.name));
  });

  return (weekDates || []).map((d) => byDate.get(d));
}

// V2-G: per-day study-block status counts (statusModel.js), keyed by
// date — kept separate from aggregateWeekView so its day shape is
// unchanged. "In Progress" only applies to today's date.
export function computeDayStatusCounts({ weekDates, schedules, items, todayDateStr = null, nowMinutes = null }) {
  const dateById = new Map((schedules || []).map((s) => [s.id, s.for_date]));
  const blocksByDate = new Map((weekDates || []).map((d) => [d, []]));
  (items || []).forEach((item) => {
    const list = blocksByDate.get(dateById.get(item.schedule_id));
    if (list) list.push(item);
  });
  const out = new Map();
  blocksByDate.forEach((blocks, date) => {
    out.set(date, countBlockStatuses(blocks, { isToday: date === todayDateStr, nowMinutes }));
  });
  return out;
}

// Per-day workload-bar fractions (0..1), scaled against the week's own
// busiest day so the tallest bar in the UI is always full height — the same
// "relative to what actually happened" principle as this app's other
// visualizations (e.g. analyticsModel.js never invents an absolute scale
// for a chart either).
export function computeWeekWorkloadBars(weekDays) {
  const max = (weekDays || []).reduce((best, d) => Math.max(best, d.studyMinutes), 0);
  return (weekDays || []).map((d) => ({
    date: d.date,
    studyMinutes: d.studyMinutes,
    barFraction: max > 0 ? Math.min(1, d.studyMinutes / max) : 0,
    overloaded: isOverloadedDay(d.studyMinutes),
  }));
}

// Week-level totals for the "weekly workload summary" — busiestDate is
// null when every day has 0 study minutes (nothing to call "busiest").
export function computeWeekSummary(weekDays) {
  const list = weekDays || [];
  const totalStudyMinutes = list.reduce((sum, d) => sum + d.studyMinutes, 0);
  const totalClasses = list.reduce((sum, d) => sum + d.classes.length, 0);
  const totalDeadlines = list.reduce((sum, d) => sum + d.deadlines.length, 0);
  const busiest = list.reduce((best, d) => (!best || d.studyMinutes > best.studyMinutes ? d : best), null);
  return {
    totalStudyMinutes,
    totalClasses,
    totalDeadlines,
    busiestDate: busiest && busiest.studyMinutes > 0 ? busiest.date : null,
  };
}
