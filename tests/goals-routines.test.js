// V4-C goals (progress, pace, check-ins) and routines (schedules, streaks,
// completion rates, pause).
// Run: node tests/goals-routines.test.js

import assert from 'node:assert/strict';
import {
  validateGoalFields, validateGoalMilestoneFields, validateCheckIn, currentValue, computeGoalProgress,
  goalPace, nextGoalMilestone, filterGoals, sortGoals, formatValue, GOAL_STATUSES,
} from '../src/goals/goalModel.js';
import {
  validateRoutineFields, scheduledOn, computeStreak, completionRate, recentDays, weekProgress,
  routinesForDay, routineMinutesOn, routineState, pausedDaysToSkip, nextCompletion, isActiveOn,
} from '../src/routines/routineModel.js';

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

const TODAY = '2026-10-14'; // a Wednesday

console.log('\n=== goal fields ===');
check('a valid auto goal is cleaned; defaults active / auto / sum', () => {
  const v = validateGoalFields({ title: '  Get an internship ', target_date: '2027-03-01' });
  assert.equal(v.ok, true);
  assert.deepEqual(v.fields, { title: 'Get an internship', description: '', status: 'active', start_date: null, target_date: '2027-03-01', progress_mode: 'auto', start_value: 0, target_value: null, unit: '', aggregate: 'sum', manual_progress: null, space_id: null });
  assert.deepEqual(GOAL_STATUSES, ['active', 'on_hold', 'achieved', 'archived']);
});
check('numeric goals need a target different from the start', () => {
  assert.equal(validateGoalFields({ title: 'x', progress_mode: 'numeric' }).errors.target_value, 'goals.errTarget');
  assert.equal(validateGoalFields({ title: 'x', progress_mode: 'numeric', start_value: '5', target_value: '5' }).errors.target_value, 'goals.errTargetSame');
  const v = validateGoalFields({ title: 'Read', progress_mode: 'numeric', target_value: '12', unit: ' books ', aggregate: 'latest' });
  assert.equal(v.ok, true);
  assert.deepEqual([v.fields.start_value, v.fields.target_value, v.fields.unit, v.fields.aggregate], [0, 12, 'books', 'latest']);
});
check('blank title, inverted dates and bad manual progress are caught', () => {
  assert.equal(validateGoalFields({ title: '' }).errors.title, 'goals.errTitle');
  assert.equal(validateGoalFields({ title: 'x'.repeat(121) }).errors.title, 'goals.errTitleLong');
  assert.equal(validateGoalFields({ title: 'x', start_date: '2026-12-01', target_date: '2026-11-01' }).errors.target_date, 'goals.errDates');
  assert.equal(validateGoalFields({ title: 'x', progress_mode: 'manual', manual_progress: '101' }).errors.manual_progress, 'goals.errProgress');
  assert.equal(validateGoalFields({ title: 'x', progress_mode: 'manual', manual_progress: '' }).errors.manual_progress, 'goals.errProgress');
  assert.equal(validateGoalFields({ title: 'x', status: 'done', progress_mode: 'magic' }).fields.status, 'active');
});
check('non-numeric goals never keep stale numeric fields', () => {
  const v = validateGoalFields({ title: 'x', progress_mode: 'auto', target_value: '10', unit: 'km', manual_progress: '40' });
  assert.deepEqual([v.fields.target_value, v.fields.unit, v.fields.manual_progress], [null, '', null]);
});
check('milestones need a title; check-ins need a number and cannot be in the future', () => {
  assert.equal(validateGoalMilestoneFields({ title: ' ' }).errors.title, 'goals.errMilestoneTitle');
  assert.deepEqual(validateGoalMilestoneFields({ title: ' Résumé ', due_date: 'x' }).fields, { title: 'Résumé', due_date: null });
  assert.equal(validateCheckIn({ value: 'abc' }, TODAY).errors.value, 'goals.errCheckIn');
  assert.equal(validateCheckIn({ value: '' }, TODAY).errors.value, 'goals.errCheckIn');
  assert.equal(validateCheckIn({ value: 2, logged_on: '2026-10-15' }, TODAY).errors.logged_on, 'goals.errFutureCheckIn');
  assert.deepEqual(validateCheckIn({ value: '2.5', note: ' long run ' }, TODAY).fields, { value: 2.5, logged_on: TODAY, note: 'long run' });
});

console.log('\n=== goal progress ===');
const tasks = [{ done: true }, { done: false }, { done: true }, { done: false }];
const milestones = [{ status: 'done', due_date: '2026-10-01' }, { status: 'open', due_date: '2026-11-01', title: 'Apply' }];
check('auto: done tasks + done milestones + project fractions over all items', () => {
  const p = computeGoalProgress({ progress_mode: 'auto', status: 'active' }, { tasks, milestones, projects: [{ percent: 50 }, { percent: 100 }] });
  // (2 + 1 + 0.5 + 1) / (4 + 2 + 2) = 4.5 / 8
  assert.equal(p.percent, 56);
  assert.deepEqual([p.tasksDone, p.tasksTotal, p.milestonesDone, p.milestonesTotal, p.projectsDone, p.projectsTotal], [2, 4, 1, 2, 1, 2]);
  assert.equal(p.empty, false);
});
check('auto: an Achieved goal shows 100%, an empty one 0% and empty', () => {
  assert.equal(computeGoalProgress({ status: 'achieved' }, { tasks }).percent, 100);
  const e = computeGoalProgress({ status: 'active' }, {});
  assert.equal(e.percent, 0);
  assert.equal(e.empty, true);
});
check('numeric sum: start + every check-in, clamped to 100%', () => {
  const goal = { progress_mode: 'numeric', start_value: 0, target_value: 12, aggregate: 'sum' };
  const logs = [{ value: 2, logged_on: '2026-09-01' }, { value: 1, logged_on: '2026-10-01' }];
  assert.equal(currentValue(goal, logs), 3);
  assert.equal(computeGoalProgress(goal, { logs }).percent, 25);
  assert.equal(computeGoalProgress(goal, { logs: [{ value: 20 }] }).percent, 100);
});
check('numeric latest: newest check-in wins; falling targets work (76 kg -> 70 kg)', () => {
  const goal = { progress_mode: 'numeric', start_value: 76, target_value: 70, aggregate: 'latest' };
  const logs = [{ value: 73, logged_on: '2026-10-10', created_at: 'b' }, { value: 74, logged_on: '2026-10-01', created_at: 'a' }, { value: 72.5, logged_on: '2026-10-10', created_at: 'c' }];
  assert.equal(currentValue(goal, logs), 72.5);
  const p = computeGoalProgress(goal, { logs });
  assert.equal(p.value, 72.5);
  assert.equal(p.percent, 58); // 3.5 / 6
  assert.equal(computeGoalProgress(goal, { logs: [{ value: 80 }] }).percent, 0);
  assert.equal(currentValue(goal, []), 76);
});
check('manual: the student percentage, linked items still counted', () => {
  const p = computeGoalProgress({ progress_mode: 'manual', manual_progress: 70 }, { tasks });
  assert.equal(p.percent, 70);
  assert.equal(p.tasksTotal, 4);
});

console.log('\n=== goal pace ===');
const paced = { status: 'active', start_date: '2026-10-01', target_date: '2026-10-31' };
check('pace compares with the straight line between start and target date', () => {
  // 13 of 30 days elapsed -> expected 0.433
  assert.equal(goalPace(paced, { fraction: 0.2 }, TODAY).state, 'behind');
  assert.equal(goalPace(paced, { fraction: 0.45 }, TODAY).state, 'on_track');
  assert.equal(goalPace(paced, { fraction: 0.7 }, TODAY).state, 'ahead');
  assert.equal(goalPace(paced, { fraction: 0.45 }, TODAY).expected, 0.433);
});
check('no pace without dates, for empty/achieved/complete goals; overdue after the target date', () => {
  assert.equal(goalPace({ status: 'active', target_date: '2026-10-31' }, { fraction: 0.1 }, TODAY), null);
  assert.equal(goalPace({ ...paced, status: 'achieved' }, { fraction: 0.1 }, TODAY), null);
  assert.equal(goalPace(paced, { fraction: 1 }, TODAY), null);
  assert.equal(goalPace(paced, { fraction: 0, empty: true }, TODAY), null);
  assert.equal(goalPace({ status: 'active', target_date: '2026-10-01' }, { fraction: 0.5 }, TODAY).state, 'overdue');
});
check('next milestone, filters, sort and value formatting', () => {
  assert.equal(nextGoalMilestone(milestones).title, 'Apply');
  const goals = [
    { id: 'a', title: 'B goal', status: 'achieved' },
    { id: 'b', title: 'Archived', status: 'archived' },
    { id: 'c', title: 'Later', status: 'active', target_date: '2027-01-01' },
    { id: 'd', title: 'Soon', status: 'active', target_date: '2026-11-01', description: 'internship' },
    { id: 'e', title: 'Paused', status: 'on_hold' },
  ];
  assert.deepEqual(filterGoals(goals, { view: 'active' }).map((g) => g.id), ['c', 'd', 'e']);
  assert.deepEqual(filterGoals(goals, { view: 'all' }).map((g) => g.id), ['a', 'c', 'd', 'e']);
  assert.deepEqual(filterGoals(goals, { view: 'archived' }).map((g) => g.id), ['b']);
  assert.deepEqual(filterGoals(goals, { view: 'all', search: 'INTERN' }).map((g) => g.id), ['d']);
  assert.deepEqual(sortGoals(goals).map((g) => g.id), ['d', 'c', 'e', 'a', 'b']);
  assert.equal(formatValue(2.0000001), '2');
  assert.equal(formatValue(12.345), '12.35');
  assert.equal(formatValue(null), '');
});

console.log('\n=== routine fields ===');
check('a valid routine is cleaned; start defaults to today', () => {
  const v = validateRoutineFields({ title: ' Gym ', frequency: 'days', days_of_week: [5, 1, 3, 3, 9] }, TODAY);
  assert.equal(v.ok, true);
  assert.deepEqual(v.fields.days_of_week, [1, 3, 5]);
  assert.equal(v.fields.start_date, TODAY);
  assert.equal(v.fields.time_of_day, 'anytime');
});
check('days need at least one weekday; N per week 1-7; duration 1-1440; end after start', () => {
  assert.equal(validateRoutineFields({ title: 'x', frequency: 'days', days_of_week: [] }, TODAY).errors.days_of_week, 'routines.errDays');
  assert.equal(validateRoutineFields({ title: 'x', frequency: 'weekly_count', weekly_target: 9 }, TODAY).errors.weekly_target, 'routines.errWeekly');
  assert.equal(validateRoutineFields({ title: 'x', duration_minutes: '0' }, TODAY).errors.duration_minutes, 'routines.errDuration');
  assert.equal(validateRoutineFields({ title: 'x', start_date: '2026-10-10', end_date: '2026-10-01' }, TODAY).errors.end_date, 'routines.errDates');
  assert.equal(validateRoutineFields({ title: '' }, TODAY).errors.title, 'routines.errTitle');
  assert.deepEqual(validateRoutineFields({ title: 'x', frequency: 'daily', days_of_week: [1] }, TODAY).fields.days_of_week, []);
});

console.log('\n=== routine schedules + streaks ===');
const daily = { id: 'r1', frequency: 'daily', start_date: '2026-10-01', weekly_target: 3 };
const done = (id, dates, status = 'done') => dates.map((d) => ({ routine_id: id, completed_on: d, status }));
check('scheduledOn respects frequency, weekdays and the date range', () => {
  const mwf = { frequency: 'days', days_of_week: [1, 3, 5], start_date: '2026-10-01', end_date: '2026-10-31' };
  assert.equal(scheduledOn(mwf, '2026-10-14'), true); // Wed
  assert.equal(scheduledOn(mwf, '2026-10-13'), false); // Tue
  assert.equal(scheduledOn(mwf, '2026-11-02'), false); // after end
  assert.equal(scheduledOn(daily, '2026-09-30'), false); // before start
  assert.equal(scheduledOn({ frequency: 'weekly_count', start_date: '2026-10-01' }, '2026-10-13'), true);
});
check('daily streak: consecutive done days; today not done yet does not break it', () => {
  const c = done('r1', ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13']);
  assert.deepEqual(computeStreak(daily, c, TODAY), { current: 4, best: 4, unit: 'day' });
  assert.equal(computeStreak(daily, [...c, ...done('r1', [TODAY])], TODAY).current, 5);
});
check('a missed day breaks the streak; best streak is remembered', () => {
  const c = done('r1', ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-06', '2026-10-13']);
  assert.deepEqual(computeStreak(daily, c, TODAY), { current: 1, best: 4, unit: 'day' });
});
check('skipped days neither count nor break', () => {
  const c = [...done('r1', ['2026-10-11', '2026-10-13']), ...done('r1', ['2026-10-12'], 'skipped')];
  assert.equal(computeStreak(daily, c, TODAY).current, 2);
});
check('weekday routines only look at their own days', () => {
  const mwf = { id: 'r2', frequency: 'days', days_of_week: [1, 3, 5], start_date: '2026-10-01' };
  // Fri 9, Mon 12 done; Wed 14 (today) open; Tue/Thu are not routine days
  assert.equal(computeStreak(mwf, done('r2', ['2026-10-09', '2026-10-12']), TODAY).current, 2);
  // Wed 7 missed -> streak from Fri 9 only
  assert.equal(computeStreak(mwf, done('r2', ['2026-10-02', '2026-10-05', '2026-10-09', '2026-10-12']), TODAY).current, 2);
});
check('N times a week: weeks that met the target; the current week never breaks it', () => {
  const wk = { id: 'r3', frequency: 'weekly_count', weekly_target: 2, start_date: '2026-09-28' };
  // weeks: Sep 28 (2 done), Oct 5 (3 done), Oct 12 (1 done so far)
  const c = done('r3', ['2026-09-29', '2026-10-01', '2026-10-05', '2026-10-07', '2026-10-09', '2026-10-13']);
  assert.deepEqual(computeStreak(wk, c, TODAY), { current: 2, best: 2, unit: 'week' });
  assert.equal(computeStreak(wk, [...c, ...done('r3', [TODAY])], TODAY).current, 3);
  // a missed past week breaks it
  assert.equal(computeStreak(wk, done('r3', ['2026-09-29', '2026-10-01', '2026-10-05']), TODAY).current, 0);
  // an excused week (done + skipped >= target) neither counts nor breaks
  const ex = [...done('r3', ['2026-09-29', '2026-10-01', '2026-10-05']), ...done('r3', ['2026-10-06'], 'skipped')];
  assert.equal(computeStreak(wk, ex, TODAY).current, 1);
});
check('a routine that has not started has no streak', () => {
  assert.deepEqual(computeStreak({ frequency: 'daily', start_date: '2026-11-01' }, [], TODAY), { current: 0, best: 0, unit: 'day' });
});

console.log('\n=== completion rate + strips ===');
check('daily rate over 14 days: skipped left out, today only once done', () => {
  const c = [...done('r1', ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10']), ...done('r1', ['2026-10-04'], 'skipped')];
  const r = completionRate(daily, c, TODAY, 14);
  // window Oct 1-14: due Oct 1-13 minus skipped (12), done 9
  assert.deepEqual([r.done, r.due], [9, 12]);
  assert.equal(Math.round(r.rate * 100), 75);
  const r2 = completionRate(daily, [...c, ...done('r1', [TODAY])], TODAY, 14);
  assert.deepEqual([r2.done, r2.due], [10, 13]);
});
check('a routine that started recently is rated only since its start', () => {
  const r = completionRate({ id: 'n', frequency: 'daily', start_date: '2026-10-12' }, done('n', ['2026-10-12']), TODAY, 30);
  assert.deepEqual([r.done, r.due], [1, 2]);
  assert.equal(completionRate({ id: 'n', frequency: 'daily', start_date: TODAY }, [], TODAY).rate, null);
});
check('N times a week rate: capped at the target, current week counts only what is done', () => {
  const wk = { id: 'r3', frequency: 'weekly_count', weekly_target: 2, start_date: '2026-09-28' };
  const c = done('r3', ['2026-09-29', '2026-10-01', '2026-10-02', '2026-10-07', '2026-10-13']);
  const r = completionRate(wk, c, TODAY, 21); // window Sep 24 - Oct 14: weeks Sep 28 (full), Oct 5 (full), Oct 12 (current)
  assert.deepEqual([r.done, r.due], [2 + 1 + 1, 2 + 2 + 1]);
});
check('recent strip marks done / skipped / missed / open / off / before', () => {
  const mwf = { id: 'r2', frequency: 'days', days_of_week: [1, 3, 5], start_date: '2026-10-09' };
  const strip = recentDays(mwf, [...done('r2', ['2026-10-09']), ...done('r2', ['2026-10-12'], 'skipped')], TODAY, 7);
  assert.deepEqual(strip.map((d) => d.state), ['before', 'done', 'off', 'off', 'skipped', 'off', 'open']);
});
check('week progress counts done days of the current week', () => {
  const wk = { id: 'r3', frequency: 'weekly_count', weekly_target: 3, start_date: '2026-09-28' };
  assert.deepEqual(weekProgress(wk, done('r3', ['2026-10-11', '2026-10-12', '2026-10-13']), TODAY), { done: 2, target: 3 });
});

console.log('\n=== today list, pause, states ===');
const routines = [
  { id: 'a', title: 'Evening walk', frequency: 'daily', time_of_day: 'evening', start_date: '2026-10-01', duration_minutes: 30 },
  { id: 'b', title: 'Stretch', frequency: 'daily', time_of_day: 'morning', start_date: '2026-10-01', duration_minutes: 10 },
  { id: 'c', title: 'Gym', frequency: 'days', days_of_week: [2, 4], start_date: '2026-10-01', duration_minutes: 60 },
  { id: 'd', title: 'Paused', frequency: 'daily', paused: true, start_date: '2026-10-01' },
  { id: 'e', title: 'Archived', frequency: 'daily', archived: true, start_date: '2026-10-01' },
  { id: 'f', title: 'Swim', frequency: 'weekly_count', weekly_target: 2, start_date: '2026-10-01', duration_minutes: 45 },
  { id: 'g', title: 'Read', frequency: 'weekly_count', weekly_target: 1, start_date: '2026-10-01' },
];
const comps = [...done('b', [TODAY]), ...done('g', ['2026-10-12'])];
check('today list: due routines, unticked first, by time of day; met weekly targets hidden', () => {
  const list = routinesForDay(routines, comps, TODAY);
  assert.deepEqual(list.map((x) => x.routine.id), ['f', 'a', 'b']);
  assert.equal(list[2].status, 'done');
  assert.deepEqual(list[0].week, { done: 0, target: 2 });
});
check('routine minutes for capacity skip skipped routines', () => {
  assert.equal(routineMinutesOn(routines, comps, TODAY), 45 + 30 + 10);
  assert.equal(routineMinutesOn(routines, [...comps, ...done('a', [TODAY], 'skipped')], TODAY), 45 + 10);
});
check('resume fills paused routine days with skipped (up to yesterday)', () => {
  const r = { id: 'p', frequency: 'days', days_of_week: [1, 3, 5], paused: true, paused_at: '2026-10-07', start_date: '2026-09-01' };
  assert.deepEqual(pausedDaysToSkip(r, done('p', ['2026-10-09']), TODAY), ['2026-10-07', '2026-10-12']);
  assert.deepEqual(pausedDaysToSkip({ ...r, paused: false }, [], TODAY), []);
  assert.deepEqual(pausedDaysToSkip({ ...r, paused_at: TODAY }, [], TODAY), []);
});
check('states and toggles', () => {
  assert.equal(routineState({ archived: true }, TODAY), 'archived');
  assert.equal(routineState({ paused: true }, TODAY), 'paused');
  assert.equal(routineState({ start_date: '2026-01-01', end_date: '2026-10-01' }, TODAY), 'ended');
  assert.equal(routineState({ start_date: '2026-11-01' }, TODAY), 'upcoming');
  assert.equal(routineState({ start_date: '2026-10-01' }, TODAY), 'active');
  assert.equal(nextCompletion(null), 'done');
  assert.equal(nextCompletion('skipped'), 'done');
  assert.equal(nextCompletion('done'), null);
  assert.equal(isActiveOn(routines[3], TODAY), false);
});

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
