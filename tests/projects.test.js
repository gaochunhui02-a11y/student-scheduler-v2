// V4-B projects, milestones, progress and universal task status.
// Run: node tests/projects.test.js

import assert from 'node:assert/strict';
import {
  validateProjectFields, validateMilestoneFields, computeProjectProgress, nextMilestone, filterProjects,
  sortProjects, sortProjectTasks, reorderProjectTasks, projectDueState, PROJECT_STATUSES,
} from '../src/projects/projectModel.js';
import { universalStatus, overrideForStatus, TASK_STATUSES } from '../src/tasks/universalStatus.js';
import { buildTaskGroups } from '../src/tasks/taskModel.js';
import { generateSchedule } from '../src/dashboard/scheduler.js';
import { matchesSpace, effectiveSpaceId } from '../src/workspace/spacesModel.js';

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${label}`);
    console.log(`        ${e.message}`);
  }
}

console.log('\n=== project fields ===');
check('a valid project is cleaned; defaults are active / medium / auto', () => {
  const v = validateProjectFields({ title: '  Build Portfolio ', start_date: '2026-10-01', due_date: '2026-11-30', estimated_minutes: '600' });
  assert.equal(v.ok, true);
  assert.deepEqual(v.fields, { title: 'Build Portfolio', description: '', status: 'active', priority: 'medium', start_date: '2026-10-01', due_date: '2026-11-30', estimated_minutes: 600, progress_mode: 'auto', manual_progress: null, space_id: null });
  assert.deepEqual(PROJECT_STATUSES, ['planned', 'active', 'on_hold', 'completed', 'archived']);
});
check('missing title, inverted dates, bad estimate and bad manual progress are caught', () => {
  assert.equal(validateProjectFields({ title: ' ' }).errors.title, 'projects.errTitle');
  assert.equal(validateProjectFields({ title: 'x'.repeat(121) }).errors.title, 'projects.errTitleLong');
  assert.equal(validateProjectFields({ title: 'x', start_date: '2026-12-01', due_date: '2026-11-01' }).errors.due_date, 'projects.errDates');
  assert.equal(validateProjectFields({ title: 'x', estimated_minutes: '-5' }).errors.estimated_minutes, 'projects.errEstimate');
  assert.equal(validateProjectFields({ title: 'x', progress_mode: 'manual', manual_progress: '130' }).errors.manual_progress, 'projects.errProgress');
  assert.equal(validateProjectFields({ title: 'x', status: 'done', priority: 'urgent' }).fields.status, 'active');
});
check('milestones need a title; dates are optional', () => {
  assert.equal(validateMilestoneFields({ title: '' }).errors.title, 'projects.errMilestoneTitle');
  assert.deepEqual(validateMilestoneFields({ title: ' Prototype ', due_date: 'soon' }).fields, { title: 'Prototype', description: '', due_date: null });
});

console.log('\n=== progress ===');
const groups = [
  { id: 't1', done: true, requestedMinutes: 60, completedMinutes: 60, actualMinutes: 75, remainingMinutes: 0 },
  { id: 't2', done: true, requestedMinutes: 30, completedMinutes: 30, actualMinutes: null, remainingMinutes: 0 },
  { id: 't3', done: false, requestedMinutes: 90, completedMinutes: 0, actualMinutes: null, remainingMinutes: 90 },
  { id: 't4', done: false, requestedMinutes: 45, completedMinutes: 15, actualMinutes: null, remainingMinutes: 30 },
];
const milestones = [
  { id: 'm1', status: 'done', due_date: '2026-10-10' },
  { id: 'm2', status: 'open', due_date: '2026-10-25', title: 'Prototype' },
  { id: 'm3', status: 'open', due_date: null, title: 'Launch' },
];
check('auto progress counts tasks and milestones once each: (2 + 1) / (4 + 3) = 43%', () => {
  const p = computeProjectProgress({ progress_mode: 'auto', status: 'active' }, groups, milestones);
  assert.equal(p.percent, 43);
  assert.deepEqual([p.tasksDone, p.tasksTotal, p.milestonesDone, p.milestonesTotal], [2, 4, 1, 3]);
  assert.equal(p.next.title, 'Prototype');
  assert.equal(p.remainingMinutes, 120);
  assert.equal(p.plannedMinutes, 225);
  assert.equal(p.actualMinutes, 75 + 30 + 0 + 15);
});
check('manual progress is the one number shown; counts stay counts', () => {
  const p = computeProjectProgress({ progress_mode: 'manual', manual_progress: 80, status: 'active' }, groups, milestones);
  assert.equal(p.percent, 80);
  assert.equal(p.mode, 'manual');
  assert.equal(p.tasksDone, 2);
});
check('a Completed project shows 100% (auto); an empty project shows 0%', () => {
  assert.equal(computeProjectProgress({ status: 'completed' }, groups, milestones).percent, 100);
  const e = computeProjectProgress({ status: 'active' }, [], []);
  assert.equal(e.percent, 0);
  assert.equal(e.empty, true);
});
check('project estimate falls back to the sum of its tasks', () => {
  assert.equal(computeProjectProgress({ estimated_minutes: 600 }, groups, []).estimatedMinutes, 600);
  assert.equal(computeProjectProgress({}, groups, []).estimatedMinutes, 225);
});
check('next milestone: earliest dated open one, else the first undated', () => {
  assert.equal(nextMilestone([{ status: 'open', title: 'B', due_date: null, sort_order: 1 }, { status: 'open', title: 'A', due_date: null, sort_order: 0 }]).title, 'A');
  assert.equal(nextMilestone([{ status: 'done', due_date: '2026-01-01' }]), null);
});

console.log('\n=== list ===');
const projects = [
  { id: 'a', title: 'Apply for jobs', status: 'active', priority: 'high', due_date: '2026-11-01', space_id: 'W' },
  { id: 'b', title: 'JLPT N3', status: 'planned', priority: 'medium', due_date: null, space_id: 'L' },
  { id: 'c', title: 'Move to Tokyo', status: 'on_hold', priority: 'low', due_date: '2026-10-20', space_id: null },
  { id: 'd', title: 'Research paper', status: 'completed', priority: 'high', due_date: '2026-09-01', space_id: 'S' },
  { id: 'e', title: 'Old blog', status: 'archived', priority: 'low', due_date: null, space_id: null },
];
check('views: open hides completed/archived; all hides only archived; archived shows only archived', () => {
  assert.deepEqual(filterProjects(projects, { view: 'open' }).map((p) => p.id), ['a', 'b', 'c']);
  assert.deepEqual(filterProjects(projects, { view: 'all' }).map((p) => p.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(filterProjects(projects, { view: 'completed' }).map((p) => p.id), ['d']);
  assert.deepEqual(filterProjects(projects, { view: 'archived' }).map((p) => p.id), ['e']);
});
check('search and space filters combine', () => {
  assert.deepEqual(filterProjects(projects, { view: 'all', search: 'tokyo' }).map((p) => p.id), ['c']);
  const inWork = (p) => matchesSpace(p.space_id || null, 'W');
  assert.deepEqual(filterProjects(projects, { view: 'all' }, inWork).map((p) => p.id), ['a']);
  const noSpace = (p) => matchesSpace(p.space_id || null, '__none');
  assert.deepEqual(filterProjects(projects, { view: 'all' }, noSpace).map((p) => p.id), ['c']);
});
check('sorting: active first, then by due date and priority', () => {
  assert.deepEqual(sortProjects(projects).map((p) => p.id), ['a', 'b', 'c', 'd', 'e']);
});
check('due state', () => {
  assert.equal(projectDueState(projects[0], '2026-11-05'), 'overdue');
  assert.equal(projectDueState(projects[0], '2026-10-28'), 'soon');
  assert.equal(projectDueState(projects[3], '2026-10-01'), null);
});

console.log('\n=== project tasks ===');
const pt = [
  { id: 'x', name: 'Write copy', done: false, projectSort: 20, dueDate: null },
  { id: 'y', name: 'Design', done: false, projectSort: 10, dueDate: '2026-10-20' },
  { id: 'z', name: 'Kickoff', done: true, projectSort: 0, dueDate: null },
];
check('open tasks in project order, done last', () => {
  assert.deepEqual(sortProjectTasks(pt).map((g) => g.id), ['y', 'x', 'z']);
});
check('moving a task down swaps it with the next open one', () => {
  const updates = reorderProjectTasks(pt, 'y', 'down');
  const byId = Object.fromEntries(updates.map((u) => [u.id, u.project_sort]));
  assert.ok(byId.x < byId.y);
  assert.deepEqual(reorderProjectTasks(pt, 'y', 'up'), []); // already first
});

console.log('\n=== universal status ===');
check('five statuses, derived like V3 plus an explicit override', () => {
  assert.deepEqual(TASK_STATUSES, ['todo', 'in_progress', 'done', 'missed', 'deferred']);
  assert.equal(universalStatus({ done: true, statusOverride: 'deferred' }), 'done');
  assert.equal(universalStatus({ status: 'missed' }), 'missed');
  assert.equal(universalStatus({ status: 'missed', statusOverride: 'deferred' }), 'deferred');
  assert.equal(universalStatus({ status: 'partial' }), 'in_progress');
  assert.equal(universalStatus({ status: 'in_progress' }), 'in_progress');
  assert.equal(universalStatus({ status: 'unscheduled', statusOverride: 'in_progress' }), 'in_progress');
  ['planned', 'unscheduled', 'carried_over'].forEach((s) => assert.equal(universalStatus({ status: s }), 'todo'));
  assert.equal(overrideForStatus('todo'), null);
  assert.equal(overrideForStatus('deferred'), 'deferred');
  assert.equal(overrideForStatus('done'), null);
});

console.log('\n=== V3 tasks and project tasks share one model ===');
const rows = [
  { id: 'r1', name: 'Calc homework', minutes_requested: 60, course_id: 'C', for_date: '2026-10-07', schedule_id: 'S1' },
  { id: 'r2', name: 'Homepage', minutes_requested: 90, project_id: 'P', project_milestone_id: 'M', due_time: '23:59:00', start_time: '14:00:00', status_override: 'deferred', project_sort: 30, for_date: '2026-10-07', schedule_id: 'S1' },
  { id: 'r3', name: 'Groceries', minutes_requested: 20, for_date: '2026-10-07', schedule_id: 'S1' },
];
const built = buildTaskGroups(rows, [], { today: '2026-10-07', nowMinutes: 600 });
check('a V3 academic task keeps V3 behaviour (V4 fields null)', () => {
  const g = built.find((x) => x.id === 'r1');
  assert.equal(g.courseId, 'C');
  assert.deepEqual([g.projectId, g.milestoneId, g.dueTime, g.startTime, g.statusOverride, g.projectSort], [null, null, null, null, null, 0]);
  assert.equal(universalStatus(g), 'todo');
});
check('a project task without a course carries its project fields', () => {
  const g = built.find((x) => x.id === 'r2');
  assert.deepEqual([g.courseId, g.projectId, g.milestoneId, g.dueTime, g.startTime, g.projectSort], [null, 'P', 'M', '23:59', '14:00', 30]);
  assert.equal(universalStatus(g), 'deferred');
});
check('a generic task (no course, project or space) is a normal task', () => {
  const g = built.find((x) => x.id === 'r3');
  assert.equal(g.courseId, null);
  assert.equal(effectiveSpaceId(g, new Map()), null);
  assert.equal(universalStatus(g), 'todo');
});
check('the Planner schedules a project task with no course like any other', () => {
  const r = generateSchedule({
    wakeTime: '08:00', sleepTime: '22:00', classes: [], meals: [{ name: 'Breakfast', duration: 30, on: false, time: '08:00' }, { name: 'Lunch', duration: 45, on: false, time: '12:00' }, { name: 'Dinner', duration: 45, on: false, time: '18:00' }],
    subjects: built.filter((g) => !g.done).map((g) => ({ name: g.name, minutes: g.requestedMinutes, priority: g.priority, dueDate: g.dueDate })),
    prefs: { sessionCap: 60, staminaBreak: 15, switchBreak: 10, minNewBlock: 30 },
  });
  assert.equal(r.error, undefined);
  const studied = r.events.filter((e) => e.type === 'study').map((e) => e.name);
  assert.ok(studied.includes('Homepage'), JSON.stringify(studied));
  assert.ok(studied.includes('Calc homework'));
  assert.ok(studied.includes('Groceries'));
});

console.log('\n------------------------');
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
