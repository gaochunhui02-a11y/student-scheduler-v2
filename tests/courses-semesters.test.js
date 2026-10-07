// V3-A/B: course + semester models and task-group roll-up.
// Run with `npm test` or `node tests/courses-semesters.test.js`.

import assert from 'node:assert/strict';
import {
  COURSE_COLORS, pickCourseColor, validateCourseFields, summarizeMeetings, weeklyMeetingMinutes, nextMeeting, meetingsOnDate, filterCoursesBySemester, sortCourses,
} from '../src/academics/courseModel.js';
import {
  validateSemesterFields, normalizeBreaks, pickCurrentSemester, semesterWeeks, semesterProgress, buildSemesterTimeline, classifyWeekLoad, teachingDaysLeft,
} from '../src/academics/semesterModel.js';
import { buildTaskGroups, sortTaskGroups, courseProgress, validateTaskFields } from '../src/tasks/taskModel.js';

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

console.log('\n=== courseModel ===');
check('picks the first unused colour, cycling when all are used', () => {
  assert.equal(pickCourseColor([]), COURSE_COLORS[0]);
  assert.equal(pickCourseColor([{ color: COURSE_COLORS[0] }]), COURSE_COLORS[1]);
  const all = COURSE_COLORS.map((c) => ({ color: c }));
  assert.ok(COURSE_COLORS.includes(pickCourseColor(all)));
});
check('validates and normalises course fields', () => {
  const r = validateCourseFields({ name: '  Calculus II ', code: ' MATH 152 ', color: '#3B6FE0', target_grade: '90', credits: '4', notes: 'x' });
  assert.equal(r.ok, true);
  assert.equal(r.fields.name, 'Calculus II');
  assert.equal(r.fields.code, 'MATH 152');
  assert.equal(r.fields.color, '#3b6fe0');
  assert.equal(r.fields.target_grade, 90);
  assert.equal(r.fields.instructor, null);
});
check('rejects missing names, bad colours and out-of-range targets', () => {
  const r = validateCourseFields({ name: '   ', color: 'red; background:url(x)', target_grade: '140', credits: '-1' });
  assert.equal(r.ok, false);
  assert.equal(r.errors.name, 'courses.errNameRequired');
  assert.equal(r.errors.target_grade, 'courses.errTargetRange');
  assert.equal(r.errors.credits, 'courses.errCreditsRange');
  assert.equal(r.fields.color, null);
});
check('empty optional numbers become null, comma decimals accepted', () => {
  const r = validateCourseFields({ name: 'A', target_grade: '', credits: '3,5' });
  assert.equal(r.fields.target_grade, null);
  assert.equal(r.fields.credits, 3.5);
});
const series = [
  { id: 's1', name: 'Lecture', days_of_week: [1, 3, 5], start_time: '09:00:00', end_time: '09:50:00', start_date: '2026-09-01', end_date: '2026-12-18' },
  { id: 's2', name: 'Lab', days_of_week: [4], start_time: '14:00', end_time: '16:00', start_date: '2026-09-01', end_date: '2026-12-18' },
];
check('summarises meetings Monday-first and totals weekly minutes', () => {
  const m = summarizeMeetings(series);
  assert.deepEqual(m[0].days, [1, 3, 5]);
  assert.equal(m[0].start, '09:00');
  assert.equal(weeklyMeetingMinutes(series), 50 * 3 + 120);
});
check('next meeting honours time of day, skips and the series window', () => {
  // 2026-10-07 is a Wednesday
  assert.equal(nextMeeting(series, [], '2026-10-07', 8 * 60).date, '2026-10-07');
  const later = nextMeeting(series, [], '2026-10-07', 10 * 60);
  assert.equal(later.date, '2026-10-08');
  assert.equal(later.name, 'Lab');
  const skipped = nextMeeting(series, [{ series_id: 's1', exception_date: '2026-10-07', action: 'skip' }], '2026-10-07', 0);
  assert.equal(skipped.date, '2026-10-08');
  assert.equal(nextMeeting(series, [], '2026-12-19', 0), null);
});
check('modified occurrences use their override times', () => {
  const ms = meetingsOnDate(series, [{ series_id: 's1', exception_date: '2026-10-07', action: 'modify', override_start_time: '10:00:00', override_end_time: '10:50:00' }], '2026-10-07');
  assert.equal(ms[0].start, '10:00');
});
check('semester filter + sorting', () => {
  const cs = [{ id: 'a', name: 'B', semester_id: 'x', sort_order: 1 }, { id: 'b', name: 'A', semester_id: null, sort_order: 0 }];
  assert.equal(filterCoursesBySemester(cs, 'x').length, 1);
  assert.equal(filterCoursesBySemester(cs, 'none')[0].id, 'b');
  assert.equal(filterCoursesBySemester(cs, 'all').length, 2);
  assert.equal(sortCourses(cs)[0].id, 'b');
});

console.log('\n=== semesterModel ===');
const sem = { id: 'sem', name: 'Fall', start_date: '2026-08-31', end_date: '2026-12-18', breaks: [{ name: 'Break', start_date: '2026-11-23', end_date: '2026-11-27' }] };
check('validation catches inverted, missing and overlong ranges', () => {
  assert.equal(validateSemesterFields({ name: 'F', start_date: '2026-09-01', end_date: '2026-08-01' }).errors.end_date, 'semester.errEndBeforeStart');
  assert.equal(validateSemesterFields({ name: '', start_date: 'x', end_date: '' }).ok, false);
  assert.equal(validateSemesterFields({ name: 'F', start_date: '2026-01-01', end_date: '2027-06-01' }).errors.end_date, 'semester.errTooLong');
  assert.equal(validateSemesterFields({ name: 'F', start_date: '2026-09-01', end_date: '2026-12-18', breaks: [] }).ok, true);
});
check('breaks outside the semester or malformed are rejected', () => {
  const r = validateSemesterFields({ name: 'F', start_date: '2026-09-01', end_date: '2026-12-18', breaks: [{ name: 'x', start_date: '2027-01-01', end_date: '2027-01-02' }] });
  assert.equal(r.errors.breaks, 'semester.errBreakInvalid');
  assert.equal(normalizeBreaks([{ start_date: '2026-10-05', end_date: '2026-10-01' }], '2026-09-01', '2026-12-18').length, 0);
});
check('current semester: flagged > containing today > next > latest', () => {
  const a = { id: 'a', start_date: '2026-01-10', end_date: '2026-05-01' };
  const b = { id: 'b', start_date: '2026-08-31', end_date: '2026-12-18' };
  const c = { id: 'c', start_date: '2027-01-10', end_date: '2027-05-01' };
  assert.equal(pickCurrentSemester([a, b, c], '2026-10-07').id, 'b');
  assert.equal(pickCurrentSemester([a, c], '2026-10-07').id, 'c');
  assert.equal(pickCurrentSemester([a], '2026-10-07').id, 'a');
  assert.equal(pickCurrentSemester([a, { ...c, is_current: true }], '2026-03-01').id, 'c');
  assert.equal(pickCurrentSemester([], '2026-10-07'), null);
});
check('weeks start on Monday, mark breaks and the current week', () => {
  const weeks = semesterWeeks(sem, '2026-10-07');
  assert.equal(weeks[0].start, '2026-08-31');
  assert.equal(weeks.length, 16);
  assert.equal(weeks.find((w) => w.isCurrent).index, 6);
  const breakWeek = weeks.find((w) => w.start === '2026-11-23');
  assert.equal(breakWeek.isBreak, true);
});
check('a semester starting mid-week still starts its first week on Monday', () => {
  const weeks = semesterWeeks({ start_date: '2026-09-03', end_date: '2026-09-20', breaks: [] });
  assert.equal(weeks[0].start, '2026-08-31');
  assert.equal(weeks[weeks.length - 1].end, '2026-09-20');
});
check('progress before, during and after the semester', () => {
  assert.equal(semesterProgress(sem, '2026-08-01').notStarted, true);
  assert.equal(semesterProgress(sem, '2026-08-01').fraction, 0);
  const mid = semesterProgress(sem, '2026-10-07');
  assert.ok(mid.fraction > 0.3 && mid.fraction < 0.4);
  assert.equal(mid.weekIndex, 6);
  assert.equal(semesterProgress(sem, '2027-01-01').fraction, 1);
});
check('teaching days left excludes weekends and breaks', () => {
  assert.equal(teachingDaysLeft(sem, '2026-11-20'), 16); // Fri Nov 20 + 3 full weeks after the Nov 23–27 break
  assert.equal(teachingDaysLeft(sem, '2027-01-01'), 0);
});
check('timeline sums study, remaining due work and exam prep per week', () => {
  const tl = buildSemesterTimeline({
    semester: sem,
    today: '2026-10-07',
    tasks: [
      { id: 't1', name: 'Essay', dueDate: '2026-10-08', remainingMinutes: 120, done: false, major: true },
      { id: 't2', name: 'Done', dueDate: '2026-10-09', remainingMinutes: 0, done: true },
    ],
    exams: [{ id: 'e', name: 'Mid', exam_date: '2026-10-09' }],
    studyMinutesByDate: { '2026-10-06': 60, '2026-10-12': 30 },
  });
  const w = tl.find((x) => x.isCurrent);
  assert.equal(w.studyMinutes, 60);
  assert.equal(w.dueMinutes, 120);
  assert.equal(w.load, 60 + 120 + 180);
  assert.equal(w.exams.length, 1);
  assert.equal(w.majorCount, 2);
  assert.equal(w.level, 'balanced');
});
check('week load classification thresholds', () => {
  assert.equal(classifyWeekLoad(0), 'none');
  assert.equal(classifyWeekLoad(120), 'light');
  assert.equal(classifyWeekLoad(600), 'balanced');
  assert.equal(classifyWeekLoad(900), 'busy');
  assert.equal(classifyWeekLoad(2000), 'intense');
});

console.log('\n=== taskModel ===');
const rows = [
  { id: 'root', name: 'Essay', minutes_requested: 120, origin_subject_id: null, due_date: '2026-10-10', course_id: 'c1', for_date: '2026-10-05', schedule_id: 'sA' },
  { id: 'chunk', name: 'Essay', minutes_requested: 50, origin_subject_id: 'root', due_date: '2026-10-10', course_id: null, for_date: '2026-10-07', schedule_id: 'sB' },
  { id: 'solo', name: 'Read', minutes_requested: 45, origin_subject_id: null, due_date: '2026-10-01', for_date: '2026-10-01', schedule_id: 'sC' },
  { id: 'later', name: 'Plan', minutes_requested: 30, origin_subject_id: null, due_date: null, for_date: '2026-10-09', schedule_id: 'sD' },
];
const blocks = [
  { id: 'b1', item_type: 'study', source_subject_id: 'root', schedule_id: 'sA', start_minutes: 600, end_minutes: 720, completed: false, completed_minutes: 70, carried_over_minutes: 50 },
  { id: 'b2', item_type: 'study', source_subject_id: 'chunk', schedule_id: 'sB', start_minutes: 600, end_minutes: 650, completed: true, completed_minutes: 50, carried_over_minutes: 0 },
  { id: 'b3', item_type: 'study', source_subject_id: 'solo', schedule_id: 'sC', start_minutes: 600, end_minutes: 645, completed: false, completed_minutes: 0, missed: true },
  { id: 'meal', item_type: 'meal', source_subject_id: null, schedule_id: 'sA', start_minutes: 720, end_minutes: 765 },
];
const groups = buildTaskGroups(rows, blocks, { today: '2026-10-07' });
const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
check('chunks roll up under their root', () => {
  assert.equal(groups.length, 3);
  assert.deepEqual(byId.root.rowIds.sort(), ['chunk', 'root']);
  assert.equal(byId.root.courseId, 'c1');
  assert.deepEqual(byId.root.dates, ['2026-10-05', '2026-10-07']);
});
check('carried-over minutes are not double counted; group is done', () => {
  assert.equal(byId.root.requestedMinutes, 120);
  assert.equal(byId.root.completedMinutes, 120);
  assert.equal(byId.root.done, true);
  assert.equal(byId.root.status, 'done');
});
check('missed overdue work and unscheduled tasks get the right status', () => {
  assert.equal(byId.solo.status, 'missed');
  assert.equal(byId.solo.overdue, true);
  assert.equal(byId.solo.remainingMinutes, 45);
  assert.equal(byId.later.status, 'unscheduled');
  assert.equal(byId.later.overdue, false);
});
check('completed_at marks a task done without any blocks', () => {
  const g = buildTaskGroups([{ ...rows[3], completed_at: '2026-10-07T10:00:00Z' }], [], { today: '2026-10-07' })[0];
  assert.equal(g.done, true);
  assert.equal(g.remainingMinutes, 0);
});
check('blocks all done but minutes still owed reads as partial, not done', () => {
  const g = buildTaskGroups([{ id: 'x', name: 'x', minutes_requested: 120, origin_subject_id: null }], [{ item_type: 'study', source_subject_id: 'x', start_minutes: 0, end_minutes: 60, completed: true }])[0];
  assert.equal(g.done, false);
  assert.equal(g.status, 'partial');
  assert.equal(g.remainingMinutes, 60);
});
check('sorting: open by due date then priority, done last', () => {
  const sorted = sortTaskGroups(groups);
  assert.equal(sorted[0].id, 'solo');
  assert.equal(sorted[sorted.length - 1].id, 'root');
  assert.deepEqual(courseProgress(groups), { total: 3, done: 1, open: 2, fraction: 1 / 3 });
});
check('task validation', () => {
  assert.equal(validateTaskFields({ name: '', minutes_requested: 30 }).errors.name, 'tasks.errNameRequired');
  assert.equal(validateTaskFields({ name: 'x', minutes_requested: 2 }).errors.minutes_requested, 'tasks.errMinutesRange');
  assert.equal(validateTaskFields({ name: 'x', minutes_requested: '45', priority: 'urgent' }).fields.priority, 'medium');
  assert.equal(validateTaskFields({ name: 'x', minutes_requested: 45, due_date: '10/07/2026' }).errors.due_date, 'tasks.errDateInvalid');
});

console.log('\n------------------------');
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
