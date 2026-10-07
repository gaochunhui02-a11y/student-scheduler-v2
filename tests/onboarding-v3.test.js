// V3 onboarding (courses -> weekly classes -> tasks -> day -> style).
// Run: node tests/onboarding-v3.test.js

import assert from 'node:assert/strict';
import {
  onboardingSteps,
  ONBOARDING_STEPS,
  validateOnboardingStep,
  buildOnboardingPlan,
  buildOnboardingAcademics,
  defaultOnboardingAnswersV3,
} from '../src/dashboard/onboardingModel.js';

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

console.log('\n=== steps ===');
check('V3 order only when courses exist; V2 order unchanged otherwise', () => {
  assert.deepEqual(onboardingSteps({ courses: true }), ['courses', 'classes', 'tasks', 'day', 'style']);
  assert.deepEqual(onboardingSteps({ courses: false }), ONBOARDING_STEPS);
  assert.deepEqual(onboardingSteps(), ['tasks', 'day', 'classes', 'style']);
});
check('the V3 defaults pass every step untouched (everything is optional)', () => {
  const a = defaultOnboardingAnswersV3('2026-10-07');
  onboardingSteps({ courses: true }).forEach((step) => assert.equal(validateOnboardingStep(step, a).ok, true, step));
  assert.equal(a.classes[0].weekday, 3); // Wednesday
  assert.equal(a.classes[0].weekly, true);
});

console.log('\n=== courses step ===');
const keys = (r) => r.errors.map((e) => e.key);
check('a valid semester and courses pass', () => {
  const r = validateOnboardingStep('courses', { semester: { name: 'Fall', start: '2026-09-01', end: '2026-12-18' }, courses: [{ name: 'Calc', code: 'M1' }, { name: '', code: '' }] });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});
check('half-filled semesters are caught, with the reason', () => {
  assert.deepEqual(keys(validateOnboardingStep('courses', { semester: { name: '', start: '2026-09-01', end: '2026-12-01' } })), ['onboarding.errSemesterName']);
  assert.deepEqual(keys(validateOnboardingStep('courses', { semester: { name: 'Fall', start: '', end: '' } })), ['onboarding.errSemesterDates']);
  assert.deepEqual(keys(validateOnboardingStep('courses', { semester: { name: 'Fall', start: '2026-12-01', end: '2026-09-01' } })), ['onboarding.errSemesterOrder']);
});
check('a course code without a name is caught; too long is caught', () => {
  assert.deepEqual(keys(validateOnboardingStep('courses', { courses: [{ name: '', code: 'M1' }] })), ['onboarding.errCourseName']);
  assert.deepEqual(keys(validateOnboardingStep('courses', { courses: [{ name: 'x'.repeat(121), code: '' }] })), ['onboarding.errCourseLong']);
});

console.log('\n=== academics + plan ===');
const answers = {
  semester: { name: ' Fall 2026 ', start: '2026-09-01', end: '2026-12-18' },
  courses: [{ name: '', code: '' }, { name: 'Calculus', code: 'MATH 1' }, { name: 'Biology', code: '' }],
  classes: [
    { name: 'Calc lecture', start: '09:00', end: '10:15', weekly: true, weekday: 1, course: '1' },
    { name: 'Dentist', start: '15:00', end: '16:00', weekly: false, weekday: 3, course: '' },
    { name: 'Bio lab', start: '13:00', end: '15:00', weekly: false, weekday: 3, course: '2' },
  ],
  tasks: [{ name: 'Problem set', minutes: '60', course: '1' }, { name: '', minutes: '', course: '2' }, { name: 'Read ch. 3', minutes: '30', course: '0' }],
  day: { wake: '07:00', sleep: '23:00' },
  style: { period: 'none', sessionMinutes: 45 },
};
const ac = buildOnboardingAcademics(answers, { today: '2026-10-07' });
check('semester trimmed; empty course rows dropped; course refs re-indexed', () => {
  assert.deepEqual(ac.semester, { name: 'Fall 2026', start_date: '2026-09-01', end_date: '2026-12-18' });
  assert.deepEqual(ac.courses, [{ name: 'Calculus', code: 'MATH 1' }, { name: 'Biology', code: null }]);
  assert.equal(ac.weeklyClasses[0].courseIndex, 0);
  assert.deepEqual(ac.classCourse, [null, 1]);
  assert.deepEqual(ac.taskCourse, [0, null]); // course '0' was an empty row
});
check('weekly classes run from today to the semester end', () => {
  const w = ac.weeklyClasses[0];
  assert.deepEqual(w.days_of_week, [1]);
  assert.equal(w.start_date, '2026-10-07');
  assert.equal(w.end_date, '2026-12-18');
});
check('without a semester, weekly classes run 16 weeks', () => {
  const a2 = buildOnboardingAcademics({ ...answers, semester: {} }, { today: '2026-10-07' });
  assert.equal(a2.semester, null);
  assert.equal(a2.weeklyClasses[0].end_date, '2027-01-26');
});
check('a future semester starts the weekly classes on its first day', () => {
  const a3 = buildOnboardingAcademics({ ...answers, semester: { name: 'Spring', start: '2027-01-11', end: '2027-05-01' } }, { today: '2026-10-07' });
  assert.equal(a3.weeklyClasses[0].start_date, '2027-01-11');
});
check('weekly classes are NOT also added as one-off Planner classes', () => {
  const plan = buildOnboardingPlan(answers);
  assert.deepEqual(plan.classes.map((c) => c.name), ['Dentist', 'Bio lab']);
  assert.equal(plan.tasks.length, 2);
});
check('a weekly class needs a valid weekday', () => {
  assert.deepEqual(keys(validateOnboardingStep('classes', { classes: [{ name: 'X', start: '09:00', end: '10:00', weekly: true, weekday: 9 }] })), ['onboarding.errChoose']);
});

console.log('\n------------------------');
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
