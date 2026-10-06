// Tests for V2-F first-run onboarding (src/dashboard/onboardingModel.js):
// who sees it (never an existing user), per-step validation, and the plan
// handed to the Planner's existing forms. Plus a source-level check that
// applying the plan goes through the existing save handlers only.
// Run with `npm test` or `node tests/onboarding.test.js`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ONBOARDING_STEPS,
  shouldShowOnboarding,
  validateOnboardingStep,
  buildOnboardingPlan,
  canBuildPlan,
  defaultOnboardingAnswers,
  isValidClock,
} from '../src/dashboard/onboardingModel.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
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

// ---------------------------------------------------------------------------
scenario('A. Who sees onboarding', () => {
  check('a brand-new user with no data sees it', () => {
    assert.equal(shouldShowOnboarding({ completedAt: null, hasExistingData: false, dismissedLocally: false }), true);
  });
  check('never an existing user with data — even before migration 0009 (completedAt unknown)', () => {
    assert.equal(shouldShowOnboarding({ completedAt: undefined, hasExistingData: true, dismissedLocally: false }), false);
    assert.equal(shouldShowOnboarding({ completedAt: null, hasExistingData: true, dismissedLocally: false }), false);
  });
  check('unknown data state (query failed) is treated as "has data"', () => {
    assert.equal(shouldShowOnboarding({ completedAt: null, hasExistingData: undefined, dismissedLocally: false }), false);
  });
  check('finished/skipped on the server or in this browser -> never again', () => {
    assert.equal(shouldShowOnboarding({ completedAt: '2026-10-06T10:00:00Z', hasExistingData: false, dismissedLocally: false }), false);
    assert.equal(shouldShowOnboarding({ completedAt: null, hasExistingData: false, dismissedLocally: true }), false);
  });
});

// ---------------------------------------------------------------------------
scenario('B. Step validation', () => {
  check('four steps in the spec order', () => {
    assert.deepEqual(ONBOARDING_STEPS, ['tasks', 'day', 'classes', 'style']);
  });
  check('defaults pass every step (each step is skippable as-is)', () => {
    const a = defaultOnboardingAnswers();
    ONBOARDING_STEPS.forEach((step) => assert.equal(validateOnboardingStep(step, a).ok, true, step));
  });
  check('tasks: half-filled rows are errors, empty rows are fine', () => {
    assert.equal(validateOnboardingStep('tasks', { tasks: [{ name: 'Calc', minutes: '60' }, { name: '', minutes: '' }] }).ok, true);
    assert.deepEqual(validateOnboardingStep('tasks', { tasks: [{ name: '', minutes: '60' }] }).errors.map((e) => e.key), ['onboarding.errTaskName']);
    assert.deepEqual(validateOnboardingStep('tasks', { tasks: [{ name: 'Calc', minutes: '' }] }).errors.map((e) => e.key), ['onboarding.errTaskMinutes']);
    assert.equal(validateOnboardingStep('tasks', { tasks: [{ name: 'Calc', minutes: '5' }] }).ok, false);
    assert.equal(validateOnboardingStep('tasks', { tasks: [{ name: 'Calc', minutes: '700' }] }).ok, false);
  });
  check('day: valid times, overnight allowed, under 4h rejected', () => {
    assert.equal(validateOnboardingStep('day', { day: { wake: '07:00', sleep: '23:00' } }).ok, true);
    assert.equal(validateOnboardingStep('day', { day: { wake: '10:00', sleep: '01:30' } }).ok, true);
    assert.deepEqual(validateOnboardingStep('day', { day: { wake: '07:00', sleep: '09:00' } }).errors.map((e) => e.key), ['onboarding.errDayLength']);
    assert.equal(validateOnboardingStep('day', { day: { wake: '7am', sleep: '23:00' } }).ok, false);
    assert.equal(validateOnboardingStep('day', {}).ok, false);
  });
  check('classes: name + start < end, or an empty row', () => {
    assert.equal(validateOnboardingStep('classes', { classes: [{ name: 'Chem', start: '09:00', end: '10:15' }, { name: '', start: '', end: '' }] }).ok, true);
    assert.deepEqual(validateOnboardingStep('classes', { classes: [{ name: 'Chem', start: '10:00', end: '09:00' }] }).errors.map((e) => e.key), ['onboarding.errClassOrder']);
    assert.deepEqual(validateOnboardingStep('classes', { classes: [{ name: '', start: '09:00', end: '10:00' }] }).errors.map((e) => e.key), ['onboarding.errClassName']);
    assert.equal(validateOnboardingStep('classes', { classes: [{ name: 'Chem', start: '', end: '10:00' }] }).ok, false);
  });
  check('style: only offered values', () => {
    assert.equal(validateOnboardingStep('style', { style: { period: 'evening', sessionMinutes: 60 } }).ok, true);
    assert.equal(validateOnboardingStep('style', { style: { period: 'night', sessionMinutes: 60 } }).ok, false);
    assert.equal(validateOnboardingStep('style', { style: { period: 'none', sessionMinutes: 50 } }).ok, false);
  });
  check('clock format', () => {
    assert.equal(isValidClock('23:59'), true);
    assert.equal(isValidClock('24:00'), false);
    assert.equal(isValidClock('9:00'), false);
  });
});

// ---------------------------------------------------------------------------
scenario('C. The plan handed to the Planner', () => {
  const answers = {
    tasks: [{ name: '  Calculus  ', minutes: '90' }, { name: '', minutes: '' }, { name: 'Essay', minutes: '45' }],
    day: { wake: '08:00', sleep: '23:30' },
    classes: [{ name: 'Chem', start: '09:00', end: '10:15' }, { name: '', start: '', end: '' }],
    style: { period: 'evening', sessionMinutes: '60' },
  };
  const plan = buildOnboardingPlan(answers);
  check('Planner-shaped fields, trimmed, empty rows dropped', () => {
    assert.deepEqual(plan, {
      day: { wake_time: '08:00', sleep_time: '23:30' },
      prefs: { preferred_study_period: 'evening', session_cap_minutes: 60 },
      classes: [{ name: 'Chem', start_time: '09:00', end_time: '10:15' }],
      tasks: [{ name: 'Calculus', minutes_requested: 90 }, { name: 'Essay', minutes_requested: 45 }],
    });
  });
  check('"Build my first plan" needs at least one task', () => {
    assert.equal(canBuildPlan(plan), true);
    assert.equal(canBuildPlan(buildOnboardingPlan(defaultOnboardingAnswers())), false);
    assert.equal(canBuildPlan(null), false);
  });
  check('at most 3 of each', () => {
    const many = { tasks: Array.from({ length: 5 }, (_, i) => ({ name: `T${i}`, minutes: '30' })) };
    assert.equal(buildOnboardingPlan(many).tasks.length, 3);
  });
  check('junk answers degrade safely', () => {
    const p = buildOnboardingPlan({});
    assert.equal(p.day, null);
    assert.deepEqual(p.prefs, { preferred_study_period: 'none', session_cap_minutes: null });
  });
});

// ---------------------------------------------------------------------------
scenario('D. Applying the plan reuses the existing save handlers', () => {
  const src = readFileSync(join(__dirname, '../src/dashboard/dashboard.js'), 'utf8');
  const fn = src.match(/async function applyOnboardingPlan\([\s\S]*?\n  \}/);
  check('applyOnboardingPlan found', () => assert.ok(fn));
  const body = fn ? fn[0] : '';
  ['insertStudySubject', 'insertClass', 'updateSchedule', 'supabase'].forEach((name) => {
    check(`never calls ${name} directly`, () => assert.doesNotMatch(body, new RegExp(`\\b${name}\\b`)));
  });
  ['saveScheduleSettings', 'addClassRow', 'addStudyRow', 'handleGenerateClick'].forEach((name) => {
    check(`uses the existing ${name}`, () => assert.match(body, new RegExp(`\\b${name}\\(`)));
  });
  check('stops before generating if any row failed to save', () => {
    assert.match(body, /onboarding_save_failed/);
  });
  const onboardingSrc = readFileSync(join(__dirname, '../src/dashboard/onboarding.js'), 'utf8');
  check('the dialog itself never imports the data layer', () => {
    assert.doesNotMatch(onboardingSrc, /data\.js|supabase/);
  });
});

console.log('\n------------------------');
if (totalFailures > 0) {
  console.log(`${totalFailures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
