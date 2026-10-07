// V3-K estimate accuracy. Run: node tests/estimate-accuracy.test.js

import assert from 'node:assert/strict';
import { computeEstimateAccuracy, estimateStatement, MIN_SAMPLES } from '../src/insights/estimateModel.js';
import { focusOutcome } from '../src/focus/focusOutcome.js';

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

const g = (id, courseId, est, extra = {}) => ({ id, name: id, courseId, done: true, requestedMinutes: est, actualMinutes: null, rowIds: [id], ...extra });

check('no statement from one or two sessions', () => {
  const r = computeEstimateAccuracy({ groups: [g('a', 'cs', 60), g('b', 'cs', 60)], sessions: [{ task_id: 'a', actual_minutes: 90 }, { task_id: 'b', actual_minutes: 90 }] });
  assert.equal(r.overall.n, 2);
  assert.equal(r.overall.enough, false);
  assert.equal(estimateStatement(r.overall), null);
  assert.equal(MIN_SAMPLES, 5);
});
check('"you usually need 18% more time for CS"', () => {
  const groups = ['a', 'b', 'c', 'd', 'e'].map((id) => g(id, 'cs', 100));
  const sessions = groups.map((x) => ({ task_id: x.id, actual_minutes: 118 }));
  const r = computeEstimateAccuracy({ groups, sessions });
  const cs = r.byCourse.find((c) => c.courseId === 'cs');
  assert.equal(cs.enough, true);
  assert.equal(cs.verdict, 'under');
  assert.equal(cs.percent, 18);
  const st = estimateStatement(cs, 'CS 101');
  assert.equal(st.key, 'insights3.estUnderCourse');
  assert.equal(st.params.pct, 18);
});
check('"accurate within about 10 minutes"', () => {
  const groups = ['a', 'b', 'c', 'd', 'e'].map((id) => g(id, 'math', 90));
  const actuals = [80, 95, 100, 88, 92];
  const r = computeEstimateAccuracy({ groups, sessions: groups.map((x, i) => ({ task_id: x.id, actual_minutes: actuals[i] })) });
  const m = r.byCourse[0];
  assert.equal(m.verdict, 'accurate');
  assert.equal(estimateStatement(m, 'MATH').params.min, Math.round(m.medianError));
  assert.ok(m.medianError <= 10);
});
check('manual actual time wins over focus sessions; untimed tasks are ignored', () => {
  const r = computeEstimateAccuracy({
    groups: [g('a', null, 60, { actualMinutes: 30 }), g('b', null, 60), g('c', null, 60, { done: false })],
    sessions: [{ task_id: 'a', actual_minutes: 999 }, { task_id: 'c', actual_minutes: 60 }],
  });
  assert.equal(r.samples.length, 1);
  assert.equal(r.samples[0].actual, 30);
});
check('chunks of a multi-day task are summed', () => {
  const r = computeEstimateAccuracy({ groups: [g('root', null, 120, { rowIds: ['root', 'chunk'] })], sessions: [{ task_id: 'root', actual_minutes: 50 }, { task_id: 'chunk', actual_minutes: 70 }] });
  assert.equal(r.samples[0].actual, 120);
});
check('focus outcome labels', () => {
  assert.equal(focusOutcome('complete', true), 'completed');
  assert.equal(focusOutcome('stop', true), 'finished_early');
  assert.equal(focusOutcome('stop', false), 'stopped');
});

console.log('\n------------------------');
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
