// V4-G academic tools: attendance sessions, rate and "absences you can
// still afford", and the deterministic assignment breakdown.
// Run: node tests/academic-v4.test.js

import assert from 'node:assert/strict';
import { sessionsForCourse, summarizeAttendance, toggleStatus, absencesAllowed, validateAttendance, MIN_RATE } from '../src/attendance/attendanceModel.js';
import { buildBreakdown, suggestTemplate, canReuseOriginal, BREAKDOWN_TEMPLATES, TEMPLATE_IDS } from '../src/tasks/breakdownModel.js';

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

console.log('\n=== attendance sessions ===');
const series = [
  { id: 's1', course_id: 'c1', name: 'Lecture', days_of_week: [1, 3], start_time: '09:00:00', end_time: '09:50:00', start_date: '2026-10-05', end_date: '2026-12-18' },
  { id: 's2', course_id: 'c1', name: 'Lab', days_of_week: [3], start_time: '14:00', end_time: '16:00', start_date: '2026-10-05', end_date: '2026-12-18' },
  { id: 's3', course_id: 'other', name: 'Other', days_of_week: [1, 2, 3], start_time: '10:00', end_time: '11:00', start_date: '2026-10-05', end_date: '2026-12-18' },
];
const exceptions = [
  { series_id: 's1', exception_date: '2026-10-07', action: 'skip' },
  { series_id: 's1', exception_date: '2026-10-12', action: 'modify', override_start_time: '10:00', override_end_time: '10:50', override_name: 'Lecture (moved)' },
];
const oneOffs = [{ course_id: 'c1', date: '2026-10-09', start_time: '15:00', end_time: '16:00', name: 'Review session' }, { course_id: 'c1', date: '2026-10-12', start_time: '10:00', end_time: '10:50', name: 'Duplicate of moved lecture' }];
const sessions = sessionsForCourse({ courseId: 'c1', series, exceptions, oneOffs, from: '2026-10-05', to: TODAY });
check('recurring + one-off sessions of one course; skips removed, moved times applied, duplicates merged', () => {
  assert.deepEqual(sessions.map((s) => `${s.date} ${s.start} ${s.name}`), [
    '2026-10-05 540 Lecture',
    '2026-10-07 840 Lab',
    '2026-10-09 900 Review session',
    '2026-10-12 600 Lecture (moved)',
    '2026-10-14 540 Lecture',
    '2026-10-14 840 Lab',
  ]);
});

console.log('\n=== attendance rate ===');
const rec = (date, start, status) => ({ id: `${date}${start}`, attended_on: date, start_minutes: start, status });
check('held = started sessions; rate = (present + late) / (marked − excused); unmarked never count as absent', () => {
  const records = [rec('2026-10-05', 540, 'present'), rec('2026-10-07', 840, 'late'), rec('2026-10-09', 900, 'absent'), rec('2026-10-12', 600, 'excused')];
  const s = summarizeAttendance(sessions, records, TODAY, 10 * 60); // 10:00 — morning lecture held, lab not yet
  assert.equal(s.held, 5);
  assert.deepEqual([s.present, s.late, s.absent, s.excused, s.unmarked, s.marked], [1, 1, 1, 1, 1, 4]);
  assert.equal(Math.round(s.rate * 100), 67); // 2 / 3
  assert.equal(s.state, 'risk');
  assert.equal(s.list.at(-1).status, null); // today's lecture unmarked
});
check('nothing marked → no rate and no state; states at 90% and 80%', () => {
  const none = summarizeAttendance(sessions, [], TODAY);
  assert.equal(none.rate, null);
  assert.equal(none.state, null);
  const ten = Array.from({ length: 10 }, (_, i) => ({ date: `2026-09-${String(10 + i).padStart(2, '0')}`, start: 540 }));
  const mk = (absent) => ten.map((x, i) => rec(x.date, 540, i < absent ? 'absent' : 'present'));
  assert.equal(summarizeAttendance(ten, mk(0), TODAY).state, 'good');
  assert.equal(summarizeAttendance(ten, mk(1), TODAY).state, 'good'); // 90%
  assert.equal(summarizeAttendance(ten, mk(2), TODAY).state, 'warning'); // 80%
  assert.equal(summarizeAttendance(ten, mk(3), TODAY).state, 'risk');
  assert.equal(MIN_RATE, 0.8);
});
check('absences you can still afford at 80%', () => {
  const ten = Array.from({ length: 10 }, (_, i) => ({ date: `2026-09-${String(10 + i).padStart(2, '0')}`, start: 540 }));
  const all = summarizeAttendance(ten, ten.map((x) => rec(x.date, 540, 'present')), TODAY);
  assert.equal(absencesAllowed(all), 2); // 10 / 12 = 83%, 10 / 13 = 77%
  const two = summarizeAttendance(ten, ten.map((x, i) => rec(x.date, 540, i < 2 ? 'absent' : 'present')), TODAY);
  assert.equal(absencesAllowed(two), 0);
  const three = summarizeAttendance(ten, ten.map((x, i) => rec(x.date, 540, i < 3 ? 'absent' : 'present')), TODAY);
  assert.ok(absencesAllowed(three) < 0);
  assert.equal(absencesAllowed(summarizeAttendance(ten, [], TODAY)), null);
});
check('pressing the same status again clears it; records are validated', () => {
  assert.equal(toggleStatus('present', 'present'), null);
  assert.equal(toggleStatus(null, 'late'), 'late');
  assert.equal(toggleStatus('absent', 'present'), 'present');
  assert.equal(validateAttendance({ course_id: 'c', attended_on: TODAY, start_minutes: 540, status: 'present' }).ok, true);
  assert.equal(validateAttendance({ course_id: 'c', attended_on: TODAY, start_minutes: 1440, status: 'present' }).ok, false);
  assert.equal(validateAttendance({ course_id: 'c', attended_on: TODAY, start_minutes: 540, status: 'skipped' }).ok, false);
  assert.equal(validateAttendance({ attended_on: TODAY, start_minutes: 540, status: 'present' }).ok, false);
});

console.log('\n=== breakdown ===');
check('every template shares sum to 1', () => {
  TEMPLATE_IDS.forEach((id) => assert.equal(Math.round(BREAKDOWN_TEMPLATES[id].reduce((s, [, x]) => s + x, 0) * 1000), 1000, id));
});
check('minutes add up exactly to the task, rounded to 5', () => {
  [37, 60, 125, 300, 1].forEach((total) => {
    const steps = buildBreakdown({ totalMinutes: total, today: TODAY, template: 'essay' });
    const sum = steps.reduce((s, x) => s + x.minutes, 0);
    assert.equal(sum, Math.max(25, total), `total ${total}`);
    steps.forEach((x) => assert.ok(x.minutes >= 5));
  });
});
check('staggered done-by dates between today and the due date; the last step is the due date', () => {
  const steps = buildBreakdown({ totalMinutes: 300, dueDate: '2026-10-24', today: TODAY, template: 'essay' });
  assert.equal(steps.at(-1).dueDate, '2026-10-24');
  assert.equal(steps.at(-1).isLast, true);
  for (let i = 1; i < steps.length; i += 1) assert.ok(steps[i].dueDate >= steps[i - 1].dueDate, `step ${i}`);
  assert.ok(steps[0].dueDate >= TODAY);
  assert.ok(steps.slice(0, -1).every((x) => x.dueDate < '2026-10-24'));
});
check('no due date (or a past one) → steps have no dates; a due date today puts everything today', () => {
  assert.ok(buildBreakdown({ totalMinutes: 60, dueDate: null, today: TODAY }).every((x) => x.dueDate === null));
  assert.ok(buildBreakdown({ totalMinutes: 60, dueDate: '2026-10-01', today: TODAY }).every((x) => x.dueDate === null));
  assert.ok(buildBreakdown({ totalMinutes: 60, dueDate: TODAY, today: TODAY }).every((x) => x.dueDate === TODAY));
});
check('template suggestions from the name (en / zh / ja)', () => {
  assert.equal(suggestTemplate('History essay: WW1'), 'essay');
  assert.equal(suggestTemplate('Chem lab report 3'), 'lab');
  assert.equal(suggestTemplate('Problem set 6'), 'problems');
  assert.equal(suggestTemplate('Group presentation'), 'presentation');
  assert.equal(suggestTemplate('Midterm 2 revision'), 'exam');
  assert.equal(suggestTemplate('Read chapter 5'), 'reading');
  assert.equal(suggestTemplate('期末论文'), 'essay');
  assert.equal(suggestTemplate('化学の実験'), 'lab');
  assert.equal(suggestTemplate('Portfolio site'), 'project');
});
check('the task itself becomes the final step only when no study was done on it', () => {
  assert.equal(canReuseOriginal({ done: false, completedMinutes: 0, blocks: [], rows: [{}] }), true);
  assert.equal(canReuseOriginal({ done: false, completedMinutes: 0, blocks: [{}], rows: [{}] }), false);
  assert.equal(canReuseOriginal({ done: false, completedMinutes: 10, blocks: [], rows: [{}] }), false);
  assert.equal(canReuseOriginal({ done: false, completedMinutes: 0, blocks: [], rows: [{}, {}] }), false);
  assert.equal(canReuseOriginal({ done: true, completedMinutes: 0, blocks: [], rows: [{}] }), false);
});

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
