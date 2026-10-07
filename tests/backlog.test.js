// V4-B.1 unscheduled (backlog) tasks. Run: node tests/backlog.test.js

import assert from 'node:assert/strict';
import { buildTaskGroups } from '../src/tasks/taskModel.js';
import { isUnscheduled, isScheduledOn, isDueOn, isOverdue, splitForDay } from '../src/tasks/taskDates.js';
import { planBacklog, freeDaysFromForecast } from '../src/planner/backlogPlanner.js';
import { computeProjectProgress } from '../src/projects/projectModel.js';
import { filterTaskGroups, dueBucket } from '../src/tasks/taskFilters.js';
import { validateTaskSchedule } from '../src/tasks/taskModel.js';
import { buildWorkloadForecast } from '../src/workload/workloadModel.js';

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

const today = '2026-10-07';
// Rows as the data layer returns them: unscheduled rows have schedule_id null and no for_date.
const rows = [
  { id: 'v3', name: 'Calc homework (V3, scheduled today)', minutes_requested: 60, course_id: 'C', schedule_id: 'S1', for_date: today, due_date: '2026-10-09' },
  { id: 'gen', name: 'Read Deep Work', minutes_requested: 60, schedule_id: null, for_date: null },
  { id: 'proj', name: 'Rewrite About page', minutes_requested: 45, project_id: 'P', schedule_id: null, for_date: null, due_date: '2026-10-30' },
  { id: 'dueToday', name: 'Submit form', minutes_requested: 15, schedule_id: null, for_date: null, due_date: today },
  { id: 'late', name: 'Late reflection', minutes_requested: 30, schedule_id: null, for_date: null, due_date: '2026-10-01' },
  { id: 'later', name: 'Draft slides', minutes_requested: 40, project_id: 'P', schedule_id: 'S9', for_date: '2026-10-12' },
];
const groups = buildTaskGroups(rows, [], { today, nowMinutes: 600 });
const g = (id) => groups.find((x) => x.id === id);

console.log('\n=== date concepts ===');
check('generic task with no scheduled date and no due date', () => {
  assert.equal(isUnscheduled(g('gen')), true);
  assert.equal(g('gen').dueDate, null);
  assert.equal(g('gen').scheduledDate, null);
  assert.equal(g('gen').status, 'unscheduled');
});
check('project task with a due date but no scheduled date', () => {
  assert.equal(isUnscheduled(g('proj')), true);
  assert.equal(g('proj').projectId, 'P');
  assert.equal(g('proj').dueDate, '2026-10-30');
});
check('an existing V3 scheduled task works as before', () => {
  assert.equal(g('v3').scheduledDate, today);
  assert.equal(isUnscheduled(g('v3')), false);
  assert.equal(isScheduledOn(g('v3'), today), true);
  assert.equal(g('v3').firstDate, today);
});
check('an unscheduled task is never "scheduled today" — even when it is due today', () => {
  assert.equal(isScheduledOn(g('dueToday'), today), false);
  assert.equal(isDueOn(g('dueToday'), today), true);
  const { scheduled, dueOnly } = splitForDay(groups, today);
  assert.deepEqual(scheduled.map((x) => x.id), ['v3']);
  assert.deepEqual(dueOnly.map((x) => x.id), ['dueToday']);
});
check('overdue depends only on the due date, scheduled or not', () => {
  assert.equal(isOverdue(g('late'), today), true);
  assert.equal(g('late').overdue, true);
  assert.equal(isOverdue(g('gen'), today), false);
  assert.equal(isOverdue({ ...g('late'), done: true }, today), false);
  assert.equal(dueBucket(g('late'), today), 'overdue');
});

console.log('\n=== Tasks page views ===');
check('Unscheduled view shows backlog tasks only; Today does not count them as scheduled', () => {
  const ids = (view) => filterTaskGroups(groups, { view }, today).map((x) => x.id).sort();
  assert.deepEqual(ids('unscheduled'), ['dueToday', 'gen', 'late', 'proj']);
  // Today = scheduled today, due today, or overdue (the V3 meaning); the backlog
  // task due today is there because it is DUE, not because it is scheduled.
  assert.deepEqual(ids('today'), ['dueToday', 'late', 'v3']);
  assert.ok(!ids('today').includes('gen'));
});

console.log('\n=== scheduling later ===');
check('an unscheduled task can later be scheduled (it then counts as planned that day)', () => {
  const moved = rows.map((r) => (r.id === 'gen' ? { ...r, schedule_id: 'S5', for_date: '2026-10-10', planned_by: 'planner' } : r));
  const g2 = buildTaskGroups(moved, [], { today }).find((x) => x.id === 'gen');
  assert.equal(g2.scheduledDate, '2026-10-10');
  assert.equal(g2.plannedBy, 'planner');
  assert.equal(isScheduledOn(g2, '2026-10-10'), true);
});
check('project progress counts unscheduled project tasks like any other', () => {
  const p = computeProjectProgress({ status: 'active' }, groups.filter((x) => x.projectId === 'P'), []);
  assert.equal(p.tasksTotal, 2);
  assert.equal(p.tasksDone, 0);
  const done = groups.filter((x) => x.projectId === 'P').map((x) => (x.id === 'proj' ? { ...x, done: true } : x));
  assert.equal(computeProjectProgress({ status: 'active' }, done, []).percent, 50);
});

console.log('\n=== start time needs a scheduled date ===');
check('a start time without a scheduled date is an error — today is never invented', () => {
  assert.deepEqual(validateTaskSchedule({ planDate: '', startTime: '14:00' }), { ok: false, error: 'tasks.errStartNeedsDate', planDate: null });
  assert.deepEqual(validateTaskSchedule({ planDate: '', startTime: '' }), { ok: true, error: null, planDate: null });
  assert.deepEqual(validateTaskSchedule({ planDate: '2026-10-20', startTime: '14:00' }), { ok: true, error: null, planDate: '2026-10-20' });
  assert.deepEqual(validateTaskSchedule({ planDate: 'garbage', startTime: '' }), { ok: true, error: null, planDate: null });
});

console.log('\n=== Plan my backlog ===');
const days = [
  { date: '2026-10-07', free: 30 },
  { date: '2026-10-08', free: 120 },
  { date: '2026-10-09', free: 0 },
  { date: '2026-10-10', free: 240 },
];
check('earliest deadline first, each task on the first day with room before its due date', () => {
  const r = planBacklog({
    today,
    days,
    tasks: [
      { id: 'a', name: 'No due', minutes: 60 },
      { id: 'b', name: 'Due 9th', minutes: 90, dueDate: '2026-10-09' },
      { id: 'c', name: 'Due 8th', minutes: 20, dueDate: '2026-10-08' },
    ],
  });
  const byId = Object.fromEntries(r.assignments.map((x) => [x.taskId, x]));
  assert.equal(byId.c.date, '2026-10-07'); // fits in today's 30
  assert.equal(byId.b.date, '2026-10-08'); // 90 of 120
  assert.equal(byId.a.date, '2026-10-10'); // 8th has 30 left, 9th full
  assert.equal(r.unplaced.length, 0);
});
check('too big for any single day before the deadline: the roomiest day, marked tight', () => {
  const r = planBacklog({ today, days, tasks: [{ id: 'x', name: 'Huge', minutes: 200, dueDate: '2026-10-09' }] });
  assert.deepEqual(r.assignments.map((a) => [a.date, a.tight]), [['2026-10-08', true]]);
});
check('no room at all before the deadline: left unscheduled for the student to decide', () => {
  const r = planBacklog({ today, days: [{ date: '2026-10-07', free: 0 }, { date: '2026-10-08', free: 0 }], tasks: [{ id: 'x', name: 'X', minutes: 30, dueDate: '2026-10-08' }] });
  assert.equal(r.assignments.length, 0);
  assert.deepEqual(r.unplaced.map((u) => u.reason), ['no_room']);
});
check('overdue tasks go to the first day with room from today on', () => {
  const r = planBacklog({ today, days, tasks: [{ id: 'o', name: 'Overdue', minutes: 60, dueDate: '2026-10-01' }] });
  assert.equal(r.assignments[0].date, '2026-10-08');
});
check('deterministic: same input, same plan', () => {
  const tasks = [{ id: 'p', name: 'P', minutes: 30, priority: 'low' }, { id: 'q', name: 'Q', minutes: 30, priority: 'high' }];
  const one = planBacklog({ today, days, tasks });
  const two = planBacklog({ today, days, tasks: tasks.slice().reverse() });
  assert.deepEqual(one, two);
  assert.equal(one.assignments[0].taskId, 'q'); // high priority first
});
check('free time comes from the workload forecast (planned study is taken, backlog is not)', () => {
  const fc = buildWorkloadForecast({
    today, days: 3, dailyMax: 180,
    schedules: [{ id: 'S1', for_date: today }],
    subjects: [{ id: 's', schedule_id: 'S1', name: 'Planned', minutes_requested: 60 }],
    groups,
  });
  const free = freeDaysFromForecast(fc);
  assert.equal(free[0].free, 120);
  assert.equal(free[1].free, 180);
});

console.log('\n------------------------');
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
