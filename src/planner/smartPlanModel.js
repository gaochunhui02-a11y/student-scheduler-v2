// Smart plan (V5-B), pure and deterministic — the one engine behind
// "Catch up", "Plan my deadlines" and the Today recovery card.
//
//   WHAT  collectPlanItems: missed / overdue work (catchUpModel, with its
//         exact minute accounting) plus — optionally — open tasks that have
//         no day at all yet. Work already planned today or later stays put
//         and simply uses up those days' capacity.
//   WHERE proposeSmartPlan: deadlinePlanner (earliest deadline first, split
//         across days before the due date, never over a day's free time).
//         Anything that doesn't fit is kept on the last day and flagged —
//         nothing is dropped.
//   HOW   distributePieces: turns "these rows / this carried-over time" +
//         "these day parts" into row operations. Only two kinds exist:
//         'move' (an existing row gets a day and its share of minutes) and
//         'insert' (a new part linked to the task). Rows are never deleted,
//         and the minutes written always equal the minutes planned.
//   WHY   explanation facts come straight from the plan's numbers.

import { collectCatchUp, catchUpPortion } from './catchUpModel.js';
import { planDeadlines, withShortfall, explainTask } from './deadlinePlanner.js';

/**
 * @returns {Array<{ group, reason: 'missed'|'overdue'|'unscheduled', portion }>}
 */
export function collectPlanItems(groups = [], today, { includeUnscheduled = true } = {}) {
  const items = collectCatchUp(groups, today);
  if (includeUnscheduled) {
    const seen = new Set(items.map((x) => x.group.id));
    groups.forEach((g) => {
      if (seen.has(g.id) || g.done || g.statusOverride === 'deferred') return;
      if ((g.dates || []).length) return; // has a day already (past ones are catch-up's)
      const portion = catchUpPortion(g, today);
      if (portion) items.push({ group: g, reason: 'unscheduled', portion });
    });
  }
  return items.sort((a, b) => String(a.group.dueDate || '9999').localeCompare(String(b.group.dueDate || '9999'))
    || String(a.group.name).localeCompare(String(b.group.name)));
}

/**
 * @param {Array} items from collectPlanItems (the ones the student kept ticked)
 * @param {Array<{date, free}>} days free minutes per day (freeDaysFromForecast)
 * @param {string} start first day to use
 * @returns {{ proposals: Array<{ item, parts, summary, facts }>, totals: { minutes, planned, short, tasks } }}
 */
export function proposeSmartPlan(items = [], days = [], start, { minChunk = 30 } = {}) {
  const byId = new Map(items.map((x) => [x.group.id, x]));
  const plan = planDeadlines({
    tasks: items.map((x) => ({ id: x.group.id, name: x.group.name, minutes: x.portion.minutes, dueDate: x.group.dueDate, priority: x.group.priority })),
    days,
    start,
    minChunk,
  });
  const fallback = (s) => (s.dueDate && s.dueDate >= start ? s.dueDate : start);
  const saved = withShortfall(plan, fallback);
  const proposals = plan.tasks.map((summary) => ({
    item: byId.get(summary.taskId),
    parts: saved.filter((a) => a.taskId === summary.taskId),
    summary,
    facts: explainTask(summary),
  }));
  const totals = plan.tasks.reduce((t, s) => ({
    minutes: t.minutes + s.minutes,
    planned: t.planned + s.planned,
    short: t.short + s.shortBy,
    tasks: t.tasks + 1,
  }), { minutes: 0, planned: 0, short: 0, tasks: 0 });
  return { proposals, totals };
}

/** The pieces of work a plan item consists of: existing rows to move, plus carried-over time. */
export function piecesFor(item) {
  const minutesOf = new Map((item.group.rows || []).map((r) => [r.id, Math.max(0, Math.round(Number(r.minutes_requested) || 0))]));
  const pieces = item.portion.moveRowIds.map((id) => ({ rowId: id, minutes: minutesOf.get(id) || 0 })).filter((p) => p.minutes > 0);
  if (item.portion.kind === 'carry' && item.portion.carryMinutes > 0) pieces.push({ rowId: null, minutes: item.portion.carryMinutes });
  return pieces;
}

/**
 * Lays pieces (in order) into day parts (in date order).
 * A row's first segment moves the row; later segments of the same row and
 * every segment of new (carried) time are inserted as linked parts.
 * @param {Array<{rowId: string|null, minutes}>} pieces
 * @param {Array<{date, minutes}>} parts   same total as the pieces
 * @returns {Array<{ op: 'move', rowId, date, minutes } | { op: 'insert', date, minutes }>}
 */
export function distributePieces(pieces = [], parts = []) {
  const ops = [];
  const slots = parts.filter((p) => p.minutes > 0).map((p) => ({ date: p.date, left: Math.round(p.minutes) }));
  let si = 0;
  pieces.forEach((piece) => {
    let left = Math.round(piece.minutes);
    let first = true;
    while (left > 0) {
      let date;
      let take;
      if (si < slots.length) {
        const slot = slots[si];
        date = slot.date;
        take = Math.min(left, slot.left);
        slot.left -= take;
        if (slot.left <= 0) si += 1;
      } else if (slots.length) {
        // More pieces than parts (totals didn't match): the rest goes on the
        // last day rather than being lost.
        date = slots[slots.length - 1].date;
        take = left;
      } else {
        break; // no parts at all: nothing is written, the rows stay as they are
      }
      if (first && piece.rowId) ops.push({ op: 'move', rowId: piece.rowId, date, minutes: take });
      else {
        // Merge with an insert already going to the same day.
        const prev = ops.find((o) => o.op === 'insert' && o.date === date);
        if (prev) prev.minutes += take;
        else ops.push({ op: 'insert', date, minutes: take });
      }
      first = false;
      left -= take;
    }
  });
  return ops;
}

/** Total free minutes before each task's due date, and which tasks are at risk (for Today). */
export function deadlineCoverage(groups = [], today, horizonEnd) {
  return groups
    .filter((g) => !g.done && g.dueDate && g.dueDate >= today && g.dueDate <= horizonEnd)
    .map((g) => {
      // Work already given a day before (or on) the due date, from today on.
      const plannedAhead = (g.rows || [])
        .filter((r) => r.for_date && r.for_date >= today && r.for_date <= g.dueDate && !r.completed_at)
        .reduce((s, r) => s + (Number(r.minutes_requested) || 0), 0);
      const remaining = Math.max(0, Number(g.remainingMinutes) || 0);
      const unplanned = Math.max(0, remaining - plannedAhead);
      return { group: g, dueDate: g.dueDate, remaining, plannedAhead: Math.min(plannedAhead, remaining), unplanned };
    })
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || String(a.group.name).localeCompare(String(b.group.name)));
}
