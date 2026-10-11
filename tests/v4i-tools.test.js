// V4-I: palette scopes, focus timer, V4 reminders, file exports (CSV
// injection), offline snapshot v2 and the device-data clearing list.
// Run: node tests/v4i-tools.test.js

import assert from 'node:assert/strict';
import { parseScope, filterCommands } from '../src/shared/commandPalette.js';
import { startTimer, pauseTimer, resumeTimer, focusedMs, remaining, formatClock, finishTimer, shouldAnnounce, clampMinutes } from '../src/focus/focusTimerModel.js';
import { dueRoutineReminders, weeklyReviewReminderDue, normalizeReminderPrefs } from '../src/notifications/v4Reminders.js';
import { csvCell, toCsv, tasksCsv, routineLogCsv, attendanceCsv, goalCheckInsCsv, notesMarkdown, exportFilename } from '../src/export/exportModel.js';
import { buildOfflineSnapshot, isValidSnapshot } from '../src/offline/offlineSnapshot.js';

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

console.log('\n=== palette scopes ===');
const cmds = [
  { id: 'a', group: 'tasks', title: 'Essay draft' },
  { id: 'b', group: 'notes', title: 'Essay ideas' },
  { id: 'c', group: 'navigate', title: 'Open Tasks' },
  { id: 'd', group: 'projects', title: 'Essay project' },
];
check('prefixes narrow to one kind; no prefix searches everything', () => {
  assert.deepEqual(parseScope('t: essay'), { groups: ['tasks'], rest: ' essay' });
  assert.deepEqual(parseScope('essay').groups, null);
  assert.deepEqual(filterCommands(cmds, 'essay').map((c) => c.id).sort(), ['a', 'b', 'd']);
  assert.deepEqual(filterCommands(cmds, 'n: essay').map((c) => c.id), ['b']);
  assert.deepEqual(filterCommands(cmds, 'P:essay').map((c) => c.id), ['d']);
  assert.deepEqual(filterCommands(cmds, '>').map((c) => c.id), ['c']);
  assert.deepEqual(filterCommands(cmds, 't:').map((c) => c.id), ['a']);
});

console.log('\n=== focus timer ===');
check('time comes from timestamps; pauses are excluded', () => {
  let s = startTimer(25, 0);
  assert.equal(remaining(s, 60000).ms, 24 * 60000);
  s = pauseTimer(s, 5 * 60000);
  assert.equal(focusedMs(s, 20 * 60000), 5 * 60000); // paused: clock stops
  s = resumeTimer(s, 10 * 60000);
  assert.equal(focusedMs(s, 12 * 60000), 7 * 60000);
  assert.equal(remaining(s, 30 * 60000 + 1).done, true);
  assert.equal(remaining(s, 40 * 60000).ms, 0);
});
check('finish: completed when time is up, finished early, or stopped; whole minutes', () => {
  const s = startTimer(25, 0);
  assert.deepEqual(finishTimer(s, 25 * 60000), { minutes: 25, outcome: 'completed', plannedMinutes: 25 });
  assert.deepEqual(finishTimer(s, 10.5 * 60000, { early: true }), { minutes: 10, outcome: 'finished_early', plannedMinutes: 25 });
  assert.equal(finishTimer(s, 30000).minutes, 0);
  assert.equal(finishTimer(s, 30000).outcome, 'stopped');
});
check('clock format, clamping and screen-reader milestones', () => {
  assert.equal(formatClock(25 * 60000), '25:00');
  assert.equal(formatClock(59 * 1000 + 1), '1:00');
  assert.equal(formatClock(65 * 60000), '1:05:00');
  assert.equal(clampMinutes('500'), 180);
  assert.equal(clampMinutes('0'), 1);
  assert.equal(clampMinutes('abc'), 25);
  assert.equal(shouldAnnounce(5 * 60000 + 500, 5 * 60000 - 500), 5 * 60000);
  assert.equal(shouldAnnounce(4 * 60000, 3 * 60000), null);
});

console.log('\n=== reminders ===');
const list = [
  { routine: { id: 'm', title: 'Stretch', time_of_day: 'morning' }, status: null },
  { routine: { id: 'e', title: 'Read', time_of_day: 'evening' }, status: null },
  { routine: { id: 'd', title: 'Done one', time_of_day: 'morning' }, status: 'done' },
  { routine: { id: 'a', title: 'Any', time_of_day: 'anytime' }, status: null },
];
check('routine reminders: only unticked, only after their time, once per day', () => {
  assert.deepEqual(dueRoutineReminders(list, '2026-10-14', 9 * 60).map((x) => x.routine.id), ['m']);
  assert.deepEqual(dueRoutineReminders(list, '2026-10-14', 19 * 60).map((x) => x.routine.id), ['m', 'e', 'a']);
  assert.deepEqual(dueRoutineReminders(list, '2026-10-14', 20 * 60, ['routine:m:2026-10-14']).map((x) => x.routine.id), ['e', 'a']);
});
check('weekly review reminder: Friday 17:00+, not reviewed, once per week', () => {
  const base = { today: '2026-10-16', dow: 5, nowMinutes: 17 * 60, weekStart: '2026-10-12', reviewed: false, sent: [] };
  assert.equal(weeklyReviewReminderDue(base), 'review:2026-10-12');
  assert.equal(weeklyReviewReminderDue({ ...base, nowMinutes: 16 * 60 }), null);
  assert.equal(weeklyReviewReminderDue({ ...base, dow: 4 }), null);
  assert.equal(weeklyReviewReminderDue({ ...base, reviewed: true }), null);
  assert.equal(weeklyReviewReminderDue({ ...base, sent: ['review:2026-10-12'] }), null);
  assert.deepEqual(normalizeReminderPrefs({ routines: 'yes', weeklyReview: true }), { routines: false, weeklyReview: true });
});

console.log('\n=== exports ===');
check('CSV cells: quoting and formula-injection guard', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
  assert.equal(csvCell('=HYPERLINK("http://evil")'), `"'=HYPERLINK(""http://evil"")"`);
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('-2'), "'-2");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(['a', 'b']), 'a; b');
  assert.equal(csvCell(42), '42');
  const out = toCsv([['h1', 'h2'], ['x', 'y']]);
  assert.ok(out.startsWith('﻿h1,h2\r\nx,y'));
});
check('tasks, routine log, attendance and goal check-ins', () => {
  const csv = tasksCsv([{ name: '=cmd', done: false, status: 'planned', dueDate: '2026-10-20', scheduledDate: null, priority: 'high', requestedMinutes: 60, remainingMinutes: 30, courseId: 'c', tags: ['a'], notes: 'n', completedAt: null }], { courseName: () => 'MATH' });
  assert.match(csv, /'=cmd,planned,2026-10-20,,high,60,30,MATH/);
  assert.match(routineLogCsv([{ id: 'r', title: 'Run' }], [{ routine_id: 'r', completed_on: '2026-10-02', status: 'done' }, { routine_id: 'x', completed_on: '2026-10-01' }]), /2026-10-02,Run,done,\r\n$/);
  assert.match(attendanceCsv([{ attended_on: '2026-10-05', start_minutes: 545, course_id: 'c', status: 'late' }], () => 'BIO'), /2026-10-05,09:05,BIO,late,/);
  assert.match(goalCheckInsCsv([{ id: 'g', title: 'Run', unit: 'km' }], [{ goal_id: 'g', logged_on: '2026-10-01', value: 5.5 }]), /2026-10-01,Run,5.5,km,/);
});
check('notes become one Markdown file with demoted headings', () => {
  const md = notesMarkdown([{ title: 'A', body: '# Inner\ntext', updated_at: '2026-10-02T00:00:00Z', tags: ['x'] }, { title: '', body: 'b', updated_at: '2026-10-05T00:00:00Z' }], { untitled: 'Untitled', exportedAt: '2026-10-11T10:00:00Z' });
  assert.match(md, /^# Notes — exported 2026-10-11/);
  assert.ok(md.indexOf('## Untitled') < md.indexOf('## A'));
  assert.match(md, /### Inner/);
  assert.match(md, /_Edited 2026-10-02 · Tags: x_/);
  assert.equal(exportFilename('notes', '2026-10-11'), 'student-scheduler-notes-2026-10-11.md');
  assert.equal(exportFilename('tasks', 'bad'), 'student-scheduler-tasks-export.csv');
});

console.log('\n=== offline snapshot v2 ===');
check('routines are kept (titles + done only); v1 snapshots stay valid', () => {
  const s = buildOfflineSnapshot({ today: '2026-10-14', courses: [], groups: [], todayEvents: [], exams: [], routinesToday: [{ routine: { title: 'Stretch', notes: 'secret' }, status: 'done' }, { routine: { title: 'Read' }, status: null }] }, '2026-10-14T10:00:00Z');
  assert.equal(s.v, 2);
  assert.deepEqual(s.routines, [{ title: 'Stretch', done: true }, { title: 'Read', done: false }]);
  assert.equal(isValidSnapshot(s), true);
  assert.equal(isValidSnapshot({ ...s, v: 1 }), true);
  assert.equal(isValidSnapshot({ ...s, v: 3 }), false);
});

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
