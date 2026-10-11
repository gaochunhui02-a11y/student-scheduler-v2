// Routines (V4-C), pure — no DOM, no Supabase.
//
// A routine repeats on a schedule and is ticked off per day:
//   daily        — every day
//   days         — chosen weekdays (0 = Sunday … 6 = Saturday)
//   weekly_count — N times a week, any days (weeks start on Monday)
// Completions are { completed_on, status: 'done' | 'skipped' }, at most one
// per day. Skipped = a planned day off: it neither counts nor breaks a
// streak. Today never breaks a streak — there is still time.
//
// Paused routines are not due. paused_at remembers the first paused day;
// on resume pausedDaysToSkip() lists the routine days in between, which the
// app records as 'skipped' — so a pause never breaks a streak.

import { addDays, dayOfWeek, startOfWeek, isValidDateStr, diffDays } from '../shared/dates.js';

export const FREQUENCIES = ['daily', 'days', 'weekly_count'];
export const TIMES_OF_DAY = ['anytime', 'morning', 'afternoon', 'evening'];
export const ROUTINE_LIMITS = { title: 120, notes: 2000, note: 500 };
const MAX_SCAN_DAYS = 800;

export function validateRoutineFields(input = {}, today) {
  const errors = {};
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) errors.title = 'routines.errTitle';
  else if (title.length > ROUTINE_LIMITS.title) errors.title = 'routines.errTitleLong';
  const frequency = FREQUENCIES.includes(input.frequency) ? input.frequency : 'daily';
  const days = [...new Set((Array.isArray(input.days_of_week) ? input.days_of_week : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
  if (frequency === 'days' && !days.length) errors.days_of_week = 'routines.errDays';
  let weekly = Math.round(Number(input.weekly_target));
  if (frequency === 'weekly_count' && (!Number.isFinite(weekly) || weekly < 1 || weekly > 7)) errors.weekly_target = 'routines.errWeekly';
  if (!Number.isFinite(weekly) || weekly < 1 || weekly > 7) weekly = 3;
  let duration = null;
  if (input.duration_minutes !== '' && input.duration_minutes !== null && input.duration_minutes !== undefined) {
    const n = Math.round(Number(input.duration_minutes));
    if (!Number.isFinite(n) || n < 1 || n > 1440) errors.duration_minutes = 'routines.errDuration';
    else duration = n;
  }
  const start = isValidDateStr(input.start_date) ? input.start_date : today;
  const end = isValidDateStr(input.end_date) ? input.end_date : null;
  if (end && end < start) errors.end_date = 'routines.errDates';
  return {
    ok: Object.keys(errors).length === 0,
    errors,
    fields: {
      title,
      notes: typeof input.notes === 'string' ? input.notes.slice(0, ROUTINE_LIMITS.notes) : '',
      frequency,
      days_of_week: frequency === 'days' ? days : [],
      weekly_target: weekly,
      time_of_day: TIMES_OF_DAY.includes(input.time_of_day) ? input.time_of_day : 'anytime',
      duration_minutes: duration,
      start_date: start,
      end_date: end,
      goal_id: input.goal_id || null,
      space_id: input.space_id || null,
    },
  };
}

/** Inside the routine's date range (ignores paused/archived). */
export function inRange(routine, date) {
  if (!routine || !isValidDateStr(date)) return false;
  if (routine.start_date && date < routine.start_date) return false;
  if (routine.end_date && date > routine.end_date) return false;
  return true;
}

/** Is `date` one of the routine's days? weekly_count: every day is eligible. */
export function scheduledOn(routine, date) {
  if (!inRange(routine, date)) return false;
  if (routine.frequency === 'days') return (routine.days_of_week || []).map(Number).includes(dayOfWeek(date));
  return true;
}

/** Map completed_on -> status for one routine. */
export function completionMap(completions = [], routineId = null) {
  const m = new Map();
  completions.forEach((c) => {
    if (routineId && c.routine_id !== routineId) return;
    m.set(c.completed_on, c.status === 'skipped' ? 'skipped' : 'done');
  });
  return m;
}

function weekCounts(routine, map, weekStart) {
  let done = 0;
  let skipped = 0;
  for (let i = 0; i < 7; i += 1) {
    const d = addDays(weekStart, i);
    const s = map.get(d);
    if (s === 'done') done += 1;
    else if (s === 'skipped') skipped += 1;
  }
  return { done, skipped };
}

/** Week result for weekly_count: met / excused (done + skipped ≥ target) / missed. */
function weekState(routine, map, weekStart) {
  const { done, skipped } = weekCounts(routine, map, weekStart);
  const target = routine.weekly_target || 1;
  if (done >= target) return 'met';
  if (done + skipped >= target) return 'excused';
  return 'missed';
}

/**
 * Current and best streak. Units are days (daily / days) or weeks
 * (weekly_count).
 * @returns {{ current: number, best: number, unit: 'day'|'week' }}
 */
export function computeStreak(routine, completions = [], today) {
  const map = completions instanceof Map ? completions : completionMap(completions, routine && routine.id);
  if (!routine || !routine.start_date || routine.start_date > today) return { current: 0, best: 0, unit: routine && routine.frequency === 'weekly_count' ? 'week' : 'day' };
  const last = routine.end_date && routine.end_date < today ? routine.end_date : today;
  if (routine.frequency === 'weekly_count') {
    const firstWeek = startOfWeek(routine.start_date);
    const thisWeek = startOfWeek(last);
    const weeks = [];
    for (let w = firstWeek; w <= thisWeek && weeks.length < 120; w = addDays(w, 7)) weeks.push(w);
    let best = 0;
    let run = 0;
    weeks.forEach((w) => {
      const s = weekState(routine, map, w);
      const open = w === thisWeek && last === today;
      if (s === 'met') { run += 1; best = Math.max(best, run); } else if (s === 'missed' && !open) run = 0;
    });
    return { current: run, best, unit: 'week' };
  }
  const span = Math.min(diffDays(routine.start_date, last), MAX_SCAN_DAYS);
  const from = addDays(last, -span);
  let best = 0;
  let run = 0;
  for (let i = 0; i <= span; i += 1) {
    const d = addDays(from, i);
    if (!scheduledOn(routine, d)) continue;
    const s = map.get(d);
    if (s === 'done') { run += 1; best = Math.max(best, run); } else if (s === 'skipped') continue;
    else if (d !== today) run = 0;
  }
  return { current: run, best, unit: 'day' };
}

/**
 * Completion rate over the last `days` days (default 30), today included
 * only once it is done. Skipped days are left out of the denominator.
 * weekly_count: Σ min(done, target) / Σ target over the weeks in the window
 * (the current week counts only what is already done, capped at target).
 * @returns {{ done: number, due: number, rate: number|null }}
 */
export function completionRate(routine, completions = [], today, days = 30) {
  const map = completions instanceof Map ? completions : completionMap(completions, routine && routine.id);
  if (!routine) return { done: 0, due: 0, rate: null };
  const from = addDays(today, -(days - 1));
  if (routine.frequency === 'weekly_count') {
    const target = routine.weekly_target || 1;
    let done = 0;
    let due = 0;
    const thisWeek = startOfWeek(today);
    for (let w = startOfWeek(from); w <= thisWeek; w = addDays(w, 7)) {
      // Only weeks fully inside the routine's range and the window count as due.
      const weekEnd = addDays(w, 6);
      const covered = w >= from && inRange(routine, w) && inRange(routine, weekEnd > today ? today : weekEnd);
      const c = weekCounts(routine, map, w);
      if (w === thisWeek) {
        done += Math.min(c.done, target);
        due += Math.min(c.done, target);
      } else if (covered) {
        const need = Math.max(0, target - c.skipped);
        done += Math.min(c.done, need);
        due += need;
      }
    }
    return { done, due, rate: due ? done / due : null };
  }
  let done = 0;
  let due = 0;
  for (let i = 0; i < days; i += 1) {
    const d = addDays(from, i);
    if (!scheduledOn(routine, d)) continue;
    const s = map.get(d);
    if (s === 'skipped') continue;
    if (s === 'done') { done += 1; due += 1; } else if (d !== today) due += 1;
  }
  return { done, due, rate: due ? done / due : null };
}

/**
 * Day-by-day states for a strip/heatmap ending today.
 * state: done | skipped | missed | open (today, not done) | off (not a
 * routine day) | before (outside the routine's range)
 */
export function recentDays(routine, completions = [], today, n = 7) {
  const map = completions instanceof Map ? completions : completionMap(completions, routine && routine.id);
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const date = addDays(today, -i);
    let state;
    const s = map.get(date);
    if (!inRange(routine, date)) state = s || 'before';
    else if (s) state = s;
    else if (routine.frequency === 'weekly_count') state = date === today ? 'open' : 'off';
    else if (!scheduledOn(routine, date)) state = 'off';
    else state = date === today ? 'open' : 'missed';
    out.push({ date, state });
  }
  return out;
}

/** weekly_count: { done, target } for the week containing `date`. */
export function weekProgress(routine, completions = [], date) {
  const map = completions instanceof Map ? completions : completionMap(completions, routine && routine.id);
  const c = weekCounts(routine, map, startOfWeek(date));
  return { done: c.done, target: routine.weekly_target || 1 };
}

/** Active = not paused, not archived, and `date` inside its range. */
export function isActiveOn(routine, date) {
  return Boolean(routine) && !routine.paused && !routine.archived && inRange(routine, date);
}

/**
 * Routines to show for a day (Routines page, Today, Home), in time-of-day
 * order. weekly_count routines show while the week's target isn't met yet,
 * or when they were already ticked that day.
 * @returns {Array<{ routine, status: 'done'|'skipped'|null, week?: {done,target} }>}
 */
export function routinesForDay(routines = [], completions = [], date) {
  const order = { morning: 0, anytime: 1, afternoon: 2, evening: 3 };
  return routines
    .filter((r) => isActiveOn(r, date) && scheduledOn(r, date))
    .map((r) => {
      const map = completionMap(completions, r.id);
      const status = map.get(date) || null;
      const item = { routine: r, status };
      if (r.frequency === 'weekly_count') {
        item.week = weekProgress(r, map, date);
        if (!status && item.week.done >= item.week.target) return null;
      }
      return item;
    })
    .filter(Boolean)
    .sort((a, b) => Number(Boolean(a.status)) - Number(Boolean(b.status))
      || (order[a.routine.time_of_day] ?? 1) - (order[b.routine.time_of_day] ?? 1)
      || (a.routine.sort_order || 0) - (b.routine.sort_order || 0)
      || String(a.routine.title).localeCompare(String(b.routine.title)));
}

/** Minutes of routines with a duration planned for a day (for capacity). */
export function routineMinutesOn(routines = [], completions = [], date) {
  return routinesForDay(routines, completions, date)
    .filter((x) => x.status !== 'skipped')
    .reduce((s, x) => s + (x.routine.duration_minutes || 0), 0);
}

/** List grouping on the Routines page. */
export function routineState(routine, today) {
  if (routine.archived) return 'archived';
  if (routine.paused) return 'paused';
  if (routine.end_date && routine.end_date < today) return 'ended';
  if (routine.start_date && routine.start_date > today) return 'upcoming';
  return 'active';
}

/** Next state after tapping the check: none -> done -> none (skip is separate). */
export function nextCompletion(current) {
  return current === 'done' ? null : 'done';
}

/**
 * Routine days from paused_at up to yesterday that have no completion yet —
 * recorded as 'skipped' on resume. Capped at 120 days.
 */
export function pausedDaysToSkip(routine, completions = [], today) {
  if (!routine || !routine.paused || !isValidDateStr(routine.paused_at) || routine.paused_at >= today) return [];
  const map = completions instanceof Map ? completions : completionMap(completions, routine.id);
  const out = [];
  const from = diffDays(routine.paused_at, today) > 120 ? addDays(today, -120) : routine.paused_at;
  for (let d = from; d < today; d = addDays(d, 1)) {
    if (scheduledOn(routine, d) && !map.has(d)) out.push(d);
  }
  return out;
}
