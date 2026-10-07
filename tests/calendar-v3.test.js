// V3-M calendar events, overlap layout and drop validation.
// Run: node tests/calendar-v3.test.js

import assert from 'node:assert/strict';
import { buildCalendarEvents, filterEvents, layoutDay, validateDrop } from '../src/calendar/calendarEvents.js';

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

const input = {
  from: '2026-10-05',
  to: '2026-10-11',
  schedules: [{ id: 's7', for_date: '2026-10-07' }, { id: 's8', for_date: '2026-10-08' }],
  items: [
    { id: 'i1', schedule_id: 's7', item_type: 'class', name: 'Chem', start_minutes: 780, end_minutes: 855 },
    { id: 'i2', schedule_id: 's7', item_type: 'class', name: 'Dentist', start_minutes: 1020, end_minutes: 1050 },
    { id: 'i3', schedule_id: 's7', item_type: 'study', name: 'Essay', start_minutes: 900, end_minutes: 960, source_subject_id: 'sub1', locked: true },
    { id: 'i4', schedule_id: 's7', item_type: 'meal', name: 'Lunch', start_minutes: 735, end_minutes: 780 },
  ],
  classes: [
    { id: 'c1', schedule_id: 's7', name: 'Dentist', start_time: '17:00:00', end_time: '17:30:00', source: 'imported' },
    { id: 'c2', schedule_id: 's8', name: 'Office hours', start_time: '10:00:00', end_time: '10:30:00', source: 'manual', course_id: 'math' },
  ],
  series: [{ id: 'ser', name: 'Calc', days_of_week: [1, 3, 5], start_time: '09:00', end_time: '09:50', start_date: '2026-09-01', end_date: '2026-12-01', course_id: 'math' }],
  exceptions: [{ series_id: 'ser', exception_date: '2026-10-09', action: 'skip' }],
  subjects: [{ id: 'sub1', course_id: 'hist' }],
  groups: [{ id: 'g1', name: 'Essay', dueDate: '2026-10-09', rowIds: ['sub1'], courseId: 'hist', done: false }],
  exams: [{ id: 'e1', name: 'Midterm', exam_date: '2026-10-10', start_time: '09:00:00', duration_minutes: 90 }, { id: 'e2', name: 'Quiz', exam_date: '2026-10-11', start_time: null }],
  courses: [{ id: 'math', color: '#3b6fe0' }, { id: 'hist', color: '#d9466b' }],
};
const events = buildCalendarEvents(input);
const on = (d) => events.filter((e) => e.date === d);

console.log('\n=== calendar events ===');
check('generated days use their class blocks; imported ones are external', () => {
  const wed = on('2026-10-07');
  assert.equal(wed.find((e) => e.title === 'Chem').kind, 'class');
  assert.equal(wed.find((e) => e.title === 'Dentist').kind, 'external');
  assert.ok(!wed.some((e) => e.title === 'Calc')); // generated day: no duplicate projection
  assert.ok(!wed.some((e) => e.title === 'Lunch')); // meals aren't calendar events
});
check('days not generated project recurring classes and one-off classes', () => {
  assert.ok(on('2026-10-05').some((e) => e.title === 'Calc' && e.color === '#3b6fe0'));
  assert.ok(on('2026-10-08').some((e) => e.title === 'Office hours'));
  assert.ok(!on('2026-10-09').some((e) => e.title === 'Calc')); // skipped occurrence
});
check('study blocks carry status and course colour', () => {
  const s = on('2026-10-07').find((e) => e.kind === 'study');
  assert.equal(s.locked, true);
  assert.equal(s.color, '#d9466b');
  assert.equal(s.itemId, 'i3');
});
check('deadlines are all-day; exams timed when a start is known', () => {
  assert.equal(on('2026-10-09').find((e) => e.kind === 'deadline').allDay, true);
  const mid = on('2026-10-10').find((e) => e.kind === 'exam');
  assert.equal(mid.allDay, false);
  assert.equal(mid.end - mid.start, 90);
  assert.equal(on('2026-10-11').find((e) => e.kind === 'exam').allDay, true);
});
check('filters by kind', () => {
  assert.ok(filterEvents(events, ['exam']).every((e) => e.kind === 'exam'));
  assert.equal(filterEvents(events, []).length, 0);
});

console.log('\n=== layout + drop validation ===');
check('overlapping events get side-by-side columns', () => {
  const laid = layoutDay([
    { id: 'a', start: 600, end: 660 }, { id: 'b', start: 630, end: 700 }, { id: 'c', start: 720, end: 780 }, { id: 'd', allDay: true },
  ]);
  const byId = Object.fromEntries(laid.map((e) => [e.id, e]));
  assert.equal(byId.a.cols, 2);
  assert.notEqual(byId.a.col, byId.b.col);
  assert.equal(byId.c.cols, 1);
  assert.equal(byId.d, undefined);
});
check('drops are checked against the past, due date, the day and other events', () => {
  const base = { today: '2026-10-07', window: { start: 420, end: 1350 } };
  assert.equal(validateDrop({ ...base, date: '2026-10-06', start: 600, end: 660 }).key, 'calendar3.dropPast');
  assert.equal(validateDrop({ ...base, date: '2026-10-10', start: 600, end: 660, dueDate: '2026-10-09' }).key, 'calendar3.dropPastDue');
  assert.equal(validateDrop({ ...base, date: '2026-10-08', start: 400, end: 460 }).key, 'calendar3.dropOutsideDay');
  assert.equal(validateDrop({ ...base, date: '2026-10-08', start: 600, end: 660, others: [{ title: 'Chem', start: 630, end: 700 }] }).params.name, 'Chem');
  assert.equal(validateDrop({ ...base, date: '2026-10-08', start: 600, end: 660, others: [{ title: 'X', start: 660, end: 700 }] }), null);
});

console.log('\n------------------------');
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
