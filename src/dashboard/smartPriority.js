// Checkpoint E — deterministic Smart Priority engine. No AI, no network, no
// DOM, no Supabase: every function here is a pure transformation of plain
// data the app already has (study_subjects rows + today's schedule_items),
// reusing carryOverModel.js's existing remaining-minutes math rather than
// re-deriving it. Two independent things live here, both built from the
// same underlying task shape so Home, the Planner's Study Tasks sort, and
// any future Insights section never disagree about what "urgent" means:
//
//   1. A transparent weighted SCORE (+ explanation reasons) for "what should
//      I work on next" — rankTasks()/computeTaskScore().
//   2. Plain deterministic SORTS (due date / priority / remaining time) for
//      the Study Tasks list — sortTasksForDisplay().
//
// The canonical "task" shape every function below expects (camelCase, the
// same convention dashboard.js already uses for schedule_items in memory):
//   { id, name, priority, dueDate, minutesRequested, remainingMinutes,
//     scheduledMinutes, carriedOverMinutes, missed, completed, hasSchedule }
// buildSmartTasks() is how a caller turns its own raw study_subjects rows +
// schedule_items into that shape; it is the only function here that knows
// about the study_subjects/schedule_items split.

import { computeRemainingMinutes } from './carryOverModel.js';

// ---------------------------------------------------------------------------
// Building the task shape
// ---------------------------------------------------------------------------

function subjectKey(id, name) {
  return id != null ? `id:${id}` : `name:${name}`;
}

// `subjects`: [{ id, name, priority, dueDate, minutesRequested }] — one
// row per study_subjects entry for the day in question.
// `scheduleItems`: [{ type, start, end, completed, completedMinutes,
//   carriedOverMinutes, missed, sourceSubjectId, name }] — that same day's
// generated schedule_items, camelCase, exactly the shape carryOverModel.js's
// computeRemainingMinutes already expects.
//
// A subject with no matching schedule_items yet (never generated/regenerated
// since it was added) is treated as fully remaining, not started, not
// missed, not carried over — the honest default for "nothing has happened
// to this task yet." A subject matched to more than one block (the
// scheduler split it across a session-cap boundary) is aggregated across
// all of them, exactly like summary.js's computeSubjectProgress does for
// its own "is this subject done" rollup.
export function buildSmartTasks(subjects, scheduleItems) {
  const byKey = new Map();
  (scheduleItems || [])
    .filter((e) => e && e.type === 'study')
    .forEach((e) => {
      const key = subjectKey(e.sourceSubjectId, e.name);
      const list = byKey.get(key) || [];
      list.push(e);
      byKey.set(key, list);
    });

  return (subjects || [])
    .filter((s) => s && s.name && Number.isFinite(s.minutesRequested) && s.minutesRequested > 0)
    .map((s) => {
      const blocks = byKey.get(subjectKey(s.id, s.name)) || [];
      let remainingMinutes = s.minutesRequested;
      let scheduledMinutes = 0;
      let carriedOverMinutes = 0;
      let missed = false;

      if (blocks.length > 0) {
        remainingMinutes = 0;
        blocks.forEach((b) => {
          const duration = Math.max(0, (b.end ?? 0) - (b.start ?? 0));
          scheduledMinutes += duration;
          carriedOverMinutes += Number.isFinite(b.carriedOverMinutes) ? b.carriedOverMinutes : 0;
          remainingMinutes += computeRemainingMinutes(b);
          if (b.missed && computeRemainingMinutes(b) > 0) missed = true;
        });
      }

      return {
        id: s.id || null,
        name: s.name,
        priority: s.priority || 'medium',
        dueDate: s.dueDate || null,
        minutesRequested: s.minutesRequested,
        scheduledMinutes,
        remainingMinutes,
        carriedOverMinutes,
        missed,
        // A subject with at least one generated block, none of which have
        // anything left, is done; one never scheduled at all never is.
        completed: blocks.length > 0 && remainingMinutes === 0,
        hasSchedule: blocks.length > 0,
      };
    });
}

// The total "free" (unscheduled, available) minutes on an already-generated
// day — the exact same 'free' block type the Planner's own legend and
// Daily Summary already use, not a second capacity calculation. Returns
// null (not 0) when there's no generated schedule to read at all, so a fit
// score can stay neutral instead of assuming zero availability.
export function computeAvailableStudyMinutes(scheduleItems) {
  if (!Array.isArray(scheduleItems) || scheduleItems.length === 0) return null;
  return scheduleItems
    .filter((e) => e && e.type === 'free')
    .reduce((sum, e) => sum + Math.max(0, (e.end ?? 0) - (e.start ?? 0)), 0);
}

// ---------------------------------------------------------------------------
// Urgency (shared by the score below and could be reused by any future
// "days until due" label so Home/Planner/Insights never disagree)
// ---------------------------------------------------------------------------

export function daysUntilDue(dueDate, todayDateStr) {
  if (!dueDate || !todayDateStr) return null;
  const toUtc = (d) => {
    const [y, m, day] = d.split('-').map(Number);
    return Date.UTC(y, m - 1, day);
  };
  return Math.round((toUtc(dueDate) - toUtc(todayDateStr)) / 86400000);
}

// One of a small fixed set of urgency buckets — every downstream consumer
// (score, reason tags, explanation clauses) branches on this same bucket
// name rather than re-deriving its own day-count thresholds.
export function classifyUrgency(dueDate, todayDateStr) {
  const days = daysUntilDue(dueDate, todayDateStr);
  if (days === null) return 'none';
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days <= 3) return 'soon';
  if (days <= 7) return 'week';
  return 'later';
}

const URGENCY_SCORE = { overdue: 100, today: 80, tomorrow: 65, soon: 45, week: 20, later: 5, none: 0 };
const PRIORITY_SCORE = { high: 30, medium: 15, low: 0 };
const MISSED_SCORE = 25;
const CARRY_OVER_SCORE = 10;
const REMAINING_WORK_SCORE_CAP = 20;
const REMAINING_WORK_SCORE_DIVISOR = 6; // 120 remaining minutes -> the cap
const PROGRESS_SCORE_CAP = 15;
const FIT_SCORE_FULL = 10;
const FIT_SCORE_CLOSE = 5;
const FIT_CLOSE_MULTIPLIER = 1.5; // "reasonably fits" allows some overrun, not an exact match

// ---------------------------------------------------------------------------
// The score itself
// ---------------------------------------------------------------------------

// Every term is independent and additive — there is no multiplication, no
// randomness, and no factor can zero out another (a missed+carried-over
// task adds both boosts once each, never a stacked/compounded penalty —
// see section 21's "missed + carried-over" edge case). Returns null for a
// task that should never be recommended at all (completed, or nothing left
// to do) so callers never have to separately re-check that guard.
//
// `context`: { todayDateStr, availableMinutesToday } — availableMinutesToday
// may be null/undefined when unknown (no generated schedule yet), which
// keeps fitScore neutral rather than punishing every task equally.
export function computeTaskScore(task, context = {}) {
  if (!task || task.completed || !(task.remainingMinutes > 0)) return null;

  const urgencyBucket = classifyUrgency(task.dueDate, context.todayDateStr);
  const urgencyScore = URGENCY_SCORE[urgencyBucket] ?? 0;
  const priorityScore = PRIORITY_SCORE[task.priority] ?? PRIORITY_SCORE.medium;
  const missedScore = task.missed ? MISSED_SCORE : 0;
  const carryOverScore = task.carriedOverMinutes > 0 ? CARRY_OVER_SCORE : 0;

  // "Remaining work should matter, but not automatically make huge tasks
  // always win" — a small, capped boost from how much is left, not a
  // dominant term.
  const remainingWorkScore = Math.min(REMAINING_WORK_SCORE_CAP, Math.round(task.remainingMinutes / REMAINING_WORK_SCORE_DIVISOR));

  // A task already partially worked on today (some of its scheduled time is
  // already behind it) is worth finishing — a bounded boost proportional to
  // how far in, 0 for a task never touched or never even scheduled yet.
  const completedSoFar = Math.max(0, task.scheduledMinutes - task.remainingMinutes);
  const progressFraction = task.scheduledMinutes > 0 ? completedSoFar / task.scheduledMinutes : 0;
  const progressScore = Math.round(progressFraction * PROGRESS_SCORE_CAP);

  // Fit: only scored when today's remaining capacity is actually known.
  let fitScore = 0;
  let fits = null; // null = unknown, true = fits today, false = does not
  if (Number.isFinite(context.availableMinutesToday) && context.availableMinutesToday > 0) {
    if (task.remainingMinutes <= context.availableMinutesToday) {
      fitScore = FIT_SCORE_FULL;
      fits = true;
    } else if (task.remainingMinutes <= context.availableMinutesToday * FIT_CLOSE_MULTIPLIER) {
      fitScore = FIT_SCORE_CLOSE;
      fits = true;
    } else {
      fits = false;
    }
  }

  const score = urgencyScore + priorityScore + missedScore + carryOverScore + remainingWorkScore + progressScore + fitScore;

  return {
    score,
    urgencyBucket,
    urgencyScore,
    priorityScore,
    missedScore,
    carryOverScore,
    remainingWorkScore,
    progressScore,
    fitScore,
    fits,
  };
}

// ---------------------------------------------------------------------------
// Explanations — fixed, deterministic clause selection, never generated text
// ---------------------------------------------------------------------------

// Short, reusable reason tags for compact UI chips (Home's "Due soon / High
// priority / Missed / Carry over / Fits today"). Order matches the fixed
// priority list explanationClauseOrder below, so the strongest reasons
// always lead.
const CLAUSE_ORDER = ['overdue', 'today', 'missed', 'tomorrow', 'highPriority', 'soon', 'carriedOver', 'fits', 'inProgress', 'unfinished'];

// Which clause keys are "active" for this task/breakdown — a plain set of
// booleans, each backed directly by a score input, never inferred.
function activeClauses(task, breakdown) {
  return {
    overdue: breakdown.urgencyBucket === 'overdue',
    today: breakdown.urgencyBucket === 'today',
    tomorrow: breakdown.urgencyBucket === 'tomorrow',
    soon: breakdown.urgencyBucket === 'soon' || breakdown.urgencyBucket === 'week',
    highPriority: task.priority === 'high',
    missed: Boolean(task.missed),
    carriedOver: task.carriedOverMinutes > 0,
    fits: breakdown.fits === true,
    inProgress: breakdown.progressScore > 0,
    // Always available as a last-resort clause — every scored task has
    // remainingMinutes > 0 by construction (computeTaskScore already
    // guards this), so this is never shown as false information.
    unfinished: true,
  };
}

// Up to `limit` clause keys, strongest first, for chips or a sentence.
export function selectReasonKeys(task, breakdown, limit = 2) {
  if (!breakdown) return [];
  const active = activeClauses(task, breakdown);
  const keys = CLAUSE_ORDER.filter((k) => active[k]);
  // "unfinished" only ever appears if nothing stronger applied at all —
  // it's a fallback, not a real reason to lead with.
  const withoutFallback = keys.filter((k) => k !== 'unfinished');
  const ordered = withoutFallback.length > 0 ? withoutFallback : keys;
  return ordered.slice(0, limit);
}

// `labels`: { tag: {overdue, today, tomorrow, soon, highPriority, missed,
//   carriedOver, fits}, clause: {...same keys, phrased as a clause},
//   explanationOne: '...{clause1}...', explanationTwo: '...{clause1}...{clause2}...' }
// Kept as a plain object the caller supplies (translated via i18n) rather
// than importing i18n here, so this file stays DOM/i18n-free like the rest
// of src/dashboard/*Model.js.
export function buildReasonTags(task, breakdown, labels, limit = 3) {
  const keys = selectReasonKeys(task, breakdown, limit).filter((k) => k !== 'unfinished' && k !== 'inProgress');
  return keys.map((k) => labels.tag[k]).filter(Boolean);
}

export function buildExplanation(task, breakdown, labels) {
  const keys = selectReasonKeys(task, breakdown, 2);
  const clauses = keys.map((k) => labels.clause[k]).filter(Boolean);
  if (clauses.length === 0) return '';
  if (clauses.length === 1) return (labels.explanationOne || '{clause1}').replace('{clause1}', clauses[0]);
  return (labels.explanationTwo || '{clause1} {clause2}').replace('{clause1}', clauses[0]).replace('{clause2}', clauses[1]);
}

// V2-E: the "Why:" list under Home's top recommendation — concrete facts
// with their real numbers ("Due in 2 days", "120 min remaining"), rather
// than the generic clauses above. Same rule as the clauses: every fact is
// backed directly by a score input or stored value, never inferred.
//
// `context.tomorrowStudyMinutes` (optional): study minutes already planned
// for tomorrow. When that's a heavy day (>= heavyDayMinutes) and the task
// isn't due today/overdue, "Tomorrow is heavily scheduled" is a real reason
// to start today.
//
// Returns [{ key, value? }] strongest first, capped at `limit`. Keys:
//   overdue{value:days} dueToday dueTomorrow dueIn{value:days}
//   highPriority missed carriedOver{value:minutes} remaining{value:minutes}
//   inProgress fitsToday tomorrowHeavy{value:minutes}
export function buildReasonFacts(task, breakdown, context = {}, limit = 4) {
  if (!task || !breakdown) return [];
  const facts = [];
  const days = daysUntilDue(task.dueDate, context.todayDateStr);
  if (days !== null) {
    if (days < 0) facts.push({ key: 'overdue', value: -days });
    else if (days === 0) facts.push({ key: 'dueToday' });
    else if (days === 1) facts.push({ key: 'dueTomorrow' });
    else if (days <= 7) facts.push({ key: 'dueIn', value: days });
  }
  if (task.priority === 'high') facts.push({ key: 'highPriority' });
  if (task.missed) facts.push({ key: 'missed' });
  facts.push({ key: 'remaining', value: task.remainingMinutes });
  const heavy = context.heavyDayMinutes ?? 240;
  if (Number.isFinite(context.tomorrowStudyMinutes) && context.tomorrowStudyMinutes >= heavy && (days === null || days >= 1)) {
    facts.push({ key: 'tomorrowHeavy', value: context.tomorrowStudyMinutes });
  }
  if (task.carriedOverMinutes > 0) facts.push({ key: 'carriedOver', value: task.carriedOverMinutes });
  if (breakdown.progressScore > 0) facts.push({ key: 'inProgress' });
  if (breakdown.fits === true) facts.push({ key: 'fitsToday' });
  return facts.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Ranking (Home's "Recommended Next" + Planner's "Sort: Recommended")
// ---------------------------------------------------------------------------

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

// Deterministic tie-break, applied only when scores are exactly equal:
// earlier due date first (no date sorts after any date) -> higher priority
// -> less remaining time -> stable original order (Array#sort is a stable
// sort per the ES2019+ spec, so simply returning 0 here preserves input
// order rather than needing an explicit index to compare).
function compareRanked(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const ad = a.task.dueDate;
  const bd = b.task.dueDate;
  if (ad !== bd) {
    if (!ad) return 1;
    if (!bd) return -1;
    if (ad !== bd) return ad < bd ? -1 : 1;
  }
  const ap = PRIORITY_ORDER[a.task.priority] ?? 1;
  const bp = PRIORITY_ORDER[b.task.priority] ?? 1;
  if (ap !== bp) return ap - bp;
  if (a.task.remainingMinutes !== b.task.remainingMinutes) return a.task.remainingMinutes - b.task.remainingMinutes;
  return 0;
}

// Every recommendable task (completed / zero-remaining tasks are excluded,
// never just sorted to the bottom — see computeTaskScore), scored and
// sorted strongest first. Each entry is `{ task, ...scoreBreakdown }`.
export function rankTasks(tasks, context = {}) {
  return (tasks || [])
    .map((task) => {
      const breakdown = computeTaskScore(task, context);
      return breakdown ? { task, ...breakdown } : null;
    })
    .filter(Boolean)
    .sort(compareRanked);
}

// ---------------------------------------------------------------------------
// Plain deterministic sorts (Study Tasks panel: Due date / Priority /
// Remaining time) — presentation only, never reordering/mutating stored data.
// ---------------------------------------------------------------------------

export function compareByDueDate(a, b) {
  if (a.dueDate !== b.dueDate) {
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  return 0;
}

export function compareByPriority(a, b) {
  const ap = PRIORITY_ORDER[a.priority] ?? 1;
  const bp = PRIORITY_ORDER[b.priority] ?? 1;
  return ap - bp;
}

export function compareByRemainingTime(a, b) {
  return (a.remainingMinutes || 0) - (b.remainingMinutes || 0);
}

export const SORT_MODES = ['recommended', 'due', 'priority', 'remaining'];

// Reorders the FULL task list (including completed/zero-remaining ones,
// which a real Study Tasks panel must keep showing so they stay editable)
// for display only. "recommended" ranks every actionable task with
// rankTasks and appends the rest (completed / nothing left) afterward,
// each group keeping its own stable relative order; every other mode is a
// plain stable sort over the whole list.
export function sortTasksForDisplay(tasks, mode, context = {}) {
  const list = tasks || [];
  if (mode === 'due') return [...list].sort(compareByDueDate);
  if (mode === 'priority') return [...list].sort(compareByPriority);
  if (mode === 'remaining') return [...list].sort(compareByRemainingTime);
  if (mode === 'recommended') {
    const actionable = list.filter((t) => !t.completed && t.remainingMinutes > 0);
    const rest = list.filter((t) => t.completed || !(t.remainingMinutes > 0));
    const ranked = rankTasks(actionable, context).map((r) => r.task);
    return [...ranked, ...rest];
  }
  return [...list];
}
