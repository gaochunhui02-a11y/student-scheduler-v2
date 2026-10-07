// V3-E/F/G: workload forecast, Smart Rebalance and What-if.
// Run: node tests/workload.test.js

import assert from 'node:assert/strict';
import { buildWorkloadForecast, classifyDay, summarizeForecast, deadlineRisks } from '../src/workload/workloadModel.js';
import { proposeRebalance, freeSlots, findSlot, dayWindow, mealIntervals } from '../src/workload/rebalanceModel.js';
import { compareScenario, applyScenarioToInputs, emptyScenario, scenarioIsEmpty } from '../src/workload/scenarioModel.js';

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

const today = '2026-10-07'; // Wednesday
const schedules = [
  { id: 's0', for_date: '2026-10-07', max_daily_study_minutes: null, wake_time: '07:00', sleep_time: '23:00' },
  { id: 's1', for_date: '2026-10-08', max_daily_study_minutes: null, wake_time: '07:00', sleep_time: '23:00' },
  { id: 's2', for_date: '2026-10-09', max_daily_study_minutes: 180, wake_time: '07:00', sleep_time: '23:00' },
];
const items = [
  { id: 'c1', schedule_id: 's1', item_type: 'class', name: 'Lecture', start_minutes: 540, end_minutes: 630 },
  { id: 'a', schedule_id: 's1', item_type: 'study', name: 'Essay', start_minutes: 900, end_minutes: 1020, source_subject_id: 'essay' },
  { id: 'b', schedule_id: 's1', item_type: 'study', name: 'Problem set', start_minutes: 1050, end_minutes: 1170, source_subject_id: 'ps' },
  { id: 'c', schedule_id: 's1', item_type: 'study', name: 'Reading', start_minutes: 1200, end_minutes: 1260, source_subject_id: 'read', locked: true },
  { id: 'm1', schedule_id: 's1', item_type: 'meal', name: 'Dinner', start_minutes: 1110, end_minutes: 1155 },
];
const subjects = [
  { id: 'essay', schedule_id: 's1', minutes_requested: 120, due_date: '2026-10-12' },
  { id: 'ps', schedule_id: 's1', minutes_requested: 120, due_date: '2026-10-10' },
  { id: 'read', schedule_id: 's1', minutes_requested: 60, due_date: '2026-10-08' },
  { id: 'lab', schedule_id: 's2', minutes_requested: 60, due_date: '2026-10-09' },
];
const series = [{ id: 'ser', name: 'Calc lecture', days_of_week: [3], start_time: '09:00:00', end_time: '09:50:00', start_date: '2026-09-01', end_date: '2026-12-18' }];
const groups = [
  { id: 'backlog', name: 'Old essay', done: false, dueDate: '2026-10-10', remainingMinutes: 120, requestedMinutes: 120, rows: [{ for_date: '2026-10-01', minutes_requested: 120 }], courseId: null },
  { id: 'ps', name: 'Problem set', done: false, dueDate: '2026-10-10', remainingMinutes: 120, requestedMinutes: 120, rows: [{ for_date: '2026-10-08', minutes_requested: 120 }], courseId: null },
];
const base = { today, days: 7, dailyMax: 240, schedules, items, subjects, series, exceptions: [], groups, exams: [{ id: 'ex', name: 'Midterm', exam_date: '2026-10-11' }], examPrepByExam: { ex: 120 } };
const days = buildWorkloadForecast(base);
const byDate = Object.fromEntries(days.map((d) => [d.date, d]));

console.log('\n=== workload forecast ===');
check('covers exactly the requested window', () => {
  assert.equal(days.length, 7);
  assert.equal(days[0].date, today);
  assert.equal(days[6].date, '2026-10-13');
  assert.equal(buildWorkloadForecast({ ...base, days: 30 }).length, 30);
});
check('uses generated classes, else projects recurring ones', () => {
  assert.equal(byDate['2026-10-08'].classMinutes, 90);
  assert.equal(byDate['2026-10-07'].classMinutes, 50); // Wednesday lecture projected
  assert.equal(byDate['2026-10-10'].classMinutes, 0);
});
check('study = larger of timed blocks and placed tasks', () => {
  assert.equal(byDate['2026-10-08'].studyMinutes, 300);
  assert.equal(byDate['2026-10-09'].studyMinutes, 60);
});
check('backlog not placed on any upcoming day is spread until its due date', () => {
  // 120 min over Oct 7..10 = 30/day
  assert.equal(byDate['2026-10-07'].backlogMinutes, 30);
  assert.equal(byDate['2026-10-10'].backlogMinutes, 30);
  assert.equal(byDate['2026-10-11'].backlogMinutes, 0);
  // the problem set is already placed on Oct 8, so it adds no backlog
  assert.ok(!byDate['2026-10-07'].backlogTasks.some((t) => t.id === 'ps'));
});
check('uncovered exam prep is spread before the exam; exam and deadline listed', () => {
  assert.equal(byDate['2026-10-07'].examPrepMinutes, 30); // 120 over Oct 7..10
  assert.equal(byDate['2026-10-11'].examPrepMinutes, 0);
  assert.equal(byDate['2026-10-11'].exams[0].name, 'Midterm');
  assert.equal(byDate['2026-10-10'].deadlines[0].name, 'Old essay');
});
check('levels compare study load with the day\'s own limit', () => {
  const d8 = byDate['2026-10-08'];
  assert.equal(d8.studyLoad, 300 + 30 + 30);
  assert.equal(d8.level, 'overloaded');
  assert.equal(d8.overBy, 360 - 240);
  assert.equal(d8.reasons[0].key, 'workload.reasonOver');
  assert.equal(byDate['2026-10-09'].capacity, 180); // per-day Planner setting
  assert.equal(byDate['2026-10-13'].level, 'light');
});
check('classification thresholds', () => {
  assert.equal(classifyDay(0, 240), 'light');
  assert.equal(classifyDay(84, 240), 'light');
  assert.equal(classifyDay(100, 240), 'balanced');
  assert.equal(classifyDay(200, 240), 'busy');
  assert.equal(classifyDay(120, 240, 700), 'busy'); // very long day overall
  assert.equal(classifyDay(241, 240), 'overloaded');
  assert.equal(classifyDay(10, 0), 'overloaded');
});
check('summary and deadline risks', () => {
  const s = summarizeForecast(days);
  assert.equal(s.overloadedDays, days.filter((d) => d.level === 'overloaded').length);
  const tight = buildWorkloadForecast({ ...base, dailyMax: 60 });
  const risks = deadlineRisks(tight, groups, today);
  assert.ok(risks.some((r) => r.id === 'backlog'));
  assert.equal(deadlineRisks(days, groups, today).length, 0);
});

console.log('\n=== smart rebalance ===');
const ctx = {};
days.forEach((d) => {
  const sched = schedules.find((s) => s.for_date === d.date);
  ctx[d.date] = {
    window: dayWindow(sched),
    busy: [...d.classes, ...d.studyBlocks, ...mealIntervals(sched, items.filter((i) => i.item_type === 'meal' && i.schedule_id === (sched || {}).id))].map((b) => ({ start: b.start ?? b.start_minutes, end: b.end ?? b.end_minutes })),
  };
});
const due = { essay: '2026-10-12', ps: '2026-10-10', read: '2026-10-08' };
const plan = proposeRebalance({ date: '2026-10-08', today, days, contextByDate: ctx, dueBySubject: due });
check('moves enough unlocked study to clear the overload', () => {
  assert.ok(plan.moves.length >= 1);
  assert.equal(plan.remainingOver, 0);
  assert.ok(plan.moves.reduce((s, m) => s + m.minutes, 0) >= byDate['2026-10-08'].overBy);
});
check('never moves locked blocks, and never past a due date or into the past', () => {
  assert.ok(!plan.moves.some((m) => m.itemId === 'c'));
  assert.ok(plan.kept.some((k) => k.id === 'c' && k.reason === 'locked'));
  plan.moves.forEach((m) => {
    assert.ok(m.toDate >= today);
    assert.ok(m.toDate <= (due[m.sourceSubjectId] || '9999'));
    assert.notEqual(m.toDate, m.fromDate);
  });
});
check('most flexible work moves first (latest due date)', () => {
  assert.equal(plan.moves[0].itemId, 'a'); // essay due Oct 12
});
check('target slots avoid classes, meals and other blocks', () => {
  plan.moves.forEach((m) => {
    const busy = ctx[m.toDate].busy;
    busy.forEach((b) => assert.ok(m.toEnd <= b.start || m.toStart >= b.end, `${m.name} overlaps on ${m.toDate}`));
    assert.ok(m.toStart >= ctx[m.toDate].window.start && m.toEnd <= ctx[m.toDate].window.end);
  });
});
check('completed, started and missed blocks are kept with a reason', () => {
  const d = [{ ...byDate['2026-10-08'], studyBlocks: [
    { id: 'x', name: 'Done', start: 600, end: 660, completed: true },
    { id: 'y', name: 'Half', start: 700, end: 760, completedMinutes: 20 },
    { id: 'z', name: 'Missed', start: 800, end: 860, missed: true },
  ] }];
  const r = proposeRebalance({ date: '2026-10-08', today, days: d, contextByDate: ctx });
  assert.equal(r.moves.length, 0);
  assert.deepEqual(r.kept.map((k) => k.reason).sort(), ['completed', 'missed', 'started']);
});
check('no room anywhere -> nothing moves, reason reported', () => {
  const full = days.map((d) => ({ ...d, spare: d.date === '2026-10-08' ? d.spare : 0 }));
  const r = proposeRebalance({ date: '2026-10-08', today, days: full, contextByDate: ctx, dueBySubject: due });
  assert.equal(r.moves.length, 0);
  assert.ok(r.remainingOver > 0);
  assert.ok(r.kept.some((k) => k.reason === 'no_room' || k.reason === 'due_soon'));
});
check('slot finding prefers the original time and respects buffers', () => {
  const slots = freeSlots({ start: 420, end: 1350 }, [{ start: 540, end: 630 }]);
  assert.deepEqual(slots, [{ start: 420, end: 530 }, { start: 640, end: 1350 }]);
  assert.equal(findSlot(slots, 60, 900), 900);
  assert.equal(findSlot(slots, 200, 450), 640);
  assert.equal(findSlot([{ start: 420, end: 440 }], 60, 420), null);
  assert.deepEqual(dayWindow({ wake_time: '08:00', sleep_time: '01:00', earliest_study_time: null, latest_study_time: null }), { start: 480, end: 1440 });
});
check('deterministic', () => {
  assert.deepEqual(proposeRebalance({ date: '2026-10-08', today, days, contextByDate: ctx, dueBySubject: due }), plan);
});

console.log('\n=== what-if scenarios ===');
check('empty scenario changes nothing', () => {
  assert.equal(scenarioIsEmpty(emptyScenario()), true);
  const cmp = compareScenario(base, emptyScenario());
  assert.equal(cmp.changedDays.length, 0);
  assert.equal(cmp.safe, true);
});
check('"I can\'t study Friday" zeroes that day\'s capacity', () => {
  const cmp = compareScenario(base, { ...emptyScenario(), blockedDates: ['2026-10-09'] });
  const fri = cmp.afterDays.find((d) => d.date === '2026-10-09');
  assert.equal(fri.capacity, 0);
  assert.equal(fri.level, 'overloaded');
  assert.ok(cmp.changedDays.some((d) => d.date === '2026-10-09'));
  assert.equal(cmp.safe, false);
});
check('"max 3 hours a day" changes every day\'s limit', () => {
  const cmp = compareScenario(base, { ...emptyScenario(), dailyMax: 180 });
  assert.ok(cmp.afterDays.every((d) => d.capacity === 180));
});
check('"the project takes 2 more hours" adds backlog without touching real data', () => {
  const before = JSON.stringify(base.groups);
  const cmp = compareScenario(base, { ...emptyScenario(), taskExtra: [{ taskId: 'backlog', minutes: 120 }] });
  assert.equal(JSON.stringify(base.groups), before); // inputs untouched
  const total = (ds) => ds.reduce((s, d) => s + d.backlogMinutes, 0);
  assert.equal(total(cmp.afterDays) - total(cmp.beforeDays), 120);
});
check('moving an exam moves its prep window', () => {
  const moved = applyScenarioToInputs(base, { ...emptyScenario(), examMoves: [{ examId: 'ex', newDate: '2026-10-13' }] });
  assert.equal(moved.exams[0].exam_date, '2026-10-13');
  assert.equal(base.exams[0].exam_date, '2026-10-11');
  const cmp = compareScenario(base, { ...emptyScenario(), examMoves: [{ examId: 'ex', newDate: '2026-10-13' }] });
  assert.equal(cmp.afterDays.find((d) => d.date === '2026-10-12').examPrepMinutes > 0, true);
});

console.log('\n------------------------');
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
