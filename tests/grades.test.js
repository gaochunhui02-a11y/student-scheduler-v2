// V3-C grade math. Run with `npm test` or `node tests/grades.test.js`.

import assert from 'node:assert/strict';
import {
  computeCourseGrade, requiredOnRemaining, requiredOnItem, requiredFinalSimple, itemShare, gradeStatus, validateCategoryFields, validateGradeItemFields,
} from '../src/grades/gradeModel.js';

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
const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);

console.log('\n=== The brief\'s example ===');
check('current 86%, target 90%, final worth 30% -> need 99.33% on the final', () => {
  const r = requiredFinalSimple({ current: 86, target: 90, finalWeight: 30 });
  close(r.required, (90 - 86 * 0.7) / 0.3);
  close(r.required, 99.3333333, 1e-4);
  assert.equal(r.status, 'needed');
});
check('same result from item-level data (70% graded at 86%, a 30% final pending)', () => {
  const categories = [{ id: 'cw', name: 'Coursework', weight: 70 }, { id: 'fe', name: 'Final', weight: 30 }];
  const items = [
    { id: 'a', category_id: 'cw', earned_points: 86, possible_points: 100 },
    { id: 'f', category_id: 'fe', earned_points: null, possible_points: 100 },
  ];
  const s = computeCourseGrade({ categories, items });
  close(s.current, 86);
  close(s.completedShare, 0.7);
  close(s.remainingShare, 0.3);
  close(requiredOnRemaining(s, 90).required, 99.3333333, 1e-4);
  const one = requiredOnItem(s, 90, itemShare(items[1], s));
  close(one.required, 99.3333333, 1e-4);
  assert.equal(one.assumption, 'only_item');
});

console.log('\n=== computeCourseGrade ===');
const cats = [
  { id: 'ex', name: 'Exams', weight: 40 },
  { id: 'hw', name: 'Homework', weight: 25 },
  { id: 'pr', name: 'Projects', weight: 25 },
  { id: 'pa', name: 'Participation', weight: 10 },
];
const items = [
  { id: 'm1', category_id: 'ex', earned_points: 80, possible_points: 100 },
  { id: 'm2', category_id: 'ex', earned_points: null, possible_points: 100 },
  { id: 'h1', category_id: 'hw', earned_points: 18, possible_points: 20 },
  { id: 'h2', category_id: 'hw', earned_points: 20, possible_points: 20 },
  { id: 'p1', category_id: 'pr', earned_points: null, possible_points: 50 },
  { id: 'x', category_id: 'hw', earned_points: 0, possible_points: 20, counts: false },
];
const s = computeCourseGrade({ categories: cats, items });
check('current grade = weighted average of graded categories only', () => {
  // exams 80% (w40), homework 95% (w25) -> (40*80 + 25*95) / 65
  close(s.current, (40 * 80 + 25 * 95) / 65);
});
check('ungraded items are not zeros, optional items are ignored', () => {
  const hw = s.categories.find((c) => c.id === 'hw');
  close(hw.pct, 95);
  assert.equal(hw.gradedCount, 2);
  assert.equal(s.pendingCount, 2);
});
check('completed / remaining / secured shares', () => {
  // exams: 0.4 * 100/200 = 0.2 ; homework: 0.25 fully graded ; projects 0 ; participation 0
  close(s.completedShare, 0.45);
  close(s.remainingShare, 0.55);
  close(s.securedShare, 0.4 * 80 / 200 + 0.25 * 38 / 40);
  close(s.minFinal, s.securedShare * 100);
  close(s.maxFinal, (s.securedShare + 0.55) * 100);
});
check('projected final keeps the current average', () => {
  close(s.projected, s.current);
});
check('required on all remaining work, and on one item with the rest at the current average', () => {
  const all = requiredOnRemaining(s, 90);
  close(all.required, (90 - s.securedShare * 100) / 0.55);
  const m2 = items.find((i) => i.id === 'm2');
  const share = itemShare(m2, s);
  close(share, 0.2);
  const one = requiredOnItem(s, 90, share);
  close(one.required, (90 - s.securedShare * 100 - s.current * 0.35) / 0.2);
  assert.equal(one.assumption, 'others_at_current');
});
check('weights that do not add to 100 are scaled, with a warning', () => {
  const r = computeCourseGrade({ categories: [{ id: 'a', name: 'A', weight: 30 }, { id: 'b', name: 'B', weight: 30 }], items: [
    { id: 1, category_id: 'a', earned_points: 9, possible_points: 10 },
    { id: 2, category_id: 'b', earned_points: 7, possible_points: 10 },
  ] });
  close(r.current, 80);
  close(r.completedShare, 1);
  assert.equal(r.warnings[0].key, 'grades.warnWeightsSum');
});
check('courses without categories use plain points', () => {
  const r = computeCourseGrade({ categories: [], items: [
    { id: 1, category_id: null, earned_points: 45, possible_points: 50 },
    { id: 2, category_id: null, earned_points: null, possible_points: 50 },
  ] });
  close(r.current, 90);
  close(r.completedShare, 0.5);
  close(itemShare({ category_id: null, possible_points: 50 }, r), 0.5);
});
check('uncategorised items in a categorised course are flagged and excluded', () => {
  const r = computeCourseGrade({ categories: [{ id: 'a', name: 'A', weight: 100 }], items: [
    { id: 1, category_id: 'a', earned_points: 8, possible_points: 10 },
    { id: 2, category_id: null, earned_points: 0, possible_points: 10 },
  ] });
  close(r.current, 80);
  assert.equal(r.warnings.find((w) => w.key === 'grades.warnUncategorized').params.n, 1);
});
check('extra credit can push a category above 100%', () => {
  const r = computeCourseGrade({ categories: [], items: [{ id: 1, earned_points: 11, possible_points: 10 }] });
  close(r.current, 110);
});
check('no grades yet: everything null, nothing invented', () => {
  const r = computeCourseGrade({ categories: cats, items: [{ id: 1, category_id: 'ex', earned_points: null, possible_points: 100 }] });
  assert.equal(r.current, null);
  assert.equal(r.projected, null);
  close(r.completedShare, 0);
  assert.equal(gradeStatus(r, 90), 'no_grades');
});
check('zero total weight is reported, not divided by', () => {
  const r = computeCourseGrade({ categories: [{ id: 'a', name: 'A', weight: 0 }], items: [{ id: 1, category_id: 'a', earned_points: 5, possible_points: 10 }] });
  assert.equal(r.hasWeights, false);
  assert.equal(requiredOnRemaining(r, 90).status, 'no_data');
});

console.log('\n=== required score edge cases ===');
check('already secured -> status secured', () => {
  const r = computeCourseGrade({ categories: [{ id: 'a', name: 'A', weight: 90 }, { id: 'b', name: 'B', weight: 10 }], items: [
    { id: 1, category_id: 'a', earned_points: 100, possible_points: 100 },
    { id: 2, category_id: 'b', earned_points: null, possible_points: 10 },
  ] });
  assert.equal(requiredOnRemaining(r, 85).status, 'secured');
});
check('impossible target -> out_of_reach with the number still shown', () => {
  const r = requiredFinalSimple({ current: 60, target: 95, finalWeight: 20 });
  assert.equal(r.status, 'out_of_reach');
  assert.ok(r.required > 100);
});
check('nothing left to grade -> complete, with met/not met', () => {
  const r = computeCourseGrade({ categories: [], items: [{ id: 1, earned_points: 88, possible_points: 100 }] });
  const req = requiredOnRemaining(r, 90);
  assert.equal(req.status, 'complete');
  assert.equal(req.met, false);
  close(req.finalIfComplete, 88);
});
check('nothing graded yet: item calculator falls back to uniform remaining', () => {
  const r = computeCourseGrade({ categories: [], items: [{ id: 1, earned_points: null, possible_points: 100 }] });
  const req = requiredOnItem(r, 90, 0.3);
  assert.equal(req.assumption, 'uniform');
  close(req.required, 90);
});
check('simple calculator rejects invalid weights', () => {
  assert.equal(requiredFinalSimple({ current: 80, target: 90, finalWeight: 0 }).status, 'no_data');
  assert.equal(requiredFinalSimple({ current: 80, target: 90, finalWeight: 120 }).status, 'no_data');
  assert.equal(requiredFinalSimple({ current: '', target: 90, finalWeight: 30 }).status, 'no_data');
});
check('grade status relative to the target', () => {
  assert.equal(gradeStatus(s, 70), 'on_track');
  assert.equal(gradeStatus(s, 88), 'below_target');
  assert.equal(gradeStatus(s, 95), 'out_of_reach'); // needs 100.45% on the remaining 55%
  assert.equal(gradeStatus(s, null), 'no_target');
});

console.log('\n=== validation ===');
check('category validation', () => {
  assert.equal(validateCategoryFields({ name: '', weight: 10 }).errors.name, 'grades.errCategoryName');
  assert.equal(validateCategoryFields({ name: 'A', weight: 120 }).errors.weight, 'grades.errWeightRange');
  assert.equal(validateCategoryFields({ name: ' A ', weight: '12.5' }).fields.weight, 12.5);
});
check('grade item validation', () => {
  assert.equal(validateGradeItemFields({ name: 'Q', possible_points: 0 }).errors.possible_points, 'grades.errPossible');
  assert.equal(validateGradeItemFields({ name: 'Q', possible_points: 10, earned_points: -1 }).errors.earned_points, 'grades.errEarned');
  const ok = validateGradeItemFields({ name: 'Q', possible_points: '10', earned_points: '' });
  assert.equal(ok.ok, true);
  assert.equal(ok.fields.earned_points, null); // blank stays ungraded, never 0
});

console.log('\n------------------------');
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
