// Task date concepts (V4-B.1), pure. Kept strictly separate:
//
//   due date        — when the task must be finished      (group.dueDate)
//   scheduled date  — the day the student plans to work on it
//                     (the task's schedule; NULL = unscheduled / backlog)
//   start time      — optional time on the scheduled day  (group.startTime)
//
// Any combination is valid: due + unscheduled, neither, scheduled + due,
// scheduled without a due date. Overdue depends only on the due date.
//
// The V4 Today page must use isScheduledOn() for "today's tasks" and
// isDueOn() for a separate "Due today" list — an unscheduled task is never
// a today task just because it is due today.

/** No day chosen yet (backlog). */
export function isUnscheduled(group) {
  return Boolean(group) && !group.scheduledDate;
}

/** Planned on that day (its own day, or a later part of a multi-day task). */
export function isScheduledOn(group, date) {
  if (!group || !date) return false;
  if (group.scheduledDate === date) return true;
  return Array.isArray(group.dates) && group.dates.includes(date);
}

export function isDueOn(group, date) {
  return Boolean(group && date && group.dueDate === date && !group.done);
}

/** Past its due date and not done — whether or not it was ever scheduled. */
export function isOverdue(group, today) {
  return Boolean(group && !group.done && group.dueDate && today && group.dueDate < today);
}

/** For the future Today page: what's planned today vs. due today (no overlap). */
export function splitForDay(groups = [], date) {
  const scheduled = groups.filter((g) => !g.done && isScheduledOn(g, date));
  const ids = new Set(scheduled.map((g) => g.id));
  const dueOnly = groups.filter((g) => isDueOn(g, date) && !ids.has(g.id));
  return { scheduled, dueOnly };
}
