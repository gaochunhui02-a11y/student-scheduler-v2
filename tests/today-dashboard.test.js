// V4-D Today page model (lists, top three, timeline, quick capture) and the
// customizable dashboard layout.
// Run: node tests/today-dashboard.test.js

import assert from 'node:assert/strict';
import { buildTodayLists, pickTopThree, timelineStates, parseQuickTask, todaySummary, localDay } from '../src/today/todayModel.js';
import {
  WIDGETS, MODE_WIDGETS, normalizeDashboard, resolveDashboard, visibleWidgets, setWidget, moveWidget, isDefaultDashboard,
} from '../src/home/dashboardLayout.js';

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

const TODAY = '2026-10-14';
const g = (id, extra = {}) => ({ id, name: id, done: false, priority: 'medium', dueDate: null, scheduledDate: null, dates: [], startTime: null, ...extra });

console.log('\n=== today lists ===');
const groups = [
  g('planned', { scheduledDate: TODAY, dates: [TODAY] }),
  g('plannedHigh', { scheduledDate: TODAY, dates: [TODAY], priority: 'high', startTime: '15:00' }),
  g('plannedEarly', { scheduledDate: TODAY, dates: [TODAY], startTime: '09:00' }),
  g('dueTodayBacklog', { dueDate: TODAY }),
  g('dueTodayElsewhere', { dueDate: TODAY, scheduledDate: '2026-10-12', dates: ['2026-10-12'] }),
  g('plannedAndDue', { dueDate: TODAY, scheduledDate: TODAY, dates: [TODAY] }),
  g('overdueOld', { dueDate: '2026-10-01' }),
  g('overdueNew', { dueDate: '2026-10-10', scheduledDate: '2026-10-09', dates: ['2026-10-09'] }),
  g('overdueButPlannedToday', { dueDate: '2026-10-12', scheduledDate: TODAY, dates: [TODAY] }),
  g('backlog'),
  g('future', { scheduledDate: '2026-10-20', dates: ['2026-10-20'], dueDate: '2026-10-21' }),
  g('doneToday', { done: true, scheduledDate: TODAY, dates: [TODAY] }),
  g('doneElsewhere', { done: true, completedAt: new Date(2026, 9, 14, 12).toISOString(), scheduledDate: '2026-10-02', dates: ['2026-10-02'] }),
  g('chunkToday', { scheduledDate: '2026-10-13', dates: ['2026-10-13', TODAY] }),
];
const L = buildTodayLists(groups, TODAY);
check('planned = scheduled today (incl. a later chunk), ordered by start time then priority', () => {
  assert.deepEqual(L.scheduled.map((x) => x.id), ['plannedEarly', 'plannedHigh', 'overdueButPlannedToday', 'plannedAndDue', 'chunkToday', 'planned']);
});
check('due today lists only tasks NOT planned today; an unscheduled task is never a today task', () => {
  assert.deepEqual(L.dueOnly.map((x) => x.id).sort(), ['dueTodayBacklog', 'dueTodayElsewhere']);
  assert.ok(!L.scheduled.some((x) => x.id === 'dueTodayBacklog'));
  assert.ok(!L.scheduled.some((x) => x.id === 'backlog'));
});
check('overdue: oldest first, never repeats a task already planned today', () => {
  assert.deepEqual(L.overdue.map((x) => x.id), ['overdueOld', 'overdueNew']);
});
check('done today: done tasks planned today or completed today (local day)', () => {
  assert.deepEqual(L.doneToday.map((x) => x.id), ['doneToday', 'doneElsewhere']);
  assert.equal(localDay(null), null);
  assert.equal(localDay('not a date'), null);
});

console.log('\n=== top three ===');
check('overdue first (oldest), then due today, then high priority, with reasons', () => {
  assert.deepEqual(L.top.map((x) => [x.group.id, x.reason]), [['overdueOld', 'overdue'], ['overdueNew', 'overdue'], ['overdueButPlannedToday', 'overdue']]);
  const calm = buildTodayLists(groups.filter((x) => !x.id.startsWith('overdue')), TODAY);
  assert.deepEqual(calm.top.map((x) => x.reason), ['dueToday', 'dueToday', 'dueToday']);
  const noDue = buildTodayLists([g('a', { scheduledDate: TODAY, dates: [TODAY] }), g('b', { scheduledDate: TODAY, dates: [TODAY], priority: 'high' })], TODAY);
  assert.deepEqual(noDue.top.map((x) => [x.group.id, x.reason]), [['b', 'highPriority'], ['a', 'planned']]);
});
check('blocked tasks are never suggested first; done tasks never appear', () => {
  const blocked = new Map([['overdueOld', { blocked: true }]]);
  const top = pickTopThree({ overdue: [groups[6], groups[7]], scheduled: [g('x', { done: true })] }, TODAY, blocked);
  assert.deepEqual(top.map((x) => x.group.id), ['overdueNew']);
});
check('nothing to do → empty suggestion list', () => {
  assert.deepEqual(buildTodayLists([g('backlog')], TODAY).top, []);
});

console.log('\n=== timeline + summary ===');
check('timeline marks past / now / next / later relative to now', () => {
  const ev = timelineStates([{ start: 900, end: 960 }, { start: 480, end: 540 }, { start: 600, end: 720 }, { start: 1000, end: 1060 }], 630);
  assert.deepEqual(ev.map((e) => [e.start, e.state]), [[480, 'past'], [600, 'now'], [900, 'next'], [1000, 'later']]);
});
check('summary counts planned, due today (planned or not), overdue, study minutes, classes', () => {
  const s = todaySummary(L, [{ kind: 'study', start: 600, end: 660, completed: true }, { kind: 'study', start: 700, end: 730 }, { kind: 'class', start: 540, end: 600 }], TODAY);
  assert.deepEqual(s, { plannedTasks: 6, dueToday: 3, overdue: 2, doneToday: 2, studyPlanned: 90, studyDone: 60, classes: 1 });
});

console.log('\n=== quick capture ===');
check('trailing durations: 45m, 45 min, 1h, 1.5h, 1h30', () => {
  assert.deepEqual(parseQuickTask('Read chapter 4 45m'), { name: 'Read chapter 4', minutes: 45, ok: true });
  assert.equal(parseQuickTask('Lab report 45 min').minutes, 45);
  assert.equal(parseQuickTask('Essay draft 1h').minutes, 60);
  assert.equal(parseQuickTask('Essay draft 1.5h').minutes, 90);
  assert.equal(parseQuickTask('Essay draft 1h30').minutes, 90);
  assert.equal(parseQuickTask('Essay draft 2h 15m').minutes, 135);
});
check('no duration → 30 min; numbers inside the name are kept; limits clamp', () => {
  assert.deepEqual(parseQuickTask('  Call   mom  '), { name: 'Call mom', minutes: 30, ok: true });
  assert.equal(parseQuickTask('Read chapter 4').name, 'Read chapter 4');
  assert.equal(parseQuickTask('Nap 2m').minutes, 5);
  assert.equal(parseQuickTask('Marathon 30h').minutes, 1440);
  assert.equal(parseQuickTask('   ').ok, false);
  assert.equal(parseQuickTask('45m').ok, false); // just a duration, no name
});

console.log('\n=== dashboard layout ===');
check('every mode default uses known widgets; legacy is exactly the V3 dashboard', () => {
  const ids = WIDGETS.map((w) => w.id);
  Object.values(MODE_WIDGETS).forEach((list) => list.forEach((id) => assert.ok(ids.includes(id), id)));
  assert.deepEqual(visibleWidgets(null, 'legacy').map((w) => w.id), ['now', 'progress', 'urgent', 'deadlines', 'exams', 'headsUp', 'overview']);
  assert.deepEqual(visibleWidgets(null, 'personal').map((w) => w.id), ['now', 'top3', 'routines', 'goals', 'urgent', 'deadlines']);
  assert.deepEqual(visibleWidgets(null, 'unknown-mode').map((w) => w.id), MODE_WIDGETS.legacy);
});
check('normalize drops unknown ids and junk; null = never customized', () => {
  assert.equal(normalizeDashboard(null), null);
  assert.equal(normalizeDashboard({ order: 'x' }), null);
  assert.deepEqual(normalizeDashboard({ order: ['now', 'evil', 'now', 'goals'], hidden: ['goals', 'x'] }), { order: ['now', 'goals'], hidden: ['goals'] });
});
check('hide / show / move; hidden widgets keep their place', () => {
  let d = setWidget(null, 'work', 'projects', false);
  assert.ok(!visibleWidgets(d, 'work').some((w) => w.id === 'projects'));
  d = moveWidget(d, 'work', 'goals', 'up');
  const order = resolveDashboard(d, 'work').map((x) => x.id);
  assert.ok(order.indexOf('goals') < order.indexOf('projects'));
  d = setWidget(d, 'work', 'projects', true);
  assert.ok(visibleWidgets(d, 'work').some((w) => w.id === 'projects'));
  assert.deepEqual(moveWidget(d, 'work', resolveDashboard(d, 'work')[0].id, 'up'), d); // already first
});
check('widgets added later appear at the end, switched off', () => {
  const d = { order: ['now', 'urgent'], hidden: [] };
  const r = resolveDashboard(d, 'school');
  assert.deepEqual(r.slice(0, 2), [{ id: 'now', on: true }, { id: 'urgent', on: true }]);
  assert.ok(r.slice(2).every((x) => !x.on));
  assert.equal(r.length, WIDGETS.length);
});
check('availability filter skips widgets without their feature; default detection', () => {
  const vis = visibleWidgets(null, 'multiple', (w) => w.needs !== 'goals').map((w) => w.id);
  assert.ok(!vis.includes('goals'));
  assert.ok(vis.includes('routines'));
  assert.equal(isDefaultDashboard(null, 'work'), true);
  assert.equal(isDefaultDashboard(setWidget(null, 'work', 'now', false), 'work'), false);
  assert.equal(isDefaultDashboard(setWidget(setWidget(null, 'work', 'now', false), 'work', 'now', true), 'work'), true);
});

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
