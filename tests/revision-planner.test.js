// V3-D revision planner + exam helpers. Run: node tests/revision-planner.test.js

import assert from 'node:assert/strict';
import { planRevision, examProgress, examCountdown, topicRemainingMinutes, validateExamFields, validateTopicFields, topicStatusAfterLog } from '../src/exams/revisionPlanner.js';

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

const today = '2026-10-07';
const exams = [
  { id: 'math', name: 'Midterm', exam_date: '2026-10-10' }, // 3 days away
  { id: 'chem', name: 'Exam 2', exam_date: '2026-10-21' },  // 14 days away
];
const topics = [
  { id: 'm1', exam_id: 'math', name: 'Integration', difficulty: 3, confidence: 2, estimated_minutes: 120, completed_minutes: 0, sort_order: 0 },
  { id: 'm2', exam_id: 'math', name: 'Series', difficulty: 2, confidence: 4, estimated_minutes: 60, completed_minutes: 30, sort_order: 1 },
  { id: 'm3', exam_id: 'math', name: 'Done one', difficulty: 1, confidence: 5, estimated_minutes: 60, completed_minutes: 60, status: 'done', sort_order: 2 },
  { id: 'c1', exam_id: 'chem', name: 'Equilibrium', difficulty: 3, confidence: 2, estimated_minutes: 180, completed_minutes: 0, sort_order: 0 },
];

console.log('\n=== planRevision ===');
const plan = planRevision({ today, exams, topics, dailyMaxMinutes: 120, sessionMinutes: 45 });
const sum = (list) => list.reduce((s, x) => s + x.minutes, 0);
check('places every remaining minute when there is room', () => {
  assert.equal(plan.unplaced.length, 0);
  assert.equal(sum(plan.sessions.filter((s) => s.examId === 'math')), 120 + 30);
  assert.equal(sum(plan.sessions.filter((s) => s.examId === 'chem')), 180);
  assert.equal(plan.perExam.math.fits, true);
});
check('never schedules on or after the exam day', () => {
  plan.sessions.forEach((s) => {
    const exam = exams.find((e) => e.id === s.examId);
    assert.ok(s.date < exam.exam_date, `${s.topicName} on ${s.date}`);
    assert.ok(s.date >= today);
  });
});
check('never exceeds the daily maximum', () => {
  Object.values(plan.assignedByDate).forEach((m) => assert.ok(m <= 120));
});
check('urgent weak topics come first', () => {
  const first = plan.sessions.filter((s) => s.date === today);
  assert.equal(first[0].topicId, 'm1');
});
check('done topics get no sessions', () => {
  assert.equal(plan.sessions.some((s) => s.topicId === 'm3'), false);
});
check('existing study load reduces capacity', () => {
  const p = planRevision({ today, exams, topics, dailyMaxMinutes: 120, existingLoadByDate: { [today]: 120 } });
  assert.equal(p.assignedByDate[today] || 0, 0);
  assert.equal(p.capacityByDate[today], 0);
});
check('blocked days get nothing ("I cannot study Friday")', () => {
  const p = planRevision({ today, exams, topics, dailyMaxMinutes: 120, blockedDates: ['2026-10-08'] });
  assert.equal(p.sessions.some((s) => s.date === '2026-10-08'), false);
});
check('work that cannot fit is reported, not dropped', () => {
  const p = planRevision({ today, exams, topics, dailyMaxMinutes: 30 });
  const mathUnplaced = p.unplaced.filter((u) => u.examId === 'math');
  assert.ok(mathUnplaced.length > 0);
  assert.equal(mathUnplaced[0].reason, 'not_enough_time');
  assert.equal(p.perExam.math.fits, false);
  // planned + unplaced always equals what was needed
  assert.equal(p.perExam.math.planned + p.perExam.math.unplaced, p.perExam.math.needed);
});
check('spacing: one session per topic per day while others can use the time', () => {
  const p = planRevision({ today, exams, topics, dailyMaxMinutes: 120, sessionMinutes: 45 });
  const todays = p.sessions.filter((s) => s.date === today);
  const ids = todays.map((s) => s.topicId);
  assert.equal(new Set(ids).size, ids.length);
});
check('deterministic: same input, same plan', () => {
  assert.deepEqual(planRevision({ today, exams, topics, dailyMaxMinutes: 120 }), plan);
});
check('past exams and exams today are ignored', () => {
  const p = planRevision({ today, exams: [{ id: 'old', exam_date: '2026-10-01' }, { id: 'now', exam_date: today }], topics: [
    { id: 'a', exam_id: 'old', estimated_minutes: 60 }, { id: 'b', exam_id: 'now', estimated_minutes: 60 },
  ] });
  assert.equal(p.sessions.length, 0);
  assert.equal(p.unplaced.length, 0);
});
check('minutes logged through Planner tasks count as completed', () => {
  const p = planRevision({ today, exams, topics, dailyMaxMinutes: 240, extraCompletedByTopic: { m1: 120 } });
  assert.equal(p.sessions.some((s) => s.topicId === 'm1'), false);
});
check('no slivers: sessions are at least the minimum unless they finish a topic', () => {
  const p = planRevision({ today, exams, topics, dailyMaxMinutes: 100, sessionMinutes: 45, minSessionMinutes: 20 });
  p.sessions.forEach((s) => {
    const tp = topics.find((x) => x.id === s.topicId);
    if (s.minutes < 20) assert.ok(topicRemainingMinutes(tp) <= 45 * 3, 'short session only to finish');
  });
});

console.log('\n=== exam helpers ===');
check('countdown in whole days', () => {
  assert.equal(examCountdown(exams[0], today), 3);
  assert.equal(examCountdown({ exam_date: '2026-10-07' }, today), 0);
});
check('progress and readiness', () => {
  const pr = examProgress(exams[0], topics, { today, plan });
  assert.equal(pr.estimated, 240);
  assert.equal(pr.completed, 30 + 60);
  assert.equal(pr.remainingTopics, 2);
  assert.equal(pr.readiness, 'on_track');
  const tight = planRevision({ today, exams, topics, dailyMaxMinutes: 30 });
  assert.equal(examProgress(exams[0], topics, { today, plan: tight }).readiness, 'behind');
  assert.equal(examProgress({ id: 'x', exam_date: '2026-11-01' }, [], { today }).readiness, 'no_topics');
  assert.equal(examProgress({ id: 'x', exam_date: '2026-10-01' }, [], { today }).readiness, 'past');
});
check('validation and status after logging', () => {
  assert.equal(validateExamFields({ name: '', exam_date: 'x' }).ok, false);
  assert.equal(validateExamFields({ name: 'A', exam_date: '2026-10-10', weight: '130' }).errors.weight, 'exams.errWeight');
  assert.equal(validateExamFields({ name: 'A', exam_date: '2026-10-10', weight: '' }).fields.weight, null);
  const tp = validateTopicFields({ name: 'X', estimated_minutes: '90', completed_minutes: '90', difficulty: 9, confidence: 0 });
  assert.equal(tp.fields.status, 'done');
  assert.equal(tp.fields.difficulty, 3);
  assert.equal(tp.fields.confidence, 1);
  assert.deepEqual(topicStatusAfterLog({ estimated_minutes: 60, completed_minutes: 30 }, 30), { completed_minutes: 60, status: 'done' });
});

console.log('\n------------------------');
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
