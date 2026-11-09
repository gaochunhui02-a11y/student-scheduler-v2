// V5 deadline planner + product tour model.
// Run: node tests/deadline-planner.test.js

import assert from 'node:assert/strict';
import { planDeadlines, groupByDay, explainTask, uniformDays, withShortfall } from '../src/planner/deadlinePlanner.js';
import { defaultOnboardingAnswers, buildOnboardingPlan, onboardingPlannerInput, validateOnboardingStep, DAILY_TARGETS, DEFAULT_DAILY_TARGET, onboardingStepsV5 } from '../src/dashboard/onboardingModel.js';
import {
  TOURS, TOUR_IDS, TOUR_ROUTE, TOUR_MODULE, tourForView, normalizeTourState, markTour, markOffered,
  shouldOfferTour, nextVisibleStep, visibleSteps, stepPosition, placeCard,
} from '../src/tour/tourModel.js';
import { ROUTES } from '../src/app/router.js';
import { MODULES } from '../src/workspace/modules.js';

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

const MON = '2026-11-09';
const days = (n, free, start = MON) => uniformDays(start, n, free);
const sumFor = (plan, id) => plan.assignments.filter((a) => a.taskId === id).reduce((s, a) => s + a.minutes, 0);

console.log('\n=== deadline planner ===');
check('uniformDays: consecutive dates, skip weekdays', () => {
  const d = uniformDays(MON, 7, 120, { skipWeekdays: [0, 6] });
  assert.deepEqual(d.map((x) => x.date), ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']);
  assert.deepEqual(d.map((x) => x.free), [120, 120, 120, 120, 120, 0, 0]);
});

check('a task that fits goes on the first day with room, before its due date', () => {
  const plan = planDeadlines({ tasks: [{ id: 'a', name: 'Essay', minutes: 90, dueDate: '2026-11-12' }], days: days(7, 120), start: MON });
  assert.deepEqual(plan.assignments.map((a) => [a.date, a.minutes]), [[MON, 90]]);
  assert.equal(plan.tasks[0].shortBy, 0);
  assert.equal(plan.tasks[0].freeBeforeDue, 360); // Mon–Wed, never the due day itself
});

check('a big task is split across days, never more than a day has free', () => {
  const plan = planDeadlines({ tasks: [{ id: 'a', name: 'Project', minutes: 300, dueDate: '2026-11-13' }], days: days(7, 120), start: MON });
  assert.deepEqual(plan.assignments.map((a) => [a.date, a.minutes]), [['2026-11-09', 120], ['2026-11-10', 120], ['2026-11-11', 60]]);
  assert.equal(plan.tasks[0].parts, 3);
  plan.assignments.forEach((a) => assert.ok(a.minutes <= 120));
});

check('planned + shortBy === minutes for every task (nothing dropped or duplicated)', () => {
  const tasks = [
    { id: 'a', name: 'A', minutes: 400, dueDate: '2026-11-11' },
    { id: 'b', name: 'B', minutes: 95, dueDate: '2026-11-10' },
    { id: 'c', name: 'C', minutes: 47 },
    { id: 'd', name: 'D', minutes: 600, dueDate: '2026-11-20' },
  ];
  const plan = planDeadlines({ tasks, days: days(14, 150), start: MON });
  plan.tasks.forEach((s) => {
    assert.equal(s.planned + s.shortBy, s.minutes, s.name);
    assert.equal(sumFor(plan, s.taskId), s.planned, s.name);
  });
  // No day over its capacity.
  groupByDay(plan.assignments).forEach((d) => assert.ok(d.minutes <= 150, d.date));
});

check('earliest deadline first: the sooner task gets the early days', () => {
  const plan = planDeadlines({
    tasks: [{ id: 'late', name: 'Later', minutes: 120, dueDate: '2026-11-20' }, { id: 'soon', name: 'Soon', minutes: 120, dueDate: '2026-11-10' }],
    days: days(10, 120), start: MON,
  });
  assert.deepEqual(plan.assignments.find((a) => a.taskId === 'soon').date, MON);
  assert.equal(plan.assignments.find((a) => a.taskId === 'late').date, '2026-11-10');
});

check('due day used only when needed, and marked tight', () => {
  const plan = planDeadlines({ tasks: [{ id: 'a', name: 'A', minutes: 200, dueDate: '2026-11-10' }], days: days(5, 120), start: MON });
  assert.deepEqual(plan.assignments.map((a) => [a.date, a.minutes, a.tight]), [['2026-11-09', 120, false], ['2026-11-10', 80, true]]);
  assert.equal(plan.tasks[0].tight, true);
});

check('not enough time: shortBy reported with the real free time before the due date', () => {
  const plan = planDeadlines({ tasks: [{ id: 'a', name: 'A', minutes: 300, dueDate: '2026-11-11' }], days: days(5, 60), start: MON });
  assert.equal(plan.tasks[0].planned, 180); // Mon, Tue + due day Wed
  assert.equal(plan.tasks[0].shortBy, 120);
  assert.equal(plan.tasks[0].freeBeforeDue, 120);
  const facts = explainTask(plan.tasks[0]);
  assert.deepEqual(facts.find((f) => f.key === 'short').params, { minutes: 120, free: 120 });
});

check('overdue work may use any day from the start and is flagged late', () => {
  const plan = planDeadlines({ tasks: [{ id: 'a', name: 'A', minutes: 60, dueDate: '2026-11-01' }], days: days(3, 60), start: MON });
  assert.equal(plan.assignments[0].date, MON);
  assert.equal(plan.assignments[0].late, true);
  assert.equal(explainTask(plan.tasks[0])[0].key, 'late');
});

check('no fragments under minChunk when a later day can take a proper part', () => {
  const plan = planDeadlines({ tasks: [{ id: 'a', name: 'A', minutes: 130, dueDate: '2026-11-20' }], days: days(5, 120), start: MON, minChunk: 30 });
  assert.deepEqual(plan.assignments.map((a) => a.minutes), [100, 30]);
});

check('…but coverage wins over chunk size when room is scarce', () => {
  const plan = planDeadlines({ tasks: [{ id: 'a', name: 'A', minutes: 50, dueDate: '2026-11-11' }], days: [{ date: MON, free: 20 }, { date: '2026-11-10', free: 20 }, { date: '2026-11-11', free: 0 }], start: MON, minChunk: 30 });
  assert.equal(plan.tasks[0].planned, 40);
  assert.equal(plan.tasks[0].shortBy, 10);
});

check('days before start are ignored; capacity is never negative', () => {
  const plan = planDeadlines({ tasks: [{ id: 'a', name: 'A', minutes: 60 }], days: [{ date: '2026-11-08', free: 500 }, { date: MON, free: -40 }, { date: '2026-11-10', free: 60 }], start: MON });
  assert.deepEqual(plan.assignments.map((a) => a.date), ['2026-11-10']);
});

check('deterministic: same input, same plan', () => {
  const input = { tasks: [{ id: 'x', name: 'X', minutes: 200, dueDate: '2026-11-15', priority: 'high' }, { id: 'y', name: 'Y', minutes: 200, dueDate: '2026-11-15' }], days: days(7, 100), start: MON };
  assert.deepEqual(planDeadlines(input).assignments, planDeadlines(input).assignments);
  assert.equal(planDeadlines(input).assignments[0].taskId, 'x'); // priority breaks the tie
});

check('explainTask: facts only from the plan', () => {
  const plan = planDeadlines({ tasks: [{ id: 'a', name: 'A', minutes: 180, dueDate: '2026-11-12' }], days: days(7, 120), start: MON });
  const facts = explainTask(plan.tasks[0]);
  assert.deepEqual(facts.map((f) => f.key), ['dueIn', 'remaining', 'split', 'fits']);
  assert.equal(facts[3].params.free, 360);
  assert.deepEqual(explainTask(null), []);
});

check('withShortfall keeps the full estimate: overflow lands on the last day, flagged', () => {
  const plan = planDeadlines({ tasks: [{ id: 'a', name: 'A', minutes: 300, dueDate: '2026-11-11' }, { id: 'b', name: 'B', minutes: 60, dueDate: '2026-11-01' }], days: [{ date: MON, free: 60 }, { date: '2026-11-10', free: 60 }, { date: '2026-11-11', free: 0 }], start: MON });
  const saved = withShortfall(plan, MON);
  const total = (id) => saved.filter((x) => x.taskId === id).reduce((s, x) => s + x.minutes, 0);
  assert.equal(total('a') + total('b'), 360);
  const a = saved.filter((x) => x.taskId === 'a');
  assert.equal(a[a.length - 1].overBy, plan.tasks.find((s) => s.taskId === 'a').shortBy);
  // Nothing fits at all -> one part on the fallback day, never dropped.
  const none = withShortfall(planDeadlines({ tasks: [{ id: 'z', name: 'Z', minutes: 90 }], days: [], start: MON }), MON);
  assert.deepEqual(none.map((x) => [x.date, x.minutes, x.overBy]), [[MON, 90, 90]]);
});

console.log('\n=== onboarding → plan ===');
check('onboarding answers become a multi-day plan that respects the daily target', () => {
  const answers = defaultOnboardingAnswers();
  answers.tasks = [{ name: 'Lab report', minutes: '240', due: '2026-11-12' }, { name: 'Reading', minutes: '60', due: '' }, { name: '', minutes: '', due: '' }];
  answers.day.dailyMinutes = 120;
  const plan = buildOnboardingPlan(answers);
  assert.equal(plan.tasks[0].due_date, '2026-11-12');
  assert.equal('due_date' in plan.tasks[1], false);
  assert.equal(plan.prefs.max_daily_study_minutes, 120);
  const input = onboardingPlannerInput(plan, { today: MON, dailyMinutes: 120 });
  assert.equal(input.days.length, 14);
  const result = planDeadlines(input);
  groupByDay(result.assignments).forEach((d) => assert.ok(d.minutes <= 120));
  assert.equal(result.tasks.find((s) => s.taskId === '0').shortBy, 0);
  assert.ok(result.assignments.filter((a) => a.taskId === '0').every((a) => a.date < '2026-11-12'));
});

check('onboarding validation: due date must be a real date, not in the past; daily target from the list', () => {
  const ok = validateOnboardingStep('tasks', { today: MON, tasks: [{ name: 'A', minutes: '60', due: '2026-11-20' }] });
  assert.equal(ok.ok, true);
  assert.equal(validateOnboardingStep('tasks', { today: MON, tasks: [{ name: 'A', minutes: '60', due: '2026-11-01' }] }).errors[0].key, 'onboarding.errDuePast');
  assert.equal(validateOnboardingStep('tasks', { today: MON, tasks: [{ name: 'A', minutes: '60', due: '20/11' }] }).errors[0].key, 'onboarding.errDueDate');
  assert.equal(validateOnboardingStep('day', { day: { wake: '07:00', sleep: '23:00', dailyMinutes: 45 } }).ok, false);
  assert.equal(validateOnboardingStep('day', { day: { wake: '07:00', sleep: '23:00', dailyMinutes: 180 } }).ok, true);
  assert.equal(validateOnboardingStep('day', { day: { wake: '07:00', sleep: '23:00' } }).ok, true); // V4 answers still valid
  assert.ok(DAILY_TARGETS.includes(DEFAULT_DAILY_TARGET));
  assert.deepEqual(onboardingStepsV5({ courses: true, purpose: 'work' }), ['purpose', 'tasks', 'day', 'style', 'plan']);
});

console.log('\n=== product tours ===');
check('every tour has steps, a known route and a known module', () => {
  const moduleIds = new Set(MODULES.map((m) => m.id));
  TOUR_IDS.forEach((id) => {
    assert.ok(Array.isArray(TOURS[id]) && TOURS[id].length >= 2, id);
    assert.ok(ROUTES[TOUR_ROUTE[id]], `route for ${id}`);
    assert.ok(moduleIds.has(TOUR_MODULE[id]), `module for ${id}`);
    TOURS[id].forEach((s) => {
      assert.ok(/^[a-z]+$/.test(s.key));
      if (s.target) s.target.forEach((sel) => assert.equal(typeof sel, 'string'));
    });
  });
});

check('tourForView maps page views', () => {
  assert.equal(tourForView('tasksView'), 'tasks');
  assert.equal(tourForView('plannerForm'), 'planner');
  assert.equal(tourForView('boardView'), 'board');
  assert.equal(tourForView('settingsView'), null);
});

check('state: normalize drops junk; mark/offer are immutable', () => {
  const s = normalizeTourState({ seen: { tasks: 'done', nope: 'done', today: 'weird' }, offered: { goals: true, x: true }, tips: 'no' });
  assert.deepEqual(s, { seen: { tasks: 'done' }, offered: { goals: true }, tips: true });
  const m = markTour(s, 'today', 'skipped');
  assert.equal(m.seen.today, 'skipped');
  assert.equal(m.offered.today, true);
  assert.equal(s.seen.today, undefined);
  assert.deepEqual(markTour(s, 'bogus', 'done'), s);
  assert.equal(markOffered(s, 'calendar').offered.calendar, true);
});

check('offered at most once, never during onboarding or with tips off', () => {
  const s = normalizeTourState(null);
  assert.equal(shouldOfferTour(s, 'tasks'), true);
  assert.equal(shouldOfferTour(markOffered(s, 'tasks'), 'tasks'), false);
  assert.equal(shouldOfferTour(markTour(s, 'tasks', 'skipped'), 'tasks'), false);
  assert.equal(shouldOfferTour(s, 'tasks', { onboardingOpen: true }), false);
  assert.equal(shouldOfferTour({ tips: false }, 'tasks'), false);
  assert.equal(shouldOfferTour(s, 'settings'), false);
});

check('navigation skips steps whose element is missing, both directions', () => {
  const steps = [{ key: 'a' }, { key: 'b', target: ['#missing'] }, { key: 'c', target: ['#here'] }, { key: 'd', target: ['#missing'] }];
  const can = (st) => !st.target || st.target[0] === '#here';
  assert.equal(nextVisibleStep(steps, -1, 1, can), 0);
  assert.equal(nextVisibleStep(steps, 0, 1, can), 2);
  assert.equal(nextVisibleStep(steps, 2, 1, can), -1);
  assert.equal(nextVisibleStep(steps, 2, -1, can), 0);
  const vis = visibleSteps(steps, can);
  assert.deepEqual(vis, [0, 2]);
  assert.deepEqual(stepPosition(vis, 2), { n: 2, total: 2 });
  assert.equal(nextVisibleStep(steps, -1, 1, () => false), -1);
});

check('placeCard: below, above, side, centred, always inside the viewport', () => {
  const vp = { width: 1200, height: 800 };
  const card = { width: 360, height: 180 };
  assert.equal(placeCard({ top: 100, left: 100, width: 200, height: 40 }, card, vp).placement, 'bottom');
  assert.equal(placeCard({ top: 700, left: 100, width: 200, height: 40 }, card, vp).placement, 'top');
  assert.equal(placeCard({ top: 0, left: 50, width: 300, height: 800 }, card, vp).placement, 'right');
  assert.equal(placeCard(null, card, vp).placement, 'center');
  const edge = placeCard({ top: 100, left: 1150, width: 40, height: 40 }, card, vp);
  assert.ok(edge.left + card.width <= vp.width - 12 && edge.left >= 12);
  const full = placeCard({ top: 0, left: 0, width: 1200, height: 800 }, card, vp);
  assert.equal(full.placement, 'overlay');
  assert.ok(full.top >= 12 && full.top + card.height <= vp.height - 12);
});

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
