// V3-P offline snapshot + exam reminders. Run: node tests/offline-reminders.test.js

import assert from 'node:assert/strict';
import { buildOfflineSnapshot, isValidSnapshot } from '../src/offline/offlineSnapshot.js';
import { examReminderStage, examReminderKey } from '../src/notifications/examReminders.js';

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

console.log('\n=== offline snapshot ===');
const d = {
  today: '2026-10-07',
  courses: [{ id: 'c1', name: 'Calculus', code: 'MATH 1', color: '#3b6fe0', notes: 'private notes' }, { id: 'c2', name: 'Bad', color: 'red;}' }],
  groups: [
    { name: 'Later', dueDate: '2026-10-20', done: false, remainingMinutes: 60, courseId: 'c1', notes: 'x' },
    { name: 'Done', dueDate: '2026-10-08', done: true, remainingMinutes: 0 },
    { name: 'Soon', dueDate: '2026-10-08', done: false, remainingMinutes: 30, courseId: 'ghost' },
    { name: 'No date', dueDate: null, done: false, remainingMinutes: 15 },
  ],
  todayEvents: [{ kind: 'study', title: 'B', start: 600, end: 660, completed: true, courseId: 'c1' }, { kind: 'class', title: 'A', start: 540, end: 600 }],
  exams: [{ name: 'Old', exam_date: '2026-09-01' }, { name: 'Mid', exam_date: '2026-10-15', course_id: 'c1' }],
};
const snap = buildOfflineSnapshot(d, '2026-10-07T08:00:00.000Z');
check('keeps only what the read-only view needs', () => {
  assert.equal(isValidSnapshot(snap), true);
  assert.deepEqual(snap.tasks.map((x) => x.name), ['Soon', 'Later', 'No date']);
  assert.deepEqual(snap.timeline.map((x) => x.title), ['A', 'B']);
  assert.deepEqual(snap.exams.map((x) => x.name), ['Mid']);
  assert.equal('notes' in snap.courses[0], false);
  assert.equal('notes' in snap.tasks[1], false);
});
check('unsafe colours and unknown course ids are dropped', () => {
  assert.equal(snap.courses[1].color, null);
  assert.equal(snap.tasks[0].courseId, null);
});
check('corrupted stored values are rejected', () => {
  assert.equal(isValidSnapshot(null), false);
  assert.equal(isValidSnapshot({ v: 1, savedAt: 'x', date: 'nope', timeline: [], tasks: [], courses: [], exams: [] }), false);
  assert.equal(isValidSnapshot({ ...snap, tasks: 'x' }), false);
});

console.log('\n=== exam reminders ===');
check('fires 3 days before, the day before and the day of only', () => {
  assert.equal(examReminderStage('2026-10-10', '2026-10-07'), 'in3');
  assert.equal(examReminderStage('2026-10-09', '2026-10-07'), null);
  assert.equal(examReminderStage('2026-10-08', '2026-10-07'), 'tomorrow');
  assert.equal(examReminderStage('2026-10-07', '2026-10-07'), 'today');
  assert.equal(examReminderStage('2026-10-06', '2026-10-07'), null);
  assert.equal(examReminderStage(null, '2026-10-07'), null);
});
check('works across month and DST boundaries (date-only math)', () => {
  assert.equal(examReminderStage('2026-11-01', '2026-10-31'), 'tomorrow');
  assert.equal(examReminderStage('2026-03-09', '2026-03-08'), 'tomorrow');
  assert.equal(examReminderStage('2027-01-01', '2026-12-29'), 'in3');
});
check('a rescheduled exam gets fresh reminders', () => {
  assert.notEqual(examReminderKey('e1', 'tomorrow', '2026-10-08'), examReminderKey('e1', 'tomorrow', '2026-10-09'));
});

console.log('\n------------------------');
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
