import { effectiveCompletedMinutes } from '../analytics/analyticsModel.js';

// A study block's length in minutes; 0 for rows without start/end.
function blockDuration(item) {
  const d = (item.end_minutes ?? 0) - (item.start_minutes ?? 0);
  return Number.isFinite(d) && d > 0 ? d : 0;
}

// Pure aggregation for the History list — no Supabase, no DOM. Given raw rows
// shaped like the Supabase query results data.js's listScheduleHistory()
// fetches (schedules/classes/study_subjects/schedule_items for a user),
// computes per-date stats: how many classes, how many study subjects, and
// study-block completion progress.
//
// V2-E adds, per date: planned/completed study minutes (completed uses the
// same partial-aware rule as Insights), carried-over minutes, how many
// blocks were flagged missed, and which subjects were studied — enough for
// History's filters (date, subject, completed, missed). Rows from before
// these columns existed (no start/end/completed_minutes) read as 0, never
// NaN.
//
// @param {{id:string, for_date:string}[]} schedules
// @param {{schedule_id:string}[]} classes
// @param {{schedule_id:string}[]} subjects
// @param {{schedule_id:string, item_type:string, completed:boolean}[]} items
export function aggregateScheduleHistory(schedules, classes, subjects, items) {
  const countBy = (rows) => {
    const map = new Map();
    for (const r of rows) map.set(r.schedule_id, (map.get(r.schedule_id) || 0) + 1);
    return map;
  };
  const classCounts = countBy(classes);
  const subjectCounts = countBy(subjects);

  const studyItemCounts = new Map();
  const completedItemCounts = new Map();
  const minutes = new Map(); // schedule_id -> { planned, completed, carried, missed, names:Set }
  const minutesFor = (id) => {
    let m = minutes.get(id);
    if (!m) {
      m = { planned: 0, completed: 0, carried: 0, missed: 0, names: new Set() };
      minutes.set(id, m);
    }
    return m;
  };
  for (const item of items) {
    if (item.item_type !== 'study') continue;
    studyItemCounts.set(item.schedule_id, (studyItemCounts.get(item.schedule_id) || 0) + 1);
    if (item.completed) completedItemCounts.set(item.schedule_id, (completedItemCounts.get(item.schedule_id) || 0) + 1);
    const m = minutesFor(item.schedule_id);
    const duration = blockDuration(item);
    m.planned += duration;
    m.completed += effectiveCompletedMinutes(item, duration);
    m.carried += Number.isFinite(item.carried_over_minutes) ? Math.max(0, item.carried_over_minutes) : 0;
    if (item.missed) m.missed += 1;
    if (item.name) m.names.add(item.name);
  }
  for (const subj of subjects) {
    if (subj.name) minutesFor(subj.schedule_id).names.add(subj.name);
  }

  return schedules.map((s) => {
    const studyBlockCount = studyItemCounts.get(s.id) || 0;
    const completedBlockCount = completedItemCounts.get(s.id) || 0;
    return {
      id: s.id,
      forDate: s.for_date,
      classCount: classCounts.get(s.id) || 0,
      subjectCount: subjectCounts.get(s.id) || 0,
      studyBlockCount,
      completedBlockCount,
      completionPercent: studyBlockCount > 0 ? Math.round((completedBlockCount / studyBlockCount) * 100) : 0,
      plannedMinutes: minutes.get(s.id)?.planned || 0,
      completedMinutes: minutes.get(s.id)?.completed || 0,
      carriedOverMinutes: minutes.get(s.id)?.carried || 0,
      missedBlockCount: minutes.get(s.id)?.missed || 0,
      subjectNames: Array.from(minutes.get(s.id)?.names || []).sort((a, b) => a.localeCompare(b)),
    };
  });
}

// Every subject name that appears anywhere in the history, for the
// Subject filter's options.
export function collectHistorySubjects(history) {
  const names = new Set();
  (history || []).forEach((h) => (h.subjectNames || []).forEach((n) => names.add(n)));
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

export const HISTORY_STATUS_FILTERS = ['all', 'completed', 'incomplete', 'missed', 'carried'];

// History filters (V2-E). All optional; an unset filter matches everything.
//   from/to  — inclusive YYYY-MM-DD bounds on the date
//   subject  — the day included this subject (exact name)
//   status   — 'completed': every study block done; 'incomplete': has
//              study blocks, not all done; 'missed': some block flagged
//              missed; 'carried': some work was carried forward
// Never mutates or re-sorts the input.
export function filterHistory(history, { from = '', to = '', subject = '', status = 'all' } = {}) {
  return (history || []).filter((h) => {
    if (from && h.forDate < from) return false;
    if (to && h.forDate > to) return false;
    if (subject && !(h.subjectNames || []).includes(subject)) return false;
    switch (status) {
      case 'completed': return h.studyBlockCount > 0 && h.completedBlockCount === h.studyBlockCount;
      case 'incomplete': return h.studyBlockCount > 0 && h.completedBlockCount < h.studyBlockCount;
      case 'missed': return h.missedBlockCount > 0;
      case 'carried': return h.carriedOverMinutes > 0;
      default: return true;
    }
  });
}

// How many filters are active — for the "Filters (2)" summary label.
export function countActiveHistoryFilters({ from = '', to = '', subject = '', status = 'all' } = {}) {
  return [from, to, subject].filter(Boolean).length + (status && status !== 'all' ? 1 : 0);
}
