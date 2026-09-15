// Plain Node tests for the daily-summary / insufficient-time reporting helpers.
// Run with `npm test` or `node tests/summary.test.js` (also run by the npm
// test script alongside scheduler.test.js — see package.json).

import assert from 'node:assert/strict';
import { generateSchedule, formatClock } from '../src/dashboard/scheduler.js';
import { computeDailySummary, computeSubjectProgress, formatDuration } from '../src/dashboard/summary.js';

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

function printEvents(events) {
  events.forEach((e) => console.log(`  ${formatClock(e.start)} - ${formatClock(e.end)}  [${e.type}] ${e.name}`));
}

const OFF_MEALS = [
  { name: 'Breakfast', duration: 30, on: false, time: '08:00' },
  { name: 'Lunch', duration: 45, on: false, time: '12:00' },
  { name: 'Dinner', duration: 45, on: false, time: '18:00' },
];
const DEFAULT_PREFS = { sessionCap: 60, staminaBreak: 15, switchBreak: 10, minNewBlock: 30 };

// ---------------------------------------------------------------------------
scenario('1. Everything fits — no shortfall, no warning', () => {
  const subjects = [{ name: 'Physics', minutes: 60 }, { name: 'English essay', minutes: 45 }];
  const result = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '22:00',
    classes: [{ name: 'Math', start: '09:00', end: '10:00' }],
    meals: [{ name: 'Lunch', duration: 45, on: true, time: '12:30' }],
    subjects,
    prefs: DEFAULT_PREFS,
  });
  const progress = computeSubjectProgress(result.events, subjects);
  printEvents(result.events);

  check('ran without an error', () => assert.equal(result.error, undefined));
  check('unscheduledTotal is 0', () => assert.equal(progress.unscheduledTotal, 0));
  check('every subject is fully scheduled (requested === scheduled)', () => {
    for (const s of progress.subjects) assert.equal(s.scheduled, s.requested, `${s.name}: ${s.scheduled}/${s.requested}`);
  });
  check('scheduledCount equals the number of subjects (no remaining)', () => {
    assert.equal(progress.scheduledCount, progress.subjects.length);
    assert.equal(progress.remainingCount, 0);
  });
});

// ---------------------------------------------------------------------------
scenario('2. Partially unscheduled study time is reported accurately', () => {
  // 7:00-10:00 is the only free gap (180 min); Physics(120) + English(90) = 210min
  // requested, which (with stamina/switch breaks) doesn't fit in 180 available.
  const subjects = [
    { name: 'Physics', minutes: 120 },
    { name: 'English essay', minutes: 90 },
  ];
  const result = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '22:00',
    classes: [{ name: 'Busy', start: '10:00', end: '22:00' }],
    meals: OFF_MEALS,
    subjects,
    prefs: DEFAULT_PREFS,
  });
  const progress = computeSubjectProgress(result.events, subjects);
  printEvents(result.events);
  console.log(`  requested ${progress.requestedTotal}, scheduled ${progress.scheduledTotal}, unscheduled ${progress.unscheduledTotal}`);

  check('ran without an error', () => assert.equal(result.error, undefined));
  check('unscheduledTotal is greater than 0', () => assert.ok(progress.unscheduledTotal > 0));
  check('requestedTotal - scheduledTotal === unscheduledTotal', () => {
    assert.equal(progress.requestedTotal - progress.scheduledTotal, progress.unscheduledTotal);
  });
  check('a shortfall note exists in the scheduler output too', () => {
    assert.ok(result.notes.some((n) => /short/i.test(n)), `notes: ${JSON.stringify(result.notes)}`);
  });
  check('no tiny unrealistic fragment was forced in to eliminate the shortfall', () => {
    // every study block should be a realistic size (>= min block, or the whole
    // subject when the whole subject itself is smaller than min block)
    const blocks = result.events.filter((e) => e.type === 'study');
    for (const b of blocks) assert.ok(b.end - b.start >= 5, `unrealistically tiny block: ${b.name} (${b.end - b.start} min)`);
  });
});

// ---------------------------------------------------------------------------
scenario('3. Multiple subjects with different unscheduled amounts are each reported', () => {
  // Single 90-min gap (7:00-8:30), three subjects each wanting 60 min (180 total
  // requested vs 90 available) — high priority first, so it should be the one
  // most (or fully) scheduled, with the others increasingly short.
  const subjects = [
    { name: 'Low task', minutes: 60, priority: 'low' },
    { name: 'Medium task', minutes: 60, priority: 'medium' },
    { name: 'High task', minutes: 60, priority: 'high' },
  ];
  const result = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '22:00',
    classes: [{ name: 'Busy', start: '08:30', end: '22:00' }],
    meals: OFF_MEALS,
    subjects,
    prefs: DEFAULT_PREFS,
  });
  const progress = computeSubjectProgress(result.events, subjects);
  printEvents(result.events);
  progress.subjects.forEach((s) => console.log(`  ${s.name}: ${s.scheduled} / ${s.requested} min scheduled`));

  check('ran without an error', () => assert.equal(result.error, undefined));
  check('High task is fully scheduled', () => {
    const s = progress.subjects.find((x) => x.name === 'High task');
    assert.equal(s.unscheduled, 0);
  });
  check('Medium and Low tasks are not fully scheduled (different shortfalls reported)', () => {
    const medium = progress.subjects.find((x) => x.name === 'Medium task');
    const low = progress.subjects.find((x) => x.name === 'Low task');
    assert.ok(medium.unscheduled > 0 || low.unscheduled > 0, 'expected at least one of Medium/Low to be short');
  });
  check('every affected subject individually satisfies requested = scheduled + unscheduled', () => {
    for (const s of progress.subjects) assert.equal(s.requested, s.scheduled + s.unscheduled);
  });
  check('unscheduledTotal equals the sum of each subject\'s unscheduled amount', () => {
    const sum = progress.subjects.reduce((t, s) => t + s.unscheduled, 0);
    assert.equal(progress.unscheduledTotal, sum);
  });
});

// ---------------------------------------------------------------------------
scenario('4. Daily summary totals exactly match the generated timeline', () => {
  const result = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '22:00',
    classes: [{ name: 'Math', start: '09:00', end: '10:00' }],
    meals: [
      { name: 'Breakfast', duration: 30, on: true, time: '08:00' },
      { name: 'Lunch', duration: 45, on: true, time: '12:30' },
    ],
    subjects: [{ name: 'Physics', minutes: 60 }, { name: 'History essay', minutes: 90 }],
    prefs: DEFAULT_PREFS,
  });
  const summary = computeDailySummary(result.events, result.dayStart, result.dayEnd);
  printEvents(result.events);
  console.log(
    `  classes=${formatDuration(summary.classMinutes)} study=${formatDuration(summary.studyMinutes)} meals=${formatDuration(summary.mealMinutes)} breaks=${formatDuration(summary.breakMinutes)} free=${formatDuration(summary.freeMinutes)} awake=${formatDuration(summary.awakeMinutes)} sleep=${formatDuration(summary.sleepMinutes)}`
  );

  function manualSum(type) {
    return result.events.filter((e) => e.type === type).reduce((s, e) => s + (e.end - e.start), 0);
  }

  check('ran without an error', () => assert.equal(result.error, undefined));
  check('classMinutes matches a manual sum over the timeline', () => assert.equal(summary.classMinutes, manualSum('class')));
  check('studyMinutes matches a manual sum over the timeline', () => assert.equal(summary.studyMinutes, manualSum('study')));
  check('mealMinutes matches a manual sum over the timeline', () => assert.equal(summary.mealMinutes, manualSum('meal')));
  check('breakMinutes matches a manual sum over the timeline', () => assert.equal(summary.breakMinutes, manualSum('break')));
  check('freeMinutes matches a manual sum over the timeline', () => assert.equal(summary.freeMinutes, manualSum('free')));
  check('class+study+meal+break+free accounts for the entire awake span', () => {
    const total = summary.classMinutes + summary.studyMinutes + summary.mealMinutes + summary.breakMinutes + summary.freeMinutes;
    assert.equal(total, summary.awakeMinutes);
  });
  check('awakeMinutes matches dayEnd - dayStart', () => assert.equal(summary.awakeMinutes, result.dayEnd - result.dayStart));
});

// ---------------------------------------------------------------------------
scenario('5. Awake-time total is correct for a day that crosses midnight', () => {
  const result = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '01:00', // 1:00 AM next day
    classes: [],
    meals: OFF_MEALS,
    subjects: [{ name: 'Physics', minutes: 60 }],
    prefs: DEFAULT_PREFS,
  });
  const summary = computeDailySummary(result.events, result.dayStart, result.dayEnd);
  printEvents(result.events);
  console.log(`  awake=${formatDuration(summary.awakeMinutes)} sleep=${formatDuration(summary.sleepMinutes)}`);

  check('ran without an error', () => assert.equal(result.error, undefined));
  check('dayEnd - dayStart is 18 hours (7:00 AM to 1:00 AM next day)', () => {
    assert.equal(result.dayEnd - result.dayStart, 18 * 60);
  });
  check('awakeMinutes is 18 hours (1080 minutes)', () => assert.equal(summary.awakeMinutes, 18 * 60));
  check('sleepMinutes is the remaining 6 hours (360 minutes)', () => assert.equal(summary.sleepMinutes, 6 * 60));
  check('awake + sleep accounts for a full 24-hour day', () => {
    assert.equal(summary.awakeMinutes + summary.sleepMinutes, 1440);
  });
});

// ---------------------------------------------------------------------------
console.log('\n------------------------');
if (totalFailures > 0) {
  console.log(`${totalFailures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
