// Catch up on missed work (V4-E), pure and deterministic — no AI, and
// nothing moves until the student confirms the preview.
//
// WHAT counts as missed work: open tasks with time still left whose plan is
// in the past and that have no part planned today or later —
//   * 'missed'  planned on a past day (blocks missed / not finished, or a
//               planned day passed with no session)
//   * 'overdue' past its due date and not planned anywhere
// Deferred tasks (status set by the student) are left alone.
//
// HOW the remaining time moves (exact minute accounting, same rules as the
// Planner's own Carry Over so nothing is double-counted):
//   * a task with no study blocks simply moves to its new day ('move');
//   * a task with blocks on past days keeps those blocks (history stays
//     true) and gets ONE new part on the new day ('carry') holding
//       — each unlocked, unfinished past block's remaining minutes
//         (recorded as carried_over_minutes on that block, which marks it
//         missed), plus
//       — any minutes a past part asked for that never got a block
//         (that part's minutes_requested is trimmed to what it was blocked)
//     Locked blocks are never touched.
// WHERE it goes: the same day-assignment as "Plan my backlog" (earliest due
// first, a day before the due date with room, else the roomiest — "tight" —
// else left for the student), using each day's free capacity after energy
// preferences and routines.

import { planBacklog } from './backlogPlanner.js';
import { computeRemainingMinutes } from '../dashboard/carryOverModel.js';

function blockMinutes(b) {
  return Math.max(0, (b.end_minutes ?? 0) - (b.start_minutes ?? 0));
}
function remainingOf(b) {
  return computeRemainingMinutes({
    start: b.start_minutes, end: b.end_minutes, completed: Boolean(b.completed),
    completedMinutes: b.completed_minutes, carriedOverMinutes: b.carried_over_minutes,
  });
}

/**
 * What would move for one task group, or null when nothing can move.
 * @returns {null | { kind: 'move'|'carry', minutes, moveRowIds: string[], blockCarries: Array<{blockId, minutes}>, rowTrims: Array<{rowId, minutes}>, lockedMinutes }}
 */
export function catchUpPortion(group, today) {
  if (!group || group.done) return null;
  const pastRows = group.rows.filter((r) => r.for_date && r.for_date < today && !r.completed_at);
  const unscheduledRows = group.rows.filter((r) => !r.for_date && !r.completed_at);
  const blocksByRow = new Map();
  group.blocks.forEach((b) => {
    if (!blocksByRow.has(b.source_subject_id)) blocksByRow.set(b.source_subject_id, []);
    blocksByRow.get(b.source_subject_id).push(b);
  });
  const hasBlocks = group.rows.some((r) => (blocksByRow.get(r.id) || []).length);
  if (!hasBlocks) {
    const rows = [...pastRows, ...unscheduledRows];
    if (!rows.length) return null;
    const minutes = rows.reduce((s, r) => s + (Number(r.minutes_requested) || 0), 0);
    return minutes > 0 ? { kind: 'move', minutes, carryMinutes: 0, moveRowIds: rows.map((r) => r.id), blockCarries: [], rowTrims: [], lockedMinutes: 0 } : null;
  }
  const blockCarries = [];
  const rowTrims = [];
  const moveRowIds = [];
  let moveMinutes = 0;
  let lockedMinutes = 0;
  pastRows.forEach((r) => {
    const blocks = blocksByRow.get(r.id) || [];
    // A past part that never got a block just moves, like a task without blocks.
    if (!blocks.length) {
      moveRowIds.push(r.id);
      moveMinutes += Number(r.minutes_requested) || 0;
      return;
    }
    blocks.forEach((b) => {
      const rem = remainingOf(b);
      if (rem <= 0) return;
      if (b.locked) { lockedMinutes += rem; return; }
      blockCarries.push({ blockId: b.id, minutes: rem });
    });
    const blocked = blocks.reduce((s, b) => s + blockMinutes(b), 0);
    const asked = Number(r.minutes_requested) || 0;
    if (asked > blocked) rowTrims.push({ rowId: r.id, minutes: blocked, freed: asked - blocked });
  });
  // An unscheduled part of a task that also has blocks (rare) moves too.
  unscheduledRows.forEach((r) => {
    if ((blocksByRow.get(r.id) || []).length) return;
    moveRowIds.push(r.id);
    moveMinutes += Number(r.minutes_requested) || 0;
  });
  const carryMinutes = blockCarries.reduce((s, c) => s + c.minutes, 0) + rowTrims.reduce((s, x) => s + x.freed, 0);
  const minutes = carryMinutes + moveMinutes;
  if (minutes <= 0) return null;
  return { kind: carryMinutes > 0 ? 'carry' : 'move', minutes, carryMinutes, moveRowIds, blockCarries, rowTrims, lockedMinutes };
}

/**
 * Open tasks with missed work, each with its portion and reason.
 * @returns {Array<{ group, reason: 'missed'|'overdue', portion }>}
 */
export function collectCatchUp(groups = [], today) {
  const out = [];
  groups.forEach((g) => {
    if (g.done || g.statusOverride === 'deferred') return;
    // Anything already planned today or later is in hand — leave the task alone.
    if ((g.dates || []).some((d) => d >= today)) return;
    const stalePlan = (g.dates || []).some((d) => d < today);
    const overdue = Boolean(g.dueDate && g.dueDate < today);
    if (!stalePlan && !overdue) return;
    const portion = catchUpPortion(g, today);
    if (!portion) return;
    out.push({ group: g, reason: stalePlan ? 'missed' : 'overdue', portion });
  });
  return out.sort((a, b) => String(a.group.dueDate || '9999').localeCompare(String(b.group.dueDate || '9999'))
    || String(a.group.name).localeCompare(String(b.group.name)));
}

/**
 * Day proposals for the chosen items.
 * @param {Array} items     from collectCatchUp (optionally filtered by the student)
 * @param {Array<{date, free}>} days  free capacity per day (freeDaysFromForecast)
 * @param {string} startDate          first allowed day (today, or tomorrow late in the day)
 */
export function proposeCatchUp(items = [], days = [], startDate) {
  const byId = new Map(items.map((x) => [x.group.id, x]));
  const plan = planBacklog({
    today: startDate,
    days: days.filter((d) => d.date >= startDate),
    tasks: items.map((x) => ({ id: x.group.id, name: x.group.name, minutes: x.portion.minutes, dueDate: x.group.dueDate, priority: x.group.priority })),
  });
  return {
    assignments: plan.assignments.map((a) => ({ ...a, reason: byId.get(a.taskId).reason, portion: byId.get(a.taskId).portion, group: byId.get(a.taskId).group, lateForDue: Boolean(byId.get(a.taskId).group.dueDate && a.date > byId.get(a.taskId).group.dueDate) })),
    unplaced: plan.unplaced,
  };
}

/** Late in the evening the first catch-up day is tomorrow. */
export function catchUpStart(today, nowMinutes, tomorrow, cutoff = 19 * 60) {
  return nowMinutes >= cutoff ? tomorrow : today;
}
