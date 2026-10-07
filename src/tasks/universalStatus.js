// Universal task status (V4-B): To Do / In Progress / Done / Missed /
// Deferred — the five statuses a task shows anywhere in V4.
//
// Derived exactly as V3 did (from completed_at and the task's blocks), plus
// an optional explicit override the student can set (status_override:
// 'in_progress' or 'deferred'). Done always wins; a missed block is still
// reported as Missed unless the task was deliberately deferred.
//
// V3 statuses -> V4:
//   done                       -> done
//   missed                     -> missed
//   in_progress, partial       -> in_progress
//   planned, unscheduled,
//   carried_over               -> todo   (still to do)

export const TASK_STATUSES = ['todo', 'in_progress', 'done', 'missed', 'deferred'];
export const SETTABLE_STATUSES = ['todo', 'in_progress', 'deferred']; // done = the checkbox; missed is derived

export function universalStatus(group) {
  if (!group) return 'todo';
  if (group.done) return 'done';
  if (group.statusOverride === 'deferred') return 'deferred';
  if (group.status === 'missed') return 'missed';
  if (group.statusOverride === 'in_progress') return 'in_progress';
  if (group.status === 'in_progress' || group.status === 'partial') return 'in_progress';
  return 'todo';
}

/** What to store for a status picked in the editor (Done is handled by completed_at). */
export function overrideForStatus(status) {
  return status === 'in_progress' || status === 'deferred' ? status : null;
}
