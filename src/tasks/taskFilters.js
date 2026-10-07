// Pure task filtering for the Tasks page (split out of tasksPage.js in
// V4-B.1 so it can be tested without the data layer).

import { addDays, diffDays, startOfWeek } from '../shared/dates.js';
import { matchesSpace, effectiveSpaceId } from '../workspace/spacesModel.js';

// V4-B.1: 'unscheduled' = the backlog (no planned day yet).
export const VIEWS = ['today', 'upcoming', 'unscheduled', 'overdue', 'open', 'done'];

// Which due-date bucket a task falls into.
export function dueBucket(group, today) {
  if (group.done) return 'done';
  if (!group.dueDate) return 'noDate';
  const d = diffDays(today, group.dueDate);
  if (d < 0) return 'overdue';
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (group.dueDate <= addDays(startOfWeek(today), 6)) return 'thisWeek';
  if (d <= 14) return 'nextTwoWeeks';
  return 'later';
}
export const BUCKET_ORDER = ['overdue', 'today', 'tomorrow', 'thisWeek', 'nextTwoWeeks', 'later', 'noDate', 'done'];

export function filterTaskGroups(groups, filters, today, courseById = new Map(), projectById = new Map()) {
  const q = (filters.search || '').trim().toLowerCase();
  return groups.filter((g) => {
    // V4: the sidebar's space switcher (a task inherits its project's, then its course's space).
    if (filters.space && !matchesSpace(effectiveSpaceId(g, courseById, projectById), filters.space)) return false;
    if (filters.project === '__none' && g.projectId) return false;
    if (filters.project && filters.project !== '__none' && g.projectId !== filters.project) return false;
    if (filters.view === 'done' && !g.done) return false;
    if (filters.view !== 'done' && g.done) return false;
    if (filters.view === 'today' && !(g.dueDate === today || g.dates.includes(today) || g.overdue)) return false;
    if (filters.view === 'overdue' && !g.overdue) return false;
    if (filters.view === 'unscheduled' && g.scheduledDate) return false;
    if (filters.view === 'upcoming' && !(g.dueDate && g.dueDate > today && g.dueDate <= addDays(today, 14))) return false;
    if (filters.course === '__none' && g.courseId) return false;
    if (filters.course && filters.course !== '__none' && g.courseId !== filters.course) return false;
    if (filters.tag && !g.tags.includes(filters.tag)) return false;
    if (filters.priority && g.priority !== filters.priority) return false;
    if (q) {
      const course = courseById.get(g.courseId);
      const project = projectById.get(g.projectId);
      const hay = [g.name, g.notes, ...(g.tags || []), course ? course.name : '', course ? course.code : '', project ? project.title : ''].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
