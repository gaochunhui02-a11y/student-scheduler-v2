// Pure, DOM-free, Supabase-free aggregation logic for the Dashboard +
// Analytics view (Phase 10). Mirrors src/dashboard/summary.js's philosophy
// exactly: everything here is computed from the actual rows the existing
// data layer already returns — no new table, no duplicated analytics
// store, and nothing here talks to Supabase or the DOM. src/analytics/
// analytics.js is the only thing that fetches data (via the existing
// src/dashboard/data.js + src/board/boardData.js functions) and renders it.
//
// No AI is used anywhere in this file — every calculation (weekly totals,
// completion rate, subject totals, deadline risk, productivity period) is
// deterministic and testable with plain input/output pairs.

import { addDaysToDateStr } from '../dashboard/dateUtils.js';

const RISK_LEVELS = ['on_track', 'needs_attention', 'at_risk'];

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

// The last `n` date strings ending on (and including) `todayDateStr`,
// oldest first — e.g. lastNDates('2026-09-18', 7) starts 2026-09-12.
export function lastNDates(todayDateStr, n = 7) {
  const dates = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    dates.push(addDaysToDateStr(todayDateStr, -i));
  }
  return dates;
}

function toUtcMillis(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

// Whole days from `fromDateStr` to `toDateStr` (positive = toDateStr is
// later). Computed via Date.UTC rather than local-time Date arithmetic so a
// user's timezone/DST offset can never shift the result by a day.
export function daysBetween(fromDateStr, toDateStr) {
  return Math.round((toUtcMillis(toDateStr) - toUtcMillis(fromDateStr)) / 86400000);
}

// ---------------------------------------------------------------------------
// Weekly planned vs completed
// ---------------------------------------------------------------------------

// schedule_items don't carry their own date (only schedule_id) — this joins
// them against the schedules list (id -> for_date) so computeWeeklyTotals
// can group by day. Items whose schedule_id isn't in `schedules` (shouldn't
// happen, but a defensive no-op rather than a crash) are dropped.
export function attachDatesToItems(items, schedules) {
  const dateById = new Map((schedules || []).map((s) => [s.id, s.for_date]));
  return (items || [])
    .map((item) => ({ ...item, date: dateById.get(item.schedule_id) }))
    .filter((item) => item.date);
}

// A block's actually-completed minutes for reporting purposes (Phase 14):
// the full duration once `completed` is true (unchanged from before this
// existed — a block without a completed_minutes column at all, or one
// whose completed_minutes never got backfilled, still reports correctly),
// otherwise whatever partial completed_minutes was logged, clamped to the
// block's own duration and defaulting to 0 for a block never touched by
// Partial Completion — the exact same 0 the old "only if completed" gate
// produced, so this is a strict accuracy improvement, never a regression.
function effectiveCompletedMinutes(item, duration) {
  if (item.completed) return duration;
  const partial = Number.isFinite(item.completed_minutes) ? item.completed_minutes : 0;
  return Math.min(Math.max(0, partial), duration);
}

// A block's still-missing minutes that the student explicitly flagged
// Missed (Phase 14) — 0 for anything not flagged missed, and 0 once its
// completed minutes already cover the full duration (a block can't be
// simultaneously "fully done" and "missing time" for reporting purposes).
function missedMinutes(item, duration, completedMinutes) {
  if (!item.missed) return 0;
  return Math.max(0, duration - completedMinutes);
}

// Planned = every study block's duration, regardless of completion.
// Completed = the study blocks' actually-completed minutes — full duration
// when `completed` is true, or the logged partial amount otherwise (Phase
// 14; see effectiveCompletedMinutes). Missed = minutes explicitly flagged
// Missed that are still outstanding (Phase 14; additive — never subtracted
// from planned/completed, purely an extra lens on the same blocks). All
// three are summed per day (over the given `dates`, oldest first) and as a
// weekly total. Uses item_type/start_minutes/end_minutes/completed/
// completed_minutes/missed — the raw schedule_items column names — since
// this reads directly from listScheduleItemsForScheduleIds, not through
// dashboard.js's camelCase in-memory shape.
export function computeWeeklyTotals(items, dates) {
  const byDay = (dates || []).map((date) => ({ date, planned: 0, completed: 0, missed: 0 }));
  const indexByDate = new Map(byDay.map((d, i) => [d.date, i]));

  (items || []).forEach((item) => {
    if (item.item_type !== 'study') return;
    const index = indexByDate.get(item.date);
    if (index === undefined) return;
    const duration = Math.max(0, item.end_minutes - item.start_minutes);
    const completedMinutes = effectiveCompletedMinutes(item, duration);
    byDay[index].planned += duration;
    byDay[index].completed += completedMinutes;
    byDay[index].missed += missedMinutes(item, duration, completedMinutes);
  });

  const totalPlanned = byDay.reduce((sum, d) => sum + d.planned, 0);
  const totalCompleted = byDay.reduce((sum, d) => sum + d.completed, 0);
  const totalMissed = byDay.reduce((sum, d) => sum + d.missed, 0);
  return { byDay, totalPlanned, totalCompleted, totalMissed };
}

// A percentage 0-100, rounded. null (not 0) when nothing was planned at
// all — "no data" is different from "planned everything and finished
// none of it."
export function computeCompletionRate(totalPlanned, totalCompleted) {
  if (!Number.isFinite(totalPlanned) || totalPlanned <= 0) return null;
  const safeCompleted = Number.isFinite(totalCompleted) ? Math.max(0, totalCompleted) : 0;
  return Math.round((Math.min(safeCompleted, totalPlanned) / totalPlanned) * 100);
}

// ---------------------------------------------------------------------------
// Subject breakdown
// ---------------------------------------------------------------------------

// Aggregates by subject NAME (study_subjects rows are per-day, so the same
// subject typically has a different row/id each day) — planned is the sum
// of minutes_requested across every matching row in the window, completed
// is the sum of actually-completed minutes (full duration when `completed`
// is true, or the logged partial amount otherwise — Phase 14) attributed to
// any of that subject's rows via source_subject_id, and missed is the sum
// of minutes explicitly flagged Missed that are still outstanding (Phase
// 14; additive — never subtracted from planned/completed). Sorted by
// planned, largest first.
export function computeSubjectTotals(studySubjects, items) {
  const nameById = new Map((studySubjects || []).map((s) => [s.id, s.name]));
  const totals = new Map();

  function entryFor(name) {
    let entry = totals.get(name);
    if (!entry) {
      entry = { subject: name, planned: 0, completed: 0, missed: 0 };
      totals.set(name, entry);
    }
    return entry;
  }

  (studySubjects || []).forEach((s) => {
    if (!s.name) return;
    entryFor(s.name).planned += Number.isFinite(s.minutes_requested) ? s.minutes_requested : 0;
  });

  (items || []).forEach((item) => {
    if (item.item_type !== 'study' || !item.source_subject_id) return;
    const name = nameById.get(item.source_subject_id);
    if (!name) return;
    const duration = Math.max(0, item.end_minutes - item.start_minutes);
    const completedMinutes = effectiveCompletedMinutes(item, duration);
    entryFor(name).completed += completedMinutes;
    entryFor(name).missed += missedMinutes(item, duration, completedMinutes);
  });

  return Array.from(totals.values()).sort((a, b) => b.planned - a.planned);
}

// ---------------------------------------------------------------------------
// Deadline risk (deterministic — no AI)
// ---------------------------------------------------------------------------

// Note on `remainingMinutes`: study_subjects has no "done" flag of its own
// (completion lives on schedule_items, one specific day's generated
// blocks) and a subject with a due date can span schedules from many
// different dates, so this deliberately does not attempt to reconstruct
// exact partial-completion across every one of a subject's historical
// blocks. `remainingMinutes` is the subject's minutes_requested, treated as
// the full remaining estimate — documented simplification, not a bug.
//
// Formula (simple and transparent by design):
//   - no due date, or nothing left to do -> on_track (nothing to risk-assess)
//   - due date already passed with time still owed -> at_risk
//   - due today with a meaningful amount left -> at_risk
//   - otherwise, spread the remaining minutes evenly over the days left:
//       > 120 min/day needed -> at_risk
//       > 60 min/day needed, OR high priority with <= 2 days left -> needs_attention
//       else -> on_track
export function classifyDeadlineRisk({ dueDate, remainingMinutes, priority } = {}, today) {
  if (!dueDate) return 'on_track';
  const remaining = Number.isFinite(remainingMinutes) && remainingMinutes > 0 ? remainingMinutes : 0;
  if (remaining === 0) return 'on_track';

  const daysRemaining = daysBetween(today, dueDate);
  if (daysRemaining < 0) return 'at_risk';
  if (daysRemaining === 0 && remaining > 30) return 'at_risk';

  const effectiveDays = Math.max(1, daysRemaining);
  const requiredMinutesPerDay = remaining / effectiveDays;

  if (requiredMinutesPerDay > 120) return 'at_risk';
  if (requiredMinutesPerDay > 60 || (priority === 'high' && daysRemaining <= 2)) return 'needs_attention';
  return 'on_track';
}

export function isValidRiskLevel(value) {
  return RISK_LEVELS.includes(value);
}

// Enriches, sorts (soonest due date first), and caps the upcoming-deadline
// study subjects — the data behind both the "Upcoming Deadlines" count card
// and the Upcoming list. Subjects without a due date are excluded (nothing
// to sort/risk-assess by definition).
export function computeUpcomingDeadlines(studySubjects, today, limit = 10) {
  return (studySubjects || [])
    .filter((s) => s.due_date)
    .map((s) => {
      const remainingMinutes = Number.isFinite(s.minutes_requested) ? s.minutes_requested : 0;
      const daysRemaining = daysBetween(today, s.due_date);
      return {
        id: s.id,
        title: s.name,
        dueDate: s.due_date,
        priority: s.priority || 'medium',
        remainingMinutes,
        daysRemaining,
        risk: classifyDeadlineRisk({ dueDate: s.due_date, remainingMinutes, priority: s.priority }, today),
      };
    })
    // YYYY-MM-DD strings sort correctly lexicographically — soonest first.
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0))
    .slice(0, limit);
}

export function countByRisk(upcomingDeadlines, riskLevel) {
  return (upcomingDeadlines || []).filter((item) => item.risk === riskLevel).length;
}

// ---------------------------------------------------------------------------
// Productivity period
// ---------------------------------------------------------------------------

// Absolute schedule_items minutes can exceed 1440 for a block past midnight
// (the scheduler's own overnight-day convention — see scheduler.js) — %1440
// on the block's midpoint maps it back to an ordinary time-of-day before
// bucketing, so an 11:30 PM-12:15 AM block is still counted once, near
// midnight, not thrown out or double-counted.
function periodForMinuteOfDay(minuteOfDay) {
  if (minuteOfDay >= 5 * 60 && minuteOfDay < 12 * 60) return 'morning';
  if (minuteOfDay >= 12 * 60 && minuteOfDay < 17 * 60) return 'afternoon';
  if (minuteOfDay >= 17 * 60 && minuteOfDay < 21 * 60) return 'evening';
  return 'night';
}

export const PRODUCTIVITY_PERIODS = ['morning', 'afternoon', 'evening', 'night'];

// Buckets completed study blocks (camelCase {start,end,completed,type} shape
// — see attachDatesToItems/the caller for where that mapping happens) by
// time of day and returns whichever bucket has the most completed minutes.
// Deliberately refuses to guess from too little history: below
// minSessions completed blocks OR minTotalMinutes total minutes, it
// reports insufficientData instead of a single/few-datapoint "pattern."
export function computeProductivityPeriod(completedStudyItems, { minSessions = 3, minTotalMinutes = 60 } = {}) {
  const items = completedStudyItems || [];
  if (items.length < minSessions) {
    return { period: null, insufficientData: true, minutesByPeriod: null };
  }

  const minutesByPeriod = { morning: 0, afternoon: 0, evening: 0, night: 0 };
  let totalMinutes = 0;
  items.forEach((item) => {
    const duration = Math.max(0, item.end - item.start);
    totalMinutes += duration;
    const midpoint = ((item.start + item.end) / 2) % 1440;
    minutesByPeriod[periodForMinuteOfDay(midpoint)] += duration;
  });

  if (totalMinutes < minTotalMinutes) {
    return { period: null, insufficientData: true, minutesByPeriod };
  }

  const strongest = PRODUCTIVITY_PERIODS.reduce((best, key) => (minutesByPeriod[key] > minutesByPeriod[best] ? key : best), PRODUCTIVITY_PERIODS[0]);
  if (minutesByPeriod[strongest] === 0) {
    return { period: null, insufficientData: true, minutesByPeriod };
  }
  return { period: strongest, insufficientData: false, minutesByPeriod };
}

// ---------------------------------------------------------------------------
// Board summary (secondary/optional)
// ---------------------------------------------------------------------------

// listBoards (boardData.js) already orders by updated_at descending, so the
// first entry is the most recently updated board.
export function summarizeBoards(boards) {
  const list = boards || [];
  return { count: list.length, mostRecentTitle: list.length > 0 ? list[0].title : null };
}

// ---------------------------------------------------------------------------
// AI Advisor integration (Phase 10 -> Phase 9 bridge)
// ---------------------------------------------------------------------------

// Composes a starting draft for "Ask AI Advisor" on an at-risk task — the
// user still reviews/edits it in the Advisor's input before sending
// anything (see src/advisor/advisor.js's prefillAndFocus), this never
// sends a message itself. Deliberately takes its fixed phrases as
// `labels` rather than importing i18n directly, so this stays a plain,
// DOM/i18n-free pure function the UI layer supplies translated text to.
export function buildAdvisorPromptForTask(task, labels = {}) {
  if (!task || !task.title) return '';
  const help = labels.help || 'Help me with';
  const due = labels.due || 'due';
  const riskNote = labels.riskNote || "It looks at risk — what should I prioritize?";
  const bits = [`${help} "${task.title}"`];
  if (task.dueDate) bits.push(`${due} ${task.dueDate}`);
  bits.push(riskNote);
  return bits.join(', ');
}
