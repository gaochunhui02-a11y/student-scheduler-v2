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
import { computeRemainingMinutes } from '../dashboard/carryOverModel.js';

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
export function effectiveCompletedMinutes(item, duration) {
  if (item.completed) return duration;
  const partial = Number.isFinite(item.completed_minutes) ? item.completed_minutes : 0;
  return Math.min(Math.max(0, partial), duration);
}

// A block's actual time spent (V2-C), as opposed to its completion credit
// above. They differ only for a block completed with fewer logged minutes
// than planned — e.g. Focus Mode's Complete after 72 of 90 minutes stores
// completed = true, completed_minutes = 72: it counts as 90 completed (the
// work is done) but 72 actual. A block marked Done with no logged minutes
// has no timing data, so its actual is its full duration. Known limit: a
// block logged as partial and later marked Done via the plain Done button
// keeps its earlier partial number as its actual time.
export function effectiveActualMinutes(item, duration) {
  const logged = Number.isFinite(item.completed_minutes) ? Math.min(Math.max(0, item.completed_minutes), duration) : 0;
  if (logged > 0) return logged;
  return item.completed ? duration : 0;
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
// Today's block status (Home dashboard "Today" card, Phase 15 redesign)
// ---------------------------------------------------------------------------

// Which of today's already-generated schedule_items (if any) is happening
// right now, or — if none is — which one is coming up next, plus how many
// minutes of planned study are still ahead today. Deterministic and pure:
// takes today's raw schedule_items (start_minutes/end_minutes/item_type/
// completed, the same shape listScheduleItems() already returns) and the
// current wall-clock time in minutes-since-midnight, and returns plain data
// for the UI to render — never fetches, never guesses at a "recommended"
// task (that's Checkpoint E's deterministic scoring engine, a separate
// concern from "what does today's actual generated schedule say").
//
// "Current" prefers any item spanning `nowMinutes`, regardless of type
// (a class or meal counts as "what's happening now" just as much as a
// study block) — but "remaining planned study minutes" only ever counts
// study blocks, and only the portion of each that's still ahead of now and
// not yet completed, so a half-finished session correctly reports its
// remaining half, not its full duration.
export function computeTodayBlockStatus(items, nowMinutes) {
  const list = Array.isArray(items) ? items : [];
  const sorted = [...list]
    .filter((i) => Number.isFinite(i.start_minutes) && Number.isFinite(i.end_minutes) && i.end_minutes > i.start_minutes)
    .sort((a, b) => a.start_minutes - b.start_minutes);

  const current = sorted.find((i) => nowMinutes >= i.start_minutes && nowMinutes < i.end_minutes) || null;
  const next = !current ? sorted.find((i) => i.start_minutes > nowMinutes) || null : null;

  const remainingPlannedMinutes = sorted
    .filter((i) => i.item_type === 'study' && !i.completed && i.end_minutes > nowMinutes)
    .reduce((sum, i) => sum + (i.end_minutes - Math.max(i.start_minutes, nowMinutes)), 0);

  return { current, next, remainingPlannedMinutes: Math.max(0, remainingPlannedMinutes) };
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
// Estimated vs Planned vs Actual (V2-C)
// ---------------------------------------------------------------------------

// Per subject name over the same window as computeSubjectTotals:
//   estimated — what the student asked for (study_subjects.minutes_requested)
//   planned   — what the scheduler actually placed (study block durations)
//   actual    — time actually spent (effectiveActualMinutes)
// Estimated and planned differ when a day ran out of room; planned and
// actual differ when sessions ran short or were skipped. Subjects with
// nothing estimated or planned are omitted. Sorted by planned, largest
// first, with window totals alongside.
export function computeActualVsPlanned(studySubjects, items) {
  const nameById = new Map((studySubjects || []).map((s) => [s.id, s.name]));
  const rows = new Map();

  function entryFor(name) {
    let entry = rows.get(name);
    if (!entry) {
      entry = { subject: name, estimated: 0, planned: 0, actual: 0 };
      rows.set(name, entry);
    }
    return entry;
  }

  (studySubjects || []).forEach((s) => {
    if (!s.name) return;
    entryFor(s.name).estimated += Number.isFinite(s.minutes_requested) ? s.minutes_requested : 0;
  });

  (items || []).forEach((item) => {
    if (item.item_type !== 'study' || !item.source_subject_id) return;
    const name = nameById.get(item.source_subject_id);
    if (!name) return;
    const duration = Math.max(0, item.end_minutes - item.start_minutes);
    entryFor(name).planned += duration;
    entryFor(name).actual += effectiveActualMinutes(item, duration);
  });

  const subjects = Array.from(rows.values())
    .filter((r) => r.estimated > 0 || r.planned > 0)
    .sort((a, b) => b.planned - a.planned);
  const totals = subjects.reduce(
    (acc, r) => ({ estimated: acc.estimated + r.estimated, planned: acc.planned + r.planned, actual: acc.actual + r.actual }),
    { estimated: 0, planned: 0, actual: 0 }
  );
  return { subjects, totals };
}

// ---------------------------------------------------------------------------
// Insights metrics (V2-E). Every number below is computed from stored rows
// only, and each returns insufficientData instead of a confident number
// when there's too little to say anything honest — the same convention
// computeProductivityPeriod already follows.
// ---------------------------------------------------------------------------

// Average length of the study blocks the scheduler actually placed.
export function computeAverageBlockLength(items, { minBlocks = 3 } = {}) {
  const durations = (items || [])
    .filter((i) => i && i.item_type === 'study')
    .map((i) => Math.max(0, i.end_minutes - i.start_minutes))
    .filter((d) => d > 0);
  if (durations.length < minBlocks) return { averageMinutes: null, blockCount: durations.length, insufficientData: true };
  const total = durations.reduce((s, d) => s + d, 0);
  return { averageMinutes: Math.round(total / durations.length), blockCount: durations.length, insufficientData: false };
}

// How the time actually spent on FINISHED tasks compares to what was
// estimated for them. A task (one study_subjects row) counts as finished
// when it has study blocks, every block is completed, and the blocks cover
// its whole estimate (a task whose day ran out of room isn't "finished" just
// because its smaller scheduled part was done). ratioPercent = actual /
// estimated: under 100 means finished in less time than estimated. Actual
// is capped at each block's own length, so a real overrun beyond the
// scheduled time can't show up here — the reading is "you used X% of your
// estimates on finished work", never a claim about time spent off-plan.
export function computeEstimateAccuracy(studySubjects, items, { minTasks = 3 } = {}) {
  const blocksBySubject = new Map();
  (items || []).forEach((i) => {
    if (!i || i.item_type !== 'study' || !i.source_subject_id) return;
    const list = blocksBySubject.get(i.source_subject_id) || [];
    list.push(i);
    blocksBySubject.set(i.source_subject_id, list);
  });

  let estimated = 0;
  let actual = 0;
  let taskCount = 0;
  (studySubjects || []).forEach((s) => {
    const est = Number.isFinite(s.minutes_requested) ? s.minutes_requested : 0;
    if (est <= 0) return;
    const blocks = blocksBySubject.get(s.id) || [];
    if (blocks.length === 0 || !blocks.every((b) => b.completed)) return;
    const planned = blocks.reduce((sum, b) => sum + Math.max(0, b.end_minutes - b.start_minutes), 0);
    if (planned < est) return;
    estimated += est;
    actual += blocks.reduce((sum, b) => sum + effectiveActualMinutes(b, Math.max(0, b.end_minutes - b.start_minutes)), 0);
    taskCount += 1;
  });

  if (taskCount < minTasks || estimated <= 0) {
    return { ratioPercent: null, taskCount, estimatedMinutes: estimated, actualMinutes: actual, insufficientData: true };
  }
  return {
    ratioPercent: Math.round((actual / estimated) * 100),
    taskCount,
    estimatedMinutes: estimated,
    actualMinutes: actual,
    insufficientData: false,
  };
}

// Work that's past its due date and still unfinished. `studySubjects` is
// expected to be rows already filtered to due_date < today by the caller's
// query, but this re-checks so it's safe either way. Remaining minutes use
// carryOverModel's own rule (completed/partial/carried-over aware); a task
// with no blocks at all is fully remaining.
export function computeOverdueWorkload(studySubjects, items, todayDateStr, limit = 5) {
  const blocksBySubject = new Map();
  (items || []).forEach((i) => {
    if (!i || i.item_type !== 'study' || !i.source_subject_id) return;
    const list = blocksBySubject.get(i.source_subject_id) || [];
    list.push(i);
    blocksBySubject.set(i.source_subject_id, list);
  });

  const overdue = (studySubjects || [])
    .filter((s) => s && s.due_date && todayDateStr && s.due_date < todayDateStr)
    .map((s) => {
      const blocks = blocksBySubject.get(s.id) || [];
      const requested = Number.isFinite(s.minutes_requested) ? s.minutes_requested : 0;
      const remainingMinutes = blocks.length === 0
        ? requested
        : blocks.reduce((sum, b) => sum + computeRemainingMinutes({
          start: b.start_minutes,
          end: b.end_minutes,
          completed: b.completed,
          completedMinutes: b.completed_minutes,
          carriedOverMinutes: b.carried_over_minutes,
        }), 0);
      return { id: s.id, title: s.name, dueDate: s.due_date, daysOverdue: daysBetween(s.due_date, todayDateStr), remainingMinutes };
    })
    .filter((o) => o.remainingMinutes > 0)
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));

  return {
    count: overdue.length,
    totalMinutes: overdue.reduce((sum, o) => sum + o.remainingMinutes, 0),
    items: overdue.slice(0, limit),
  };
}

// Bar widths (0..100) for the subject workload chart, scaled to the
// biggest subject so the longest bar is full width — the same "relative to
// what actually happened" scale Week View's workload bars use.
export function computeSubjectWorkloadBars(subjectTotals) {
  const max = (subjectTotals || []).reduce((m, s) => Math.max(m, s.planned || 0), 0);
  return (subjectTotals || []).map((s) => ({
    ...s,
    plannedPercent: max > 0 ? Math.round(((s.planned || 0) / max) * 100) : 0,
    completedPercent: max > 0 ? Math.round((Math.min(s.completed || 0, s.planned || 0) / max) * 100) : 0,
  }));
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
