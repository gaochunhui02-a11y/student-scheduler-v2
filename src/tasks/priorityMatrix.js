// Priority matrix (V4-F), pure. An Eisenhower-style view of OPEN tasks:
//
//              urgent                    not urgent
//   important  do      (do it now)       plan   (give it a day)
//   other      quick   (keep it short)   later  (or drop it)
//
// Both axes come from fields the student already sets, so the placement is
// always explainable:
//   urgent     overdue, or due within URGENT_DAYS days (today counts)
//   important  priority = high
// Moving a task between rows changes its priority (high ↔ medium); the
// columns follow the due date and can't be dragged.

import { diffDays } from '../shared/dates.js';

export const QUADRANTS = ['do', 'plan', 'quick', 'later'];
export const URGENT_DAYS = 2;

export function isUrgent(group, today, urgentDays = URGENT_DAYS) {
  if (!group || group.done || !group.dueDate) return false;
  return diffDays(today, group.dueDate) <= urgentDays;
}

export function isImportant(group) {
  return Boolean(group) && group.priority === 'high';
}

export function quadrantOf(group, today, urgentDays = URGENT_DAYS) {
  const u = isUrgent(group, today, urgentDays);
  const i = isImportant(group);
  if (u && i) return 'do';
  if (i) return 'plan';
  if (u) return 'quick';
  return 'later';
}

/**
 * @returns {Object<string, { tasks: Array, minutes: number }>} open tasks per quadrant,
 *   each sorted by due date (undated last), then name
 */
export function buildMatrix(groups = [], today, urgentDays = URGENT_DAYS) {
  const out = Object.fromEntries(QUADRANTS.map((q) => [q, { tasks: [], minutes: 0 }]));
  groups.filter((g) => !g.done).forEach((g) => {
    const q = out[quadrantOf(g, today, urgentDays)];
    q.tasks.push(g);
    q.minutes += g.remainingMinutes || 0;
  });
  QUADRANTS.forEach((q) => out[q].tasks.sort((a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')) || String(a.name).localeCompare(String(b.name))));
  return out;
}

/** The priority to save when a task is moved to the other row (null = no change). */
export function priorityForMove(group, toImportant) {
  if (toImportant) return group.priority === 'high' ? null : 'high';
  return group.priority === 'high' ? 'medium' : null;
}
