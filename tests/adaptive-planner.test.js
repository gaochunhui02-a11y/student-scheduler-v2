// V4-E adaptive planner: energy preferences, capacity in the workload
// forecast (light days, routines), and "Catch up on missed work" — which
// tasks qualify, how their remaining time moves with exact minute
// accounting, and where it goes.
// Run: node tests/adaptive-planner.test.js

import assert from 'node:assert/strict';
import { normalizeEnergy, adjustedCapacity, isLightDay, defaultStudyPeriod } from '../src/planner/energyModel.js';
import { buildWorkloadForecast } from '../src/workload/workloadModel.js';
import { catchUpPortion, collectCatchUp, proposeCatchUp, catchUpStart } from '../src/planner/catchUpModel.js';
import { buildTaskGroups } from '../src/tasks/taskModel.js';

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

console.log('\n=== energy preferences ===');
check('normalize: defaults, clamping, unknown values dropped', () => {
  assert.deepEqual(normalizeEnergy(null), { peak: 'none', lightDays: [], lightPercent: 60, countRoutines: false });
  assert.deepEqual(normalizeEnergy({ peak: 'night', lightDays: [6, 0, 6, 9, 'x'], lightPercent: 5, countRoutines: 'yes', extra: 1 }), { peak: 'none', lightDays: [0, 6], lightPercent: 25, countRoutines: false });
  assert.equal(normalizeEnergy({ lightPercent: 250 }).lightPercent, 100);
  assert.equal(normalizeEnergy({ peak: 'evening' }).peak, 'evening');
});
check('capacity: light days get their share; routines count only when asked', () => {
  const e = normalizeEnergy({ lightDays: [3], lightPercent: 50 });
  assert.equal(isLightDay(e, TODAY), true);
  assert.equal(adjustedCapacity(240, e, TODAY), 120);
  assert.equal(adjustedCapacity(240, e, '2026-10-15'), 240);
  assert.equal(adjustedCapacity(240, e, '2026-10-15', 60), 240);
  assert.equal(adjustedCapacity(240, { ...e, countRoutines: true }, '2026-10-15', 60), 180);
  assert.equal(adjustedCapacity(240, { ...e, countRoutines: true }, TODAY, 500), 0);
});
check('peak focus time becomes the default study period of new days', () => {
  assert.equal(defaultStudyPeriod(normalizeEnergy({ peak: 'morning' })), 'morning');
  assert.equal(defaultStudyPeriod(normalizeEnergy(null)), 'none');
});

console.log('\n=== forecast capacity ===');
check('light day lowers capacity with a reason; routines shown as a reason', () => {
  const days = buildWorkloadForecast({ today: TODAY, days: 2, dailyMax: 240, energy: normalizeEnergy({ lightDays: [3], lightPercent: 50 }), routineMinutesByDate: { [TODAY]: 40 } });
  assert.equal(days[0].capacity, 120);
  assert.equal(days[0].lightDay, true);
  assert.ok(days[0].reasons.some((r) => r.key === 'workload.reasonLightDay'));
  assert.ok(days[0].reasons.some((r) => r.key === 'workload.reasonRoutines' && r.params.time === 40));
  assert.equal(days[1].capacity, 240);
});
check('counting routines lowers the limit; a What-if override wins; no energy = V3 numbers', () => {
  const counted = buildWorkloadForecast({ today: TODAY, days: 1, dailyMax: 240, energy: normalizeEnergy({ countRoutines: true }), routineMinutesByDate: { [TODAY]: 40 } });
  assert.equal(counted[0].capacity, 200);
  assert.ok(counted[0].reasons.some((r) => r.key === 'workload.reasonRoutinesCounted'));
  const override = buildWorkloadForecast({ today: TODAY, days: 1, dailyMax: 240, dailyMaxOverride: 300, energy: normalizeEnergy({ lightDays: [3] }) });
  assert.equal(override[0].capacity, 300);
  const v3 = buildWorkloadForecast({ today: TODAY, days: 1, dailyMax: 240 });
  assert.equal(v3[0].capacity, 240);
  assert.equal(v3[0].reasons.length, 0);
});

console.log('\n=== catch up: which tasks ===');
const sched = { '2026-10-10': 's10', '2026-10-12': 's12', [TODAY]: 's14', '2026-10-16': 's16' };
const row = (id, date, minutes, extra = {}) => ({ id, schedule_id: date ? sched[date] : null, for_date: date, name: id, minutes_requested: minutes, priority: 'medium', due_date: null, origin_subject_id: null, completed_at: null, ...extra });
const block = (id, rowId, date, start, end, extra = {}) => ({ id, schedule_id: sched[date], source_subject_id: rowId, item_type: 'study', start_minutes: start, end_minutes: end, completed: false, completed_minutes: 0, carried_over_minutes: 0, missed: false, locked: false, ...extra });
const rows = [
  row('noBlocksPast', '2026-10-12', 45),
  row('partial', '2026-10-10', 120, { due_date: '2026-10-20' }),
  row('lockedOne', '2026-10-12', 60),
  row('overdueBacklog', null, 30, { due_date: '2026-10-11' }),
  row('alsoFuture', '2026-10-10', 60),
  row('alsoFutureChunk', '2026-10-16', 30, { origin_subject_id: 'alsoFuture' }),
  row('plannedToday', TODAY, 30, { due_date: '2026-10-12' }),
  row('donePast', '2026-10-10', 30, { completed_at: '2026-10-10T10:00:00Z' }),
  row('deferred', '2026-10-10', 30, { status_override: 'deferred' }),
  row('dueLater', null, 30, { due_date: '2026-10-30' }),
  row('fullyBlockedDone', '2026-10-10', 60),
];
const blocks = [
  block('b1', 'partial', '2026-10-10', 540, 600, { completed_minutes: 30 }), // 60 min, 30 done
  block('b2', 'lockedOne', '2026-10-12', 600, 660, { locked: true }),
  block('b3', 'fullyBlockedDone', '2026-10-10', 600, 660, { completed: true }),
];
const groups = buildTaskGroups(rows, blocks, { today: TODAY });
const byId = (id) => groups.find((g) => g.id === id);
check('missed = planned on a past day; overdue = past due and planned nowhere', () => {
  const items = collectCatchUp(groups, TODAY);
  const ids = items.map((x) => `${x.group.id}:${x.reason}`).sort();
  assert.deepEqual(ids, ['noBlocksPast:missed', 'overdueBacklog:overdue', 'partial:missed']);
});
check('left alone: anything with a part today or later, done, deferred, not-yet-due backlog, locked-only', () => {
  const ids = collectCatchUp(groups, TODAY).map((x) => x.group.id);
  ['alsoFuture', 'plannedToday', 'donePast', 'deferred', 'dueLater', 'fullyBlockedDone', 'lockedOne'].forEach((id) => assert.ok(!ids.includes(id), id));
  assert.equal(catchUpPortion(byId('lockedOne'), TODAY), null);
});

console.log('\n=== catch up: exact minutes ===');
check('no blocks → the part simply moves', () => {
  const p = catchUpPortion(byId('noBlocksPast'), TODAY);
  assert.deepEqual([p.kind, p.minutes, p.carryMinutes, p.moveRowIds], ['move', 45, 0, ['noBlocksPast']]);
});
check('partly done with blocks → carry the block remainder + never-blocked minutes; totals unchanged', () => {
  const g = byId('partial');
  const before = { requested: g.requestedMinutes, completed: g.completedMinutes, remaining: g.remainingMinutes };
  assert.deepEqual(before, { requested: 120, completed: 30, remaining: 90 });
  const p = catchUpPortion(g, TODAY);
  assert.equal(p.kind, 'carry');
  assert.deepEqual(p.blockCarries, [{ blockId: 'b1', minutes: 30 }]);
  assert.deepEqual(p.rowTrims, [{ rowId: 'partial', minutes: 60, freed: 60 }]);
  assert.equal(p.carryMinutes, 90);
  assert.equal(p.minutes, 90);
  // Simulate the apply step and rebuild the group: nothing is double-counted.
  const after = buildTaskGroups(
    [row('partial', '2026-10-10', 60, { due_date: '2026-10-20' }), row('carry', '2026-10-16', 90, { origin_subject_id: 'partial' })],
    [block('b1', 'partial', '2026-10-10', 540, 600, { completed_minutes: 30, carried_over_minutes: 30, missed: true })],
    { today: TODAY },
  )[0];
  assert.deepEqual({ requested: after.requestedMinutes, completed: after.completedMinutes, remaining: after.remainingMinutes }, before);
  // ...and the task is now "in hand" — a second Catch up offers nothing.
  assert.equal(collectCatchUp([after], TODAY).length, 0);
});
check('locked blocks keep their minutes (reported, never moved)', () => {
  const g = buildTaskGroups([row('mix', '2026-10-12', 90)], [block('l1', 'mix', '2026-10-12', 600, 630, { locked: true }), block('u1', 'mix', '2026-10-12', 700, 760)], { today: TODAY })[0];
  const p = catchUpPortion(g, TODAY);
  assert.deepEqual(p.blockCarries, [{ blockId: 'u1', minutes: 60 }]);
  assert.equal(p.lockedMinutes, 30);
  assert.equal(p.minutes, 60);
});
check('a past part without blocks in a task that has blocks moves instead of being trimmed to 0', () => {
  const g = buildTaskGroups([row('root', '2026-10-10', 60), row('chunk', '2026-10-12', 40, { origin_subject_id: 'root' })], [block('rb', 'root', '2026-10-10', 540, 600)], { today: TODAY })[0];
  const p = catchUpPortion(g, TODAY);
  assert.deepEqual(p.moveRowIds, ['chunk']);
  assert.equal(p.carryMinutes, 60);
  assert.equal(p.minutes, 100);
  assert.ok(p.rowTrims.every((x) => x.minutes >= 1));
});

console.log('\n=== catch up: where ===');
check('earliest due first into days with room before the due date; tight / after-due flagged', () => {
  const items = collectCatchUp(groups, TODAY);
  const days = [{ date: TODAY, free: 60 }, { date: '2026-10-15', free: 100 }, { date: '2026-10-16', free: 30 }];
  const plan = proposeCatchUp(items, days, TODAY);
  const by = Object.fromEntries(plan.assignments.map((a) => [a.taskId, a]));
  assert.equal(by.overdueBacklog.date, TODAY); // overdue: as soon as possible
  assert.equal(by.overdueBacklog.lateForDue, true);
  assert.equal(by.partial.date, '2026-10-15'); // 90 min fits on the 15th
  assert.equal(by.noBlocksPast.date, TODAY); // 45 min fits no day: the roomiest one, marked tight
  assert.equal(by.noBlocksPast.tight, true);
  assert.equal(plan.unplaced.length, 0);
  const tight = proposeCatchUp(items, [{ date: TODAY, free: 20 }], TODAY);
  assert.ok(tight.assignments.some((a) => a.tight) || tight.unplaced.length > 0);
});
check('late in the evening catch up starts tomorrow; days before the start are never used', () => {
  assert.equal(catchUpStart(TODAY, 20 * 60, '2026-10-15'), '2026-10-15');
  assert.equal(catchUpStart(TODAY, 10 * 60, '2026-10-15'), TODAY);
  const plan = proposeCatchUp(collectCatchUp(groups, TODAY), [{ date: TODAY, free: 500 }, { date: '2026-10-15', free: 500 }], '2026-10-15');
  assert.ok(plan.assignments.every((a) => a.date === '2026-10-15'));
});

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
