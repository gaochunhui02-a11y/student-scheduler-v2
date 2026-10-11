// V4-F productivity intelligence: planned vs actual, the weekly review
// aggregates and stored reflections, and the priority matrix.
// Run: node tests/review-matrix.test.js

import assert from 'node:assert/strict';
import {
  weekBounds, plannedVsActual, plannedVsActualBy, weekTasks, weekMilestones, weekGoalCheckIns,
  normalizeReviews, withReview, reviewDue, REVIEW_KEEP,
} from '../src/review/reviewModel.js';
import { quadrantOf, buildMatrix, priorityForMove, isUrgent, QUADRANTS } from '../src/tasks/priorityMatrix.js';

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

const TODAY = '2026-10-14'; // Wednesday
const local = (date, h = 10) => new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), h).toISOString();

console.log('\n=== weeks ===');
check('weeks run Monday to Sunday', () => {
  assert.deepEqual(weekBounds(TODAY), { start: '2026-10-12', end: '2026-10-18' });
  assert.deepEqual(weekBounds('2026-10-18'), { start: '2026-10-12', end: '2026-10-18' });
  assert.deepEqual(weekBounds('2026-10-19'), { start: '2026-10-19', end: '2026-10-25' });
});

console.log('\n=== planned vs actual ===');
const schedules = [{ id: 'm', for_date: '2026-10-12' }, { id: 't', for_date: '2026-10-13' }, { id: 'x', for_date: '2026-10-05' }];
const items = [
  { schedule_id: 'm', item_type: 'study', start_minutes: 600, end_minutes: 660, completed: true, source_subject_id: 's1' },
  { schedule_id: 'm', item_type: 'study', start_minutes: 700, end_minutes: 760, completed: false, completed_minutes: 20, source_subject_id: 's2' },
  { schedule_id: 't', item_type: 'study', start_minutes: 600, end_minutes: 690, completed: false, completed_minutes: 0, source_subject_id: 's1' },
  { schedule_id: 't', item_type: 'class', start_minutes: 480, end_minutes: 540 },
  { schedule_id: 'x', item_type: 'study', start_minutes: 600, end_minutes: 660, completed: true, source_subject_id: 's1' },
];
const sessions = [
  { started_at: local('2026-10-12'), actual_minutes: 50 },
  { started_at: local('2026-10-13', 21), actual_minutes: 25 },
  { started_at: local('2026-10-01'), actual_minutes: 99 },
];
check('per day: planned = study blocks, done = completed (partial counts), focus = sessions; classes ignored', () => {
  const r = plannedVsActual({ schedules, items, sessions, from: '2026-10-12', to: '2026-10-18' });
  assert.equal(r.days.length, 7);
  assert.deepEqual([r.days[0].planned, r.days[0].done, r.days[0].focus], [120, 80, 50]);
  assert.deepEqual([r.days[1].planned, r.days[1].done, r.days[1].focus], [90, 0, 25]);
  assert.equal(r.days[2].rate, null); // nothing planned → no rate, not 0%
  assert.deepEqual([r.planned, r.done, r.focus], [210, 80, 75]);
  assert.equal(Math.round(r.rate * 100), 38);
});
check('nothing planned at all → rate null', () => {
  assert.equal(plannedVsActual({ from: '2026-10-12', to: '2026-10-18' }).rate, null);
});
check('by area groups block minutes through the task → course/project key', () => {
  const area = plannedVsActualBy({ schedules, items, from: '2026-10-12', to: '2026-10-18', keyOf: (sid) => ({ s1: 'math' }[sid] || null) });
  assert.deepEqual(area.map((x) => [x.key, x.planned, x.done]), [['math', 150, 60], [null, 60, 20]]);
});

console.log('\n=== week contents ===');
const groups = [
  { id: 'a', name: 'A', done: true, completedAt: local('2026-10-13'), dueDate: '2026-10-13' },
  { id: 'b', name: 'B', done: true, completedAt: local('2026-10-05'), dueDate: null },
  { id: 'c', name: 'C', done: false, dueDate: '2026-10-12' },
  { id: 'd', name: 'D', done: false, dueDate: TODAY },
  { id: 'e', name: 'E', done: false, dueDate: '2026-10-16' },
];
check('completed = marked done in the week; slipped = due in the week before today and still open', () => {
  const w = weekTasks(groups, '2026-10-12', '2026-10-18', TODAY);
  assert.deepEqual(w.completed.map((g) => g.id), ['a']);
  assert.deepEqual(w.slipped.map((g) => g.id), ['c']); // due today isn't slipped yet; future isn't
  const past = weekTasks(groups, '2026-10-05', '2026-10-11', TODAY);
  assert.deepEqual(past.completed.map((g) => g.id), ['b']);
});
check('milestones completed in the week; goal check-ins summed (sum) or latest (latest)', () => {
  const ms = weekMilestones([{ status: 'done', completed_at: local('2026-10-13') }, { status: 'done', completed_at: local('2026-10-01') }, { status: 'open', completed_at: local('2026-10-13') }], '2026-10-12', '2026-10-18');
  assert.equal(ms.length, 1);
  const goals = [{ id: 'g1', aggregate: 'sum', unit: 'books' }, { id: 'g2', aggregate: 'latest', unit: 'km' }, { id: 'g3', aggregate: 'sum' }];
  const logs = [
    { goal_id: 'g1', logged_on: '2026-10-12', value: 1 }, { goal_id: 'g1', logged_on: '2026-10-14', value: 2 }, { goal_id: 'g1', logged_on: '2026-10-01', value: 5 },
    { goal_id: 'g2', logged_on: '2026-10-12', value: 5 }, { goal_id: 'g2', logged_on: '2026-10-14', value: 5.5 },
  ];
  const r = weekGoalCheckIns(goals, logs, '2026-10-12', '2026-10-18');
  assert.deepEqual(r.map((x) => [x.goal.id, x.count, x.change, x.latest]), [['g1', 2, 3, 2], ['g2', 2, null, 5.5]]);
});

console.log('\n=== reflections ===');
check('stored reviews are cleaned, clamped and capped at 26 weeks', () => {
  const raw = { '2026-10-12': { well: 'x'.repeat(2000), blocked: 5, focus: 'Midterm', doneAt: 'nope' }, junk: { well: 'a' }, '2026-10-05': 'str' };
  const n = normalizeReviews(raw);
  assert.deepEqual(Object.keys(n), ['2026-10-12']);
  assert.equal(n['2026-10-12'].well.length, 1000);
  assert.equal(n['2026-10-12'].blocked, '');
  assert.equal(n['2026-10-12'].doneAt, null);
  const many = {};
  for (let i = 0; i < 40; i += 1) many[`2026-${String(1 + Math.floor(i / 4)).padStart(2, '0')}-${String(1 + (i % 4) * 7).padStart(2, '0')}`] = { well: String(i) };
  assert.equal(Object.keys(normalizeReviews(many)).length, REVIEW_KEEP);
  assert.equal(normalizeReviews(null) && Object.keys(normalizeReviews(null)).length, 0);
});
check('saving keeps other weeks and the first "reviewed" time; a draft keeps doneAt unset', () => {
  let r = withReview({}, '2026-10-05', { well: 'old' }, '2026-10-11T10:00:00.000Z');
  r = withReview(r, '2026-10-12', { well: 'Good', blocked: '', focus: 'Rest' });
  assert.equal(r['2026-10-05'].well, 'old');
  assert.equal(r['2026-10-12'].doneAt, null);
  r = withReview(r, '2026-10-12', { well: 'Better' }, '2026-10-17T10:00:00.000Z');
  assert.equal(r['2026-10-12'].doneAt, '2026-10-17T10:00:00.000Z');
  assert.equal(r['2026-10-12'].focus, 'Rest'); // untouched field kept
  r = withReview(r, '2026-10-12', { well: 'Edited' }, '2026-10-18T10:00:00.000Z');
  assert.equal(r['2026-10-12'].doneAt, '2026-10-17T10:00:00.000Z');
});
check('a review is due Friday–Sunday until the week is marked reviewed', () => {
  assert.equal(reviewDue({}, TODAY), false);
  assert.equal(reviewDue({}, '2026-10-16'), true);
  assert.equal(reviewDue({}, '2026-10-18'), true);
  assert.equal(reviewDue({ '2026-10-12': { doneAt: '2026-10-16T10:00:00.000Z' } }, '2026-10-17'), false);
});

console.log('\n=== priority matrix ===');
const g = (id, priority, dueDate, extra = {}) => ({ id, name: id, priority, dueDate, done: false, remainingMinutes: 30, ...extra });
check('urgent = overdue or due within 2 days; important = high priority', () => {
  assert.equal(isUrgent(g('x', 'low', '2026-10-16'), TODAY), true);
  assert.equal(isUrgent(g('x', 'low', '2026-10-17'), TODAY), false);
  assert.equal(isUrgent(g('x', 'low', '2026-10-01'), TODAY), true);
  assert.equal(isUrgent(g('x', 'low', null), TODAY), false);
  assert.equal(quadrantOf(g('a', 'high', TODAY), TODAY), 'do');
  assert.equal(quadrantOf(g('b', 'high', '2026-11-01'), TODAY), 'plan');
  assert.equal(quadrantOf(g('c', 'medium', '2026-10-15'), TODAY), 'quick');
  assert.equal(quadrantOf(g('d', 'low', null), TODAY), 'later');
});
check('matrix: open tasks only, sorted by due date, minutes summed per quadrant', () => {
  const m = buildMatrix([g('a2', 'high', '2026-10-15'), g('a1', 'high', TODAY), g('z', 'high', TODAY, { done: true }), g('d', 'low', null, { remainingMinutes: 45 })], TODAY);
  assert.deepEqual(QUADRANTS, ['do', 'plan', 'quick', 'later']);
  assert.deepEqual(m.do.tasks.map((x) => x.id), ['a1', 'a2']);
  assert.equal(m.do.minutes, 60);
  assert.equal(m.later.minutes, 45);
  assert.equal(m.plan.tasks.length, 0);
});
check('moving rows changes priority high ↔ medium; no-op when already there', () => {
  assert.equal(priorityForMove(g('a', 'low', null), true), 'high');
  assert.equal(priorityForMove(g('a', 'high', null), true), null);
  assert.equal(priorityForMove(g('a', 'high', null), false), 'medium');
  assert.equal(priorityForMove(g('a', 'low', null), false), null);
});

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
