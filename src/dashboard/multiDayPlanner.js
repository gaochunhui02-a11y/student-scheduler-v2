// Pure logic for Phase 13 — Smart Multi-Day Planning. No DOM, no Supabase.
//
// The daily scheduler (scheduler.js) already decides WHERE minutes fit
// inside one day. This module decides HOW MANY of a study task's minutes
// belong on WHICH date, spread across a date range, deterministically:
//
//   - never on a date after the task's due date
//   - never more than a date's remaining study capacity (computeDayCapacity
//     in scheduler.js — this module just consumes that number, per date)
//   - highest priority / earliest due date first, largest remaining task
//     first — the exact same tie-break order generateSchedule() itself uses
//   - spread evenly across the eligible dates rather than dumping
//     everything on the first day that fits
//
// data.js/dashboard.js own fetching the per-date capacity numbers and the
// group of study_subjects rows a task has already been split into; this
// module only ever receives plain data and returns plain data.

import { addDaysToDateStr } from './dateUtils.js';

// A row belongs to the same multi-day task "group" as `rootId` when it IS
// the root or points back to it via origin_subject_id. A row is FROZEN —
// never touched by re-planning — once any schedule_item generated from it
// has been locked or completed; that date's minutes are already committed
// or already done. Everything else is OPEN: safe to delete and redistribute.
//
// @param {{id:string, origin_subject_id?:string|null, minutes_requested:number}[]} groupRows
// @param {{source_subject_id?:string|null, locked?:boolean, completed?:boolean}[]} items every schedule_item generated from any row in groupRows
export function classifyGroupRows(groupRows, items) {
  const committedIds = new Set(
    (items || []).filter((i) => i.locked || i.completed).map((i) => i.source_subject_id)
  );
  const frozen = [];
  const open = [];
  for (const row of groupRows || []) {
    (committedIds.has(row.id) ? frozen : open).push(row);
  }
  const sum = (rows) => rows.reduce((total, r) => total + (r.minutes_requested || 0), 0);
  return { frozen, open, frozenMinutes: sum(frozen), openMinutes: sum(open) };
}

// Every date from startDate to endDate inclusive, further capped at dueDate
// when one is set (a date after the due date is never a valid target),
// excluding any date already spoken for by a frozen row of this same group
// (that date's capacity is already committed to this task).
//
// @param {string} startDate "YYYY-MM-DD"
// @param {string} endDate "YYYY-MM-DD"
// @param {string|null} dueDate
// @param {string[]} [excludeDates] dates already covered by a frozen row
export function buildCandidateDates(startDate, endDate, dueDate, excludeDates = []) {
  const exclude = new Set(excludeDates);
  const dates = [];
  let cursor = startDate;
  let guard = 0;
  while (cursor <= endDate && guard < 3660) {
    // a year+ is already an absurd planning horizon — bail rather than loop forever on bad input
    guard++;
    if ((!dueDate || cursor <= dueDate) && !exclude.has(cursor)) dates.push(cursor);
    if (cursor === endDate) break;
    cursor = addDaysToDateStr(cursor, 1);
  }
  return dates;
}

// Spreads `remainingMinutes` across `candidateDates` (already date-ordered,
// already filtered to the due-date cutoff), never exceeding each date's
// `capacityByDate[date]`, and skipping any chunk smaller than
// `minBlockMinutes` unless it's the last bit of the task left to place —
// a sliver too small to be worth its own session everywhere else is still
// better than leaving it completely unscheduled at the very end.
//
// Allocation is round-robin over the still-open dates so the task is spread
// reasonably evenly rather than filling the first day to capacity before
// touching the next one: each pass offers every remaining date an equal
// share of what's left, capped by that date's own remaining room.
//
// @param {object} input
// @param {number} input.remainingMinutes
// @param {string[]} input.candidateDates
// @param {Record<string, number>} input.capacityByDate date -> minutes still free that date
// @param {number} [input.minBlockMinutes]
// @returns {{ segments: {date:string, minutes:number}[], unscheduledMinutes: number }}
export function allocateAcrossDays({ remainingMinutes, candidateDates, capacityByDate, minBlockMinutes = 0 }) {
  const remainingByDate = new Map(candidateDates.map((d) => [d, Math.max(0, capacityByDate[d] || 0)]));
  const allocatedByDate = new Map(candidateDates.map((d) => [d, 0]));
  let remaining = Math.max(0, remainingMinutes || 0);

  let openDates = candidateDates.filter((d) => remainingByDate.get(d) > 0);
  while (remaining > 0 && openDates.length > 0) {
    const share = Math.max(1, Math.ceil(remaining / openDates.length));
    let placedThisPass = false;
    for (const date of openDates) {
      if (remaining <= 0) break;
      const room = remainingByDate.get(date);
      if (room <= 0) continue;
      const take = Math.min(share, room, remaining);
      if (take <= 0) continue;
      allocatedByDate.set(date, allocatedByDate.get(date) + take);
      remainingByDate.set(date, room - take);
      remaining -= take;
      placedThisPass = true;
    }
    openDates = openDates.filter((d) => remainingByDate.get(d) > 0);
    if (!placedThisPass) break; // no date could absorb anything this pass — avoid spinning forever
  }

  // A date that ended up with a sliver under minBlockMinutes is folded back
  // into "unscheduled" UNLESS every allocated chunk is such a sliver (i.e.
  // only a small amount of the task is left at all) — in that case keeping
  // the slivers beats scheduling nothing.
  const rawSegments = candidateDates
    .map((date) => ({ date, minutes: allocatedByDate.get(date) || 0 }))
    .filter((s) => s.minutes > 0);
  let segments = rawSegments.filter((s) => s.minutes >= minBlockMinutes);
  if (segments.length === 0 && rawSegments.length > 0) segments = rawSegments;

  const unscheduledMinutes = Math.max(0, remainingMinutes || 0) - segments.reduce((total, s) => total + s.minutes, 0);
  return { segments, unscheduledMinutes };
}
