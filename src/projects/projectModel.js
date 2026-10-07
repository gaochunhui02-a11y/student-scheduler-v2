// Projects (V4-B), pure — no DOM, no Supabase.
//
// Progress has ONE number, chosen per project:
//   auto   (default) — completed tasks + completed milestones, each counting
//                      once, over all of them. "6 / 14 tasks · 2 / 3
//                      milestones" is always shown beside it.
//   manual           — the student sets the percentage; the counts are still
//                      shown, as counts, never as a second percentage.
// A project marked Completed shows 100% in auto mode.

export const PROJECT_STATUSES = ['planned', 'active', 'on_hold', 'completed', 'archived'];
export const PROJECT_PRIORITIES = ['high', 'medium', 'low'];
export const PROJECT_LIMITS = { title: 120, description: 5000, milestoneTitle: 120, milestoneDescription: 2000 };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateProjectFields(input = {}) {
  const errors = {};
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) errors.title = 'projects.errTitle';
  else if (title.length > PROJECT_LIMITS.title) errors.title = 'projects.errTitleLong';
  const description = typeof input.description === 'string' ? input.description.slice(0, PROJECT_LIMITS.description) : '';
  const status = PROJECT_STATUSES.includes(input.status) ? input.status : 'active';
  const priority = PROJECT_PRIORITIES.includes(input.priority) ? input.priority : 'medium';
  const start = DATE.test(input.start_date || '') ? input.start_date : null;
  const due = DATE.test(input.due_date || '') ? input.due_date : null;
  if (start && due && due < start) errors.due_date = 'projects.errDates';
  let estimated = null;
  if (input.estimated_minutes !== '' && input.estimated_minutes !== null && input.estimated_minutes !== undefined) {
    const n = Math.round(Number(input.estimated_minutes));
    if (!Number.isFinite(n) || n <= 0 || n > 1000000) errors.estimated_minutes = 'projects.errEstimate';
    else estimated = n;
  }
  const progressMode = input.progress_mode === 'manual' ? 'manual' : 'auto';
  let manual = null;
  if (progressMode === 'manual') {
    const n = Math.round(Number(input.manual_progress));
    if (!Number.isFinite(n) || n < 0 || n > 100) errors.manual_progress = 'projects.errProgress';
    else manual = n;
  }
  return {
    ok: Object.keys(errors).length === 0,
    errors,
    fields: {
      title, description, status, priority, start_date: start, due_date: due,
      estimated_minutes: estimated, progress_mode: progressMode, manual_progress: manual,
      space_id: input.space_id || null,
    },
  };
}

export function validateMilestoneFields(input = {}) {
  const errors = {};
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) errors.title = 'projects.errMilestoneTitle';
  else if (title.length > PROJECT_LIMITS.milestoneTitle) errors.title = 'projects.errTitleLong';
  return {
    ok: Object.keys(errors).length === 0,
    errors,
    fields: {
      title,
      description: typeof input.description === 'string' ? input.description.slice(0, PROJECT_LIMITS.milestoneDescription) : '',
      due_date: DATE.test(input.due_date || '') ? input.due_date : null,
    },
  };
}

/** Upcoming open milestone: earliest dated one, else the first undated one. */
export function nextMilestone(milestones = []) {
  const open = milestones.filter((m) => m.status !== 'done');
  const dated = open.filter((m) => m.due_date).sort((a, b) => a.due_date.localeCompare(b.due_date));
  return dated[0] || open.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))[0] || null;
}

/**
 * @param {object} project
 * @param {Array} groups      task groups of this project (taskModel)
 * @param {Array} milestones  this project's milestones
 */
export function computeProjectProgress(project, groups = [], milestones = []) {
  const tasksTotal = groups.length;
  const tasksDone = groups.filter((g) => g.done).length;
  const milestonesTotal = milestones.length;
  const milestonesDone = milestones.filter((m) => m.status === 'done').length;
  const mode = project && project.progress_mode === 'manual' ? 'manual' : 'auto';
  let percent;
  if (mode === 'manual') percent = Math.max(0, Math.min(100, Math.round(Number(project.manual_progress) || 0)));
  else if (project && project.status === 'completed') percent = 100;
  else {
    const total = tasksTotal + milestonesTotal;
    percent = total ? Math.round(((tasksDone + milestonesDone) / total) * 100) : 0;
  }
  const remainingMinutes = groups.filter((g) => !g.done).reduce((s, g) => s + (g.remainingMinutes || 0), 0);
  const plannedMinutes = groups.reduce((s, g) => s + (g.requestedMinutes || 0), 0);
  const actualMinutes = groups.reduce((s, g) => s + (Number.isFinite(g.actualMinutes) && g.actualMinutes !== null ? g.actualMinutes : (g.completedMinutes || 0)), 0);
  return {
    mode, percent, tasksDone, tasksTotal, milestonesDone, milestonesTotal,
    remainingMinutes, plannedMinutes, actualMinutes,
    estimatedMinutes: project && project.estimated_minutes ? project.estimated_minutes : plannedMinutes || null,
    next: nextMilestone(milestones),
    empty: tasksTotal + milestonesTotal === 0,
  };
}

/** "Due in 3 days" style urgency for a project. */
export function projectDueState(project, today) {
  if (!project || !project.due_date || ['completed', 'archived'].includes(project.status)) return null;
  if (project.due_date < today) return 'overdue';
  const ms = Date.parse(`${project.due_date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
  return ms / 86400000 <= 7 ? 'soon' : 'later';
}

/**
 * @param {Array} projects
 * @param {{ view?: 'open'|'all'|'completed'|'archived', status?: string, search?: string, space?: string|null }} f
 * @param {(p) => boolean} [spaceMatch]  space filter predicate (spacesModel.matchesSpace)
 */
export function filterProjects(projects = [], f = {}, spaceMatch = () => true) {
  const q = (f.search || '').trim().toLowerCase();
  const view = f.view || 'open';
  return projects.filter((p) => {
    if (view === 'open' && ['completed', 'archived'].includes(p.status)) return false;
    if (view === 'completed' && p.status !== 'completed') return false;
    if (view === 'archived' && p.status !== 'archived') return false;
    if (view === 'all' && p.status === 'archived') return false;
    if (f.status && p.status !== f.status) return false;
    if (!spaceMatch(p)) return false;
    if (q && !`${p.title} ${p.description || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

const STATUS_ORDER = { active: 0, planned: 1, on_hold: 2, completed: 3, archived: 4 };
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
/** Active first, then by due date (undated last), priority, title. */
export function sortProjects(projects = []) {
  return projects.slice().sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
    || String(a.due_date || '9999').localeCompare(String(b.due_date || '9999'))
    || (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1)
    || String(a.title).localeCompare(String(b.title)));
}

/** Tasks inside a project: open first (by project_sort, then due date), done last. */
export function sortProjectTasks(groups = []) {
  return groups.slice().sort((a, b) => Number(a.done) - Number(b.done)
    || (a.projectSort || 0) - (b.projectSort || 0)
    || String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999'))
    || String(a.name).localeCompare(String(b.name)));
}

/** New project_sort values after moving one task up/down among the open ones. */
export function reorderProjectTasks(groups, taskId, direction) {
  const open = sortProjectTasks(groups).filter((g) => !g.done);
  const i = open.findIndex((g) => g.id === taskId);
  const j = i + (direction === 'up' ? -1 : 1);
  if (i < 0 || j < 0 || j >= open.length) return [];
  const order = open.slice();
  [order[i], order[j]] = [order[j], order[i]];
  return order.map((g, idx) => ({ id: g.id, project_sort: (idx + 1) * 10 })).filter((u, idx) => (open[idx].projectSort || 0) !== u.project_sort || open[idx].id !== u.id);
}
