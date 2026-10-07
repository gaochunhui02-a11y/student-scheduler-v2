// V3-L insights aggregations. Run: node tests/insights-v3.test.js

import assert from 'node:assert/strict';
import { studyMinutesByCourse, weeklyCompletion, focusByPeriod, recentSessions, overdueTasks } from '../src/insights/insightsModel.js';

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

const schedules = [{ id: 's1', for_date: '2026-10-05' }, { id: 's2', for_date: '2026-09-28' }, { id: 's3', for_date: '2026-08-01' }];
const items = [
  { schedule_id: 's1', item_type: 'study', start_minutes: 600, end_minutes: 660, completed: true, source_subject_id: 'a' },
  { schedule_id: 's1', item_type: 'study', start_minutes: 700, end_minutes: 760, completed: false, completed_minutes: 30, source_subject_id: 'b' },
  { schedule_id: 's2', item_type: 'study', start_minutes: 600, end_minutes: 720, completed: false, completed_minutes: 0, source_subject_id: 'a' },
  { schedule_id: 's3', item_type: 'study', start_minutes: 600, end_minutes: 720, completed: true, source_subject_id: 'a' },
  { schedule_id: 's1', item_type: 'class', start_minutes: 540, end_minutes: 590 },
];
const subjectCourse = new Map([['a', 'math'], ['b', null]]);

check('study minutes by course only count completed time in the window', () => {
  const r = studyMinutesByCourse({ schedules, items, subjectCourse, from: '2026-09-07', to: '2026-10-07' });
  assert.deepEqual(r, [{ courseId: 'math', minutes: 60 }, { courseId: null, minutes: 30 }]);
});
check('weekly completion: Monday-start weeks, current week last, no fake rates', () => {
  const w = weeklyCompletion({ schedules, items, today: '2026-10-07', weeks: 3 });
  assert.deepEqual(w.map((x) => x.start), ['2026-09-21', '2026-09-28', '2026-10-05']);
  assert.equal(w[2].planned, 120);
  assert.equal(w[2].completed, 90);
  assert.equal(w[1].rate, 0);
  assert.equal(w[0].rate, null);
  assert.equal(w[2].isCurrent, true);
});
check('focus by period needs enough sessions before naming a best time', () => {
  const at = (h) => new Date(2026, 9, 1, h, 0).toISOString();
  const few = [{ started_at: at(9), planned_minutes: 60, actual_minutes: 60, outcome: 'completed' }];
  assert.equal(focusByPeriod(few).enough, false);
  assert.equal(focusByPeriod(few).best, null);
  const many = [
    ...[9, 10, 11].map((h) => ({ started_at: at(h), planned_minutes: 60, actual_minutes: 58, outcome: 'completed' })),
    ...[19, 20, 21].map((h) => ({ started_at: at(h), planned_minutes: 60, actual_minutes: 30, outcome: 'stopped' })),
  ];
  const r = focusByPeriod(many);
  assert.equal(r.enough, true);
  assert.equal(r.best, 'morning');
  assert.equal(r.rows.find((x) => x.period === 'evening').finishRate, 0);
});
check('recent sessions and overdue lists', () => {
  assert.deepEqual(recentSessions([{ started_at: '2026-10-01' }, { started_at: '2026-10-05' }], 1).map((s) => s.started_at), ['2026-10-05']);
  const groups = [{ id: 'x', done: false, dueDate: '2026-10-01' }, { id: 'y', done: true, dueDate: '2026-09-01' }, { id: 'z', done: false, dueDate: '2026-10-09' }];
  assert.deepEqual(overdueTasks(groups, '2026-10-07').map((g) => g.id), ['x']);
});

console.log('\n------------------------');
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
