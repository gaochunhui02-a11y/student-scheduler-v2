// Goals (V4-C), pure — no DOM, no Supabase.
//
// A goal is a longer-term outcome ("Get an internship", "Read 12 books",
// "Run a 10 km race"). Its progress is ONE number, chosen per goal:
//   auto    (default) — linked tasks + goal milestones (each done one counts
//                       once) + linked projects (each counts as its own
//                       progress fraction), over all of them
//   numeric           — check-ins from start_value to target_value;
//                       aggregate 'sum' adds every check-in, 'latest' uses
//                       the most recent one. Works for falling targets too
//                       ("weigh 70 kg" from 76).
//   manual            — the student's own percentage
// An Achieved goal shows 100% in auto mode.

export const GOAL_STATUSES = ['active', 'on_hold', 'achieved', 'archived'];
export const GOAL_PROGRESS_MODES = ['auto', 'numeric', 'manual'];
export const GOAL_LIMITS = { title: 120, description: 5000, unit: 24, milestoneTitle: 120, note: 500, value: 1e9 };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export function validateGoalFields(input = {}) {
  const errors = {};
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) errors.title = 'goals.errTitle';
  else if (title.length > GOAL_LIMITS.title) errors.title = 'goals.errTitleLong';
  const description = typeof input.description === 'string' ? input.description.slice(0, GOAL_LIMITS.description) : '';
  const status = GOAL_STATUSES.includes(input.status) ? input.status : 'active';
  const start = DATE.test(input.start_date || '') ? input.start_date : null;
  const target = DATE.test(input.target_date || '') ? input.target_date : null;
  if (start && target && target < start) errors.target_date = 'goals.errDates';
  const mode = GOAL_PROGRESS_MODES.includes(input.progress_mode) ? input.progress_mode : 'auto';
  let startValue = 0;
  let targetValue = null;
  let unit = '';
  let aggregate = 'sum';
  let manual = null;
  if (mode === 'numeric') {
    const s = num(input.start_value);
    const tv = num(input.target_value);
    if (Number.isNaN(s) || (s !== null && Math.abs(s) > GOAL_LIMITS.value)) errors.start_value = 'goals.errValue';
    else startValue = s === null ? 0 : s;
    if (tv === null || Number.isNaN(tv) || Math.abs(tv) > GOAL_LIMITS.value) errors.target_value = 'goals.errTarget';
    else if (!errors.start_value && tv === startValue) errors.target_value = 'goals.errTargetSame';
    else targetValue = tv;
    unit = typeof input.unit === 'string' ? input.unit.trim().slice(0, GOAL_LIMITS.unit) : '';
    aggregate = input.aggregate === 'latest' ? 'latest' : 'sum';
  } else if (mode === 'manual') {
    const n = Math.round(Number(input.manual_progress));
    if (input.manual_progress === '' || input.manual_progress === null || !Number.isFinite(n) || n < 0 || n > 100) errors.manual_progress = 'goals.errProgress';
    else manual = n;
  }
  return {
    ok: Object.keys(errors).length === 0,
    errors,
    fields: {
      title, description, status, start_date: start, target_date: target, progress_mode: mode,
      start_value: startValue, target_value: targetValue, unit, aggregate, manual_progress: manual,
      space_id: input.space_id || null,
    },
  };
}

export function validateGoalMilestoneFields(input = {}) {
  const errors = {};
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) errors.title = 'goals.errMilestoneTitle';
  else if (title.length > GOAL_LIMITS.milestoneTitle) errors.title = 'goals.errTitleLong';
  return { ok: !errors.title, errors, fields: { title, due_date: DATE.test(input.due_date || '') ? input.due_date : null } };
}

export function validateCheckIn(input = {}, today) {
  const errors = {};
  const v = num(input.value);
  if (v === null || Number.isNaN(v) || Math.abs(v) > GOAL_LIMITS.value) errors.value = 'goals.errCheckIn';
  const date = DATE.test(input.logged_on || '') ? input.logged_on : today;
  if (date > today) errors.logged_on = 'goals.errFutureCheckIn';
  return {
    ok: Object.keys(errors).length === 0,
    errors,
    fields: { value: Number.isNaN(v) ? null : v, logged_on: date, note: typeof input.note === 'string' ? input.note.trim().slice(0, GOAL_LIMITS.note) : '' },
  };
}

/** Check-ins oldest first (by day, then creation time). */
export function sortLogs(logs = []) {
  return logs.slice().sort((a, b) => String(a.logged_on).localeCompare(String(b.logged_on)) || String(a.created_at || '').localeCompare(String(b.created_at || '')));
}

/** Current measured value of a numeric goal. */
export function currentValue(goal, logs = []) {
  const start = Number(goal && goal.start_value) || 0;
  if (!logs.length) return start;
  if (goal && goal.aggregate === 'latest') return Number(sortLogs(logs).at(-1).value);
  return logs.reduce((s, l) => s + Number(l.value || 0), start);
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const round = (x) => Math.round(x * 1000) / 1000;

/**
 * @param {object} goal
 * @param {{ tasks?: Array, projects?: Array<{percent:number}>, milestones?: Array, logs?: Array }} linked
 *   tasks: task groups linked to the goal (taskModel); projects: linked
 *   projects with their computed percent; milestones: this goal's milestones.
 */
export function computeGoalProgress(goal, { tasks = [], projects = [], milestones = [], logs = [] } = {}) {
  const mode = GOAL_PROGRESS_MODES.includes(goal && goal.progress_mode) ? goal.progress_mode : 'auto';
  const tasksDone = tasks.filter((g) => g.done).length;
  const milestonesDone = milestones.filter((m) => m.status === 'done').length;
  const projectsDone = projects.filter((p) => p.percent >= 100).length;
  let fraction;
  let value = null;
  if (mode === 'manual') fraction = clamp01((Number(goal.manual_progress) || 0) / 100);
  else if (mode === 'numeric') {
    value = round(currentValue(goal, logs));
    const start = Number(goal.start_value) || 0;
    const target = Number(goal.target_value);
    fraction = Number.isFinite(target) && target !== start ? clamp01((value - start) / (target - start)) : 0;
  } else if (goal && goal.status === 'achieved') fraction = 1;
  else {
    const total = tasks.length + milestones.length + projects.length;
    const done = tasksDone + milestonesDone + projects.reduce((s, p) => s + clamp01((Number(p.percent) || 0) / 100), 0);
    fraction = total ? done / total : 0;
  }
  return {
    mode,
    fraction,
    percent: Math.round(fraction * 100),
    value,
    tasksDone, tasksTotal: tasks.length,
    milestonesDone, milestonesTotal: milestones.length,
    projectsDone, projectsTotal: projects.length,
    checkIns: logs.length,
    empty: mode === 'auto' && tasks.length + milestones.length + projects.length === 0,
  };
}

/**
 * Pace against the calendar, only when the goal has both dates and is open:
 *   ahead / on_track / behind (more than 10 points behind the straight line)
 *   / overdue (target date passed). null = nothing to compare with.
 */
export function goalPace(goal, progress, today) {
  if (!goal || !goal.target_date || ['achieved', 'archived'].includes(goal.status)) return null;
  if (progress && progress.fraction >= 1) return null;
  if (goal.target_date < today) return { state: 'overdue', expected: 1 };
  if (!goal.start_date || goal.start_date >= goal.target_date || today < goal.start_date) return null;
  if (progress && progress.empty) return null;
  const span = Date.parse(`${goal.target_date}T00:00:00Z`) - Date.parse(`${goal.start_date}T00:00:00Z`);
  const elapsed = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${goal.start_date}T00:00:00Z`);
  const expected = clamp01(elapsed / span);
  const actual = progress ? progress.fraction : 0;
  const state = actual >= expected + 0.1 ? 'ahead' : actual >= expected - 0.1 ? 'on_track' : 'behind';
  return { state, expected: round(expected) };
}

export function nextGoalMilestone(milestones = []) {
  const open = milestones.filter((m) => m.status !== 'done');
  const dated = open.filter((m) => m.due_date).sort((a, b) => a.due_date.localeCompare(b.due_date));
  return dated[0] || open.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))[0] || null;
}

/**
 * @param {Array} goals
 * @param {{ view?: 'active'|'all'|'achieved'|'archived', search?: string }} f
 * @param {(g) => boolean} [spaceMatch]
 */
export function filterGoals(goals = [], f = {}, spaceMatch = () => true) {
  const q = (f.search || '').trim().toLowerCase();
  const view = f.view || 'active';
  return goals.filter((g) => {
    if (view === 'active' && !['active', 'on_hold'].includes(g.status)) return false;
    if (view === 'achieved' && g.status !== 'achieved') return false;
    if (view === 'archived' && g.status !== 'archived') return false;
    if (view === 'all' && g.status === 'archived') return false;
    if (!spaceMatch(g)) return false;
    if (q && !`${g.title} ${g.description || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

const STATUS_ORDER = { active: 0, on_hold: 1, achieved: 2, archived: 3 };
/** Active first, then by target date (undated last), then title. */
export function sortGoals(goals = []) {
  return goals.slice().sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
    || String(a.target_date || '9999').localeCompare(String(b.target_date || '9999'))
    || (a.sort_order || 0) - (b.sort_order || 0)
    || String(a.title).localeCompare(String(b.title)));
}

/** "12.5" / "3" — trims float noise for display. */
export function formatValue(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '';
  const n = Math.round(Number(v) * 100) / 100;
  return String(n);
}
