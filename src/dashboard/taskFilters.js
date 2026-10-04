// Pure, DOM-free, Supabase-free filtering/search for the Study Tasks panel
// (V2-A). Never mutates the task list or reorders stored data — every
// function here takes a plain task array and returns a NEW, possibly
// smaller array for display only, exactly like src/dashboard/smartPriority.js's
// sortTasksForDisplay already does for sorting. Reuses daysUntilDue from
// smartPriority.js rather than a second "days until due" implementation.

import { daysUntilDue } from './smartPriority.js';

export const FILTER_MODES = ['all', 'today', 'upcoming', 'overdue', 'completed'];

// The task shape every function below expects (a superset of
// smartPriority.js's task shape): { id, name, priority, dueDate,
// remainingMinutes, completed, notes, tags }. `tags` defaults to [] when
// absent so a pre-V2-A task (no tags column read yet) never breaks a tag
// filter — it just never matches one.
function taskTags(task) {
  return Array.isArray(task?.tags) ? task.tags : [];
}

export function matchesFilterMode(task, mode, todayDateStr) {
  if (!task) return false;
  if (mode === 'all' || !mode) return true;
  if (mode === 'completed') return task.completed === true;
  // Every other mode is about ACTIONABLE work — a completed task never
  // shows up under Today/Upcoming/Overdue, the same exclusion
  // computeTaskScore already applies to recommendations.
  if (task.completed) return false;
  const days = daysUntilDue(task.dueDate, todayDateStr);
  if (mode === 'overdue') return days !== null && days < 0;
  if (mode === 'today') return days === 0;
  if (mode === 'upcoming') return days !== null && days > 0;
  return true;
}

export function matchesPriorityFilter(task, priority) {
  return !priority || task.priority === priority;
}

export function matchesTagFilter(task, tag) {
  return !tag || taskTags(task).includes(tag);
}

// "Subject" in this app's data model IS the task's own name (study_subjects
// has no separate subject-grouping field — see analyticsModel.js's
// computeSubjectTotals, which already groups by name the same way), so
// filtering by subject is filtering by exact name.
export function matchesSubjectFilter(task, subjectName) {
  return !subjectName || task.name === subjectName;
}

export function matchesSearchQuery(task, query) {
  const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (!q) return true;
  const haystacks = [task.name, task.notes, ...taskTags(task)].filter((v) => typeof v === 'string');
  return haystacks.some((v) => v.toLowerCase().includes(q));
}

// Every distinct task name present, sorted, for populating the Subject
// filter's options — deliberately simple (no fuzzy grouping) since name IS
// the subject here.
export function listDistinctSubjectNames(tasks) {
  const names = new Set((tasks || []).map((t) => t?.name).filter((n) => typeof n === 'string' && n));
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

// Every distinct tag present across all tasks, sorted, for populating the
// Tag filter's options.
export function listDistinctTags(tasks) {
  const tags = new Set();
  (tasks || []).forEach((t) => taskTags(t).forEach((tag) => tags.add(tag)));
  return Array.from(tags).sort((a, b) => a.localeCompare(b));
}

// `filters`: { mode, priority, tag, subjectName, query } — every key
// optional; an absent/falsy key means "no constraint from this filter."
// Returns a NEW array; the input is never mutated or reordered beyond the
// filtering itself (display order among matches is preserved).
export function filterTasks(tasks, filters = {}, todayDateStr) {
  const { mode, priority, tag, subjectName, query } = filters;
  return (tasks || []).filter(
    (task) =>
      matchesFilterMode(task, mode, todayDateStr) &&
      matchesPriorityFilter(task, priority) &&
      matchesTagFilter(task, tag) &&
      matchesSubjectFilter(task, subjectName) &&
      matchesSearchQuery(task, query)
  );
}
