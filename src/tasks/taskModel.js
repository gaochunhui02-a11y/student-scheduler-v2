// Pure task-level logic for V3. A "task" the student sees is a GROUP of
// study_subjects rows: the root row they typed in, plus any chunks that
// Multi-Day Planning or Carry Over split off it (origin_subject_id points
// at the root). V3 never creates a second task table — this module just
// rolls those rows and their study blocks up into one record.
//
// Minute accounting for a group:
//   requested = Σ rows.minutes_requested − Σ blocks.carried_over_minutes
//     (carried-over minutes were re-requested by the chunk that received
//      them, so counting both would double-count)
//   completed = Σ effective completed minutes of the group's study blocks
//   remaining = max(0, requested − completed)
// A task is done when the student marked it done (root.completed_at), or
// when its blocks have covered everything it asked for.

import { deriveBlockStatus, combineTaskStatuses } from '../shared/statusModel.js';

function duration(b) {
  return Math.max(0, (b.end_minutes ?? b.end ?? 0) - (b.start_minutes ?? b.start ?? 0));
}

export function blockCompletedMinutes(b) {
  const d = duration(b);
  if (b.completed) return d;
  const partial = Number.isFinite(b.completed_minutes) ? b.completed_minutes : 0;
  return Math.min(Math.max(0, partial), d);
}

export function rootIdOf(row) {
  return row.origin_subject_id || row.id;
}

/**
 * @param {Array} rows   study_subjects rows (each may carry `for_date` from the schedules embed)
 * @param {Array} blocks schedule_items rows (study blocks; any with source_subject_id in rows)
 * @param {{today?:string, nowMinutes?:number, todayScheduleIds?:Set<string>}} ctx
 * @returns {Array} task groups
 */
export function buildTaskGroups(rows = [], blocks = [], ctx = {}) {
  const byRoot = new Map();
  rows.forEach((r) => {
    const rootId = rootIdOf(r);
    if (!byRoot.has(rootId)) byRoot.set(rootId, { rootId, rows: [] });
    byRoot.get(rootId).rows.push(r);
  });
  const blocksBySubject = new Map();
  blocks.filter((b) => (b.item_type ?? b.type) === 'study' && b.source_subject_id).forEach((b) => {
    if (!blocksBySubject.has(b.source_subject_id)) blocksBySubject.set(b.source_subject_id, []);
    blocksBySubject.get(b.source_subject_id).push(b);
  });

  const groups = [];
  byRoot.forEach(({ rootId, rows: groupRows }) => {
    // A chunk whose root isn't in this result set (e.g. filtered by date)
    // still forms a group; the earliest row stands in for the root.
    const sorted = groupRows.slice().sort((a, b) => String(a.for_date || '').localeCompare(String(b.for_date || '')));
    const root = groupRows.find((r) => r.id === rootId) || sorted[0];
    const groupBlocks = groupRows.flatMap((r) => blocksBySubject.get(r.id) || []);
    const carried = groupBlocks.reduce((s, b) => s + (Number.isFinite(b.carried_over_minutes) ? b.carried_over_minutes : 0), 0);
    const requestedRaw = groupRows.reduce((s, r) => s + (Number(r.minutes_requested) || 0), 0);
    const requested = Math.max(0, requestedRaw - carried);
    const completed = groupBlocks.reduce((s, b) => s + blockCompletedMinutes(b), 0);
    const planned = groupBlocks.reduce((s, b) => s + duration(b), 0);
    const explicitDone = Boolean(root.completed_at);
    const doneByBlocks = groupBlocks.length > 0 && requested > 0 && completed >= requested;
    const done = explicitDone || doneByBlocks;

    let status;
    if (done) status = 'done';
    else if (groupBlocks.length === 0) status = 'unscheduled';
    else {
      const statuses = groupBlocks.map((b) => deriveBlockStatus(b, {
        nowMinutes: ctx.nowMinutes,
        isToday: Boolean(ctx.todayScheduleIds && ctx.todayScheduleIds.has(b.schedule_id)),
      }));
      status = combineTaskStatuses(statuses);
      if (status === 'done') status = 'partial'; // blocks finished but the task still asks for more time
    }

    const dates = [...new Set(groupRows.map((r) => r.for_date).filter(Boolean))].sort();
    groups.push({
      id: root.id,
      root,
      rows: groupRows,
      rowIds: groupRows.map((r) => r.id),
      blocks: groupBlocks,
      name: root.name,
      courseId: root.course_id || groupRows.map((r) => r.course_id).find(Boolean) || null,
      spaceId: root.space_id || null, // V4: its own space; course space is resolved by spacesModel
      dueDate: root.due_date || null,
      priority: root.priority || 'medium',
      tags: Array.isArray(root.tags) ? root.tags : [],
      notes: root.notes || '',
      requestedMinutes: requested,
      completedMinutes: completed,
      plannedMinutes: planned,
      remainingMinutes: done ? 0 : Math.max(0, requested - completed),
      actualMinutes: Number.isFinite(root.actual_minutes) ? root.actual_minutes : null,
      done,
      explicitDone,
      completedAt: root.completed_at || null,
      status,
      dates,
      firstDate: dates[0] || root.for_date || null,
      overdue: !done && Boolean(root.due_date) && Boolean(ctx.today) && root.due_date < ctx.today,
      recurrenceRuleId: root.recurrence_rule_id || null,
      examTopicId: root.exam_topic_id || null,
      dependencyOverride: Boolean(root.dependency_override),
      // V4-B universal task fields (all null/0 for V3 tasks)
      projectId: root.project_id || null,
      milestoneId: root.project_milestone_id || null,
      dueTime: root.due_time ? String(root.due_time).slice(0, 5) : null,
      startTime: root.start_time ? String(root.start_time).slice(0, 5) : null,
      statusOverride: root.status_override || null,
      projectSort: Number.isFinite(root.project_sort) ? root.project_sort : 0,
      // V4-B.1: the day the task is planned on (null = unscheduled backlog);
      // separate from dueDate. See tasks/taskDates.js.
      scheduledDate: root.schedule_id ? root.for_date || null : null,
      plannedBy: root.planned_by || null,
    });
  });
  return groups;
}

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

// Open tasks first (soonest due, then priority), done tasks last (most
// recently completed first).
export function sortTaskGroups(groups = []) {
  return groups.slice().sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.done) return String(b.completedAt || b.dueDate || '').localeCompare(String(a.completedAt || a.dueDate || ''));
    const ad = a.dueDate || '9999-12-31';
    const bd = b.dueDate || '9999-12-31';
    if (ad !== bd) return ad.localeCompare(bd);
    const pr = (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1);
    if (pr) return pr;
    return String(a.name).localeCompare(String(b.name));
  });
}

export function courseProgress(groups = []) {
  const total = groups.length;
  const done = groups.filter((g) => g.done).length;
  return { total, done, open: total - done, fraction: total ? done / total : 0 };
}

export const TASK_LIMITS = { name: 200, notes: 5000, minMinutes: 5, maxMinutes: 24 * 60 };

// Validates the task editor form. Returns { ok, fields, errors } with
// errors as i18n keys.
export function validateTaskFields(input = {}) {
  const errors = {};
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, TASK_LIMITS.name) : '';
  if (!name) errors.name = 'tasks.errNameRequired';
  const minutes = Number(input.minutes_requested);
  if (!Number.isFinite(minutes) || minutes < TASK_LIMITS.minMinutes || minutes > TASK_LIMITS.maxMinutes) errors.minutes_requested = 'tasks.errMinutesRange';
  const due = input.due_date || null;
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) errors.due_date = 'tasks.errDateInvalid';
  const priority = ['low', 'medium', 'high'].includes(input.priority) ? input.priority : 'medium';
  return {
    ok: Object.keys(errors).length === 0,
    errors,
    fields: {
      name,
      minutes_requested: Number.isFinite(minutes) ? Math.round(minutes) : null,
      due_date: due,
      priority,
      notes: typeof input.notes === 'string' ? input.notes.slice(0, TASK_LIMITS.notes) : '',
    },
  };
}

/**
 * V4-B.1: the scheduled date is optional; a start time needs one. An empty
 * or invalid date means "unscheduled" — never silently today.
 * @returns {{ ok: boolean, error: string|null, planDate: string|null }}
 */
export function validateTaskSchedule({ planDate, startTime }) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(planDate || '') ? planDate : null;
  if (startTime && !date) return { ok: false, error: 'tasks.errStartNeedsDate', planDate: null };
  return { ok: true, error: null, planDate: date };
}
