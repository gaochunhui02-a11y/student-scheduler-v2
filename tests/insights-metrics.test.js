// Tests for V2-E Insights metrics (analyticsModel.js) and recommendation
// "Why:" facts (smartPriority.js). Plain Node, no DOM, no Supabase. Run with
// `npm test` or `node tests/insights-metrics.test.js`.

import assert from 'node:assert/strict';
import {
  computeAverageBlockLength,
  computeEstimateAccuracy,
  computeOverdueWorkload,
  computeSubjectWorkloadBars,
} from '../src/analytics/analyticsModel.js';
import { buildReasonFacts, computeTaskScore } from '../src/dashboard/smartPriority.js';

let totalFailures = 0;

function scenario(name, fn) {
  console.log(`\n=== ${name} ===`);
  try {
    fn();
  } catch (e) {
    totalFailures++;
    console.log(`  FAIL  (scenario threw) ${e.message}`);
  }
}

function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (e) {
    totalFailures++;
    console.log(`  FAIL  ${label}`);
    console.log(`        ${e.message}`);
  }
}

const study = (subjectId, start, end, extra = {}) => ({
  item_type: 'study',
  source_subject_id: subjectId,
  start_minutes: start,
  end_minutes: end,
  completed: false,
  completed_minutes: 0,
  carried_over_minutes: 0,
  ...extra,
});

// ---------------------------------------------------------------------------
scenario('A. Average study block length', () => {
  check('averages study blocks only, rounded', () => {
    const r = computeAverageBlockLength([
      study('a', 0, 60),
      study('a', 100, 145),
      study('b', 200, 250),
      { item_type: 'class', start_minutes: 0, end_minutes: 300 },
      { item_type: 'break', start_minutes: 60, end_minutes: 70 },
    ]);
    assert.deepEqual(r, { averageMinutes: 52, blockCount: 3, insufficientData: false });
  });
  check('fewer than 3 blocks -> insufficient, no number', () => {
    const r = computeAverageBlockLength([study('a', 0, 60), study('a', 100, 160)]);
    assert.equal(r.insufficientData, true);
    assert.equal(r.averageMinutes, null);
  });
  check('zero-length blocks and empty input are safe', () => {
    assert.equal(computeAverageBlockLength([study('a', 10, 10)]).blockCount, 0);
    assert.equal(computeAverageBlockLength(null).insufficientData, true);
  });
});

// ---------------------------------------------------------------------------
scenario('B. Estimate accuracy (finished tasks only)', () => {
  const subjects = [
    { id: 's1', minutes_requested: 90 }, // finished, Focus-completed early: actual 72
    { id: 's2', minutes_requested: 60 }, // finished, plain Done: actual 60
    { id: 's3', minutes_requested: 120 }, // finished across two blocks: 50 + 60
    { id: 's4', minutes_requested: 60 }, // NOT finished — one block open
    { id: 's5', minutes_requested: 120 }, // NOT finished — only 60 scheduled (shortfall)
    { id: 's6', minutes_requested: 30 }, // no blocks
  ];
  const items = [
    study('s1', 0, 90, { completed: true, completed_minutes: 72 }),
    study('s2', 100, 160, { completed: true }),
    study('s3', 200, 260, { completed: true, completed_minutes: 50 }),
    study('s3', 300, 360, { completed: true }),
    study('s4', 400, 430, { completed: true }),
    study('s4', 440, 470),
    study('s5', 500, 560, { completed: true }),
  ];
  check('only fully-finished, fully-scheduled tasks count', () => {
    const r = computeEstimateAccuracy(subjects, items);
    assert.equal(r.taskCount, 3);
    assert.equal(r.estimatedMinutes, 270);
    assert.equal(r.actualMinutes, 72 + 60 + 110);
    assert.equal(r.ratioPercent, 90);
    assert.equal(r.insufficientData, false);
  });
  check('fewer than 3 finished tasks -> insufficient', () => {
    const r = computeEstimateAccuracy(subjects.slice(0, 2), items);
    assert.equal(r.insufficientData, true);
    assert.equal(r.ratioPercent, null);
  });
  check('empty input is safe', () => {
    assert.equal(computeEstimateAccuracy(null, null).insufficientData, true);
  });
});

// ---------------------------------------------------------------------------
scenario('C. Overdue workload', () => {
  const today = '2026-10-06';
  const subjects = [
    { id: 'o1', name: 'Essay', due_date: '2026-10-01', minutes_requested: 120 }, // no blocks: 120 left
    { id: 'o2', name: 'Lab', due_date: '2026-10-04', minutes_requested: 90 }, // 30 done, 20 carried: 40 left
    { id: 'o3', name: 'Quiz', due_date: '2026-10-05', minutes_requested: 60 }, // completed: 0 left
    { id: 'f1', name: 'Future', due_date: '2026-10-10', minutes_requested: 60 }, // not overdue
    { id: 'n1', name: 'Today', due_date: today, minutes_requested: 60 }, // due today ≠ overdue
  ];
  const items = [
    study('o2', 0, 90, { completed_minutes: 30, carried_over_minutes: 20 }),
    study('o3', 100, 160, { completed: true }),
  ];
  check('counts unfinished past-due work with real remaining minutes', () => {
    const r = computeOverdueWorkload(subjects, items, today);
    assert.equal(r.count, 2);
    assert.equal(r.totalMinutes, 160);
    assert.deepEqual(
      r.items.map((i) => [i.title, i.remainingMinutes, i.daysOverdue]),
      [['Essay', 120, 5], ['Lab', 40, 2]]
    );
  });
  check('nothing overdue -> zero, not a crash', () => {
    assert.deepEqual(computeOverdueWorkload([], [], today), { count: 0, totalMinutes: 0, items: [] });
    assert.deepEqual(computeOverdueWorkload(null, null, today), { count: 0, totalMinutes: 0, items: [] });
  });
  check('list is capped but totals are not', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `x${i}`, name: `T${i}`, due_date: '2026-10-01', minutes_requested: 10 }));
    const r = computeOverdueWorkload(many, [], today, 5);
    assert.equal(r.items.length, 5);
    assert.equal(r.count, 8);
    assert.equal(r.totalMinutes, 80);
  });
});

// ---------------------------------------------------------------------------
scenario('D. Subject workload bars', () => {
  check('scaled to the biggest subject; completed never exceeds planned', () => {
    const bars = computeSubjectWorkloadBars([
      { subject: 'CS', planned: 400, completed: 200 },
      { subject: 'Calculus', planned: 260, completed: 300 },
      { subject: 'Writing', planned: 0, completed: 0 },
    ]);
    assert.deepEqual(bars.map((b) => [b.plannedPercent, b.completedPercent]), [[100, 50], [65, 65], [0, 0]]);
  });
  check('all zero / empty is safe', () => {
    assert.deepEqual(computeSubjectWorkloadBars([{ subject: 'x', planned: 0, completed: 0 }]).map((b) => b.plannedPercent), [0]);
    assert.deepEqual(computeSubjectWorkloadBars(null), []);
  });
});

// ---------------------------------------------------------------------------
scenario('E. Recommendation "Why:" facts', () => {
  const today = '2026-10-06';
  const base = { id: 't', name: 'CS Project', priority: 'high', dueDate: '2026-10-08', remainingMinutes: 120, scheduledMinutes: 0, carriedOverMinutes: 0, missed: false };

  check('the spec example: due in 2 days, high, 120 min, tomorrow heavy', () => {
    const breakdown = computeTaskScore(base, { todayDateStr: today });
    const facts = buildReasonFacts(base, breakdown, { todayDateStr: today, tomorrowStudyMinutes: 300 });
    assert.deepEqual(facts, [
      { key: 'dueIn', value: 2 },
      { key: 'highPriority' },
      { key: 'remaining', value: 120 },
      { key: 'tomorrowHeavy', value: 300 },
    ]);
  });
  check('tomorrow heavy is not claimed below the threshold or when due today', () => {
    const b = computeTaskScore(base, { todayDateStr: today });
    assert.equal(buildReasonFacts(base, b, { todayDateStr: today, tomorrowStudyMinutes: 200 }).some((f) => f.key === 'tomorrowHeavy'), false);
    const dueToday = { ...base, dueDate: today };
    const b2 = computeTaskScore(dueToday, { todayDateStr: today });
    assert.equal(buildReasonFacts(dueToday, b2, { todayDateStr: today, tomorrowStudyMinutes: 400 }).some((f) => f.key === 'tomorrowHeavy'), false);
  });
  check('overdue / today / tomorrow wording keys', () => {
    const f = (dueDate) => buildReasonFacts({ ...base, dueDate }, computeTaskScore({ ...base, dueDate }, { todayDateStr: today }), { todayDateStr: today })[0];
    assert.deepEqual(f('2026-10-03'), { key: 'overdue', value: 3 });
    assert.deepEqual(f(today), { key: 'dueToday' });
    assert.deepEqual(f('2026-10-07'), { key: 'dueTomorrow' });
  });
  check('far or missing due date: no due fact, remaining still stated', () => {
    const t = { ...base, dueDate: '2026-12-01', priority: 'medium' };
    const facts = buildReasonFacts(t, computeTaskScore(t, { todayDateStr: today }), { todayDateStr: today });
    assert.deepEqual(facts[0], { key: 'remaining', value: 120 });
  });
  check('capped at limit; null breakdown -> []', () => {
    const t = { ...base, missed: true, carriedOverMinutes: 30 };
    const b = computeTaskScore(t, { todayDateStr: today, availableMinutesToday: 300 });
    assert.equal(buildReasonFacts(t, b, { todayDateStr: today }, 2).length, 2);
    assert.deepEqual(buildReasonFacts(t, null, {}), []);
  });
});

console.log('\n------------------------');
if (totalFailures > 0) {
  console.log(`${totalFailures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
