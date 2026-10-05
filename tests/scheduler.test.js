// Plain Node tests for the pure scheduling algorithm — no framework, no DOM,
// no Supabase. Run with `npm test` or `node tests/scheduler.test.js`.

import assert from 'node:assert/strict';
import { generateSchedule, formatClock, timeToMinutes } from '../src/dashboard/scheduler.js';

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

function assertNoOverlaps(events) {
  const sorted = [...events].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(
      sorted[i].start >= sorted[i - 1].end,
      `"${sorted[i - 1].name}" (${formatClock(sorted[i - 1].start)}-${formatClock(sorted[i - 1].end)}) overlaps "${sorted[i].name}" (${formatClock(sorted[i].start)}-${formatClock(sorted[i].end)})`
    );
  }
}

function assertWithinDay(events, dayStart, dayEnd) {
  for (const e of events) {
    assert.ok(e.start >= dayStart && e.end <= dayEnd, `"${e.name}" (${formatClock(e.start)}-${formatClock(e.end)}) is outside the wake-to-bedtime day`);
  }
}

function studyMinutesFor(events, name) {
  return events
    .filter((e) => e.type === 'study' && e.name === name)
    .reduce((sum, e) => sum + (e.end - e.start), 0);
}

const OFF_MEALS = [
  { name: 'Breakfast', duration: 30, on: false, time: '08:00' },
  { name: 'Lunch', duration: 45, on: false, time: '12:00' },
  { name: 'Dinner', duration: 45, on: false, time: '18:00' },
];

const DEFAULT_PREFS = { sessionCap: 60, staminaBreak: 15, switchBreak: 10, minNewBlock: 30 };

// ---------------------------------------------------------------------------
scenario('1. Overnight day with classes, meals, and two study subjects (A/B/C/D/J/K/L)', () => {
  const input = {
    wakeTime: '07:00',
    sleepTime: '01:00', // next day
    classes: [
      { name: 'Math', start: '09:00', end: '10:00' },
      { name: 'History', start: '11:00', end: '12:00' },
    ],
    meals: [
      { name: 'Breakfast', duration: 30, on: true, time: '08:00' },
      { name: 'Lunch', duration: 45, on: true, time: '12:30' },
      { name: 'Dinner', duration: 45, on: true, time: '19:00' },
    ],
    subjects: [
      { name: 'Physics', minutes: 60 },
      { name: 'English essay', minutes: 45 },
    ],
    prefs: DEFAULT_PREFS,
  };
  const result = generateSchedule(input);
  printEvents(result.events);
  const dayStart = timeToMinutes('07:00');
  const dayEnd = 25 * 60; // 1:00 AM next day

  check('ran without an error', () => assert.equal(result.error, undefined));
  check('Physics is a single continuous 60-minute block', () => {
    const blocks = result.events.filter((e) => e.type === 'study' && e.name === 'Physics');
    assert.equal(blocks.length, 1, `expected 1 block, found ${blocks.length}`);
    assert.equal(blocks[0].end - blocks[0].start, 60);
  });
  check('English essay is a single continuous 45-minute block', () => {
    const blocks = result.events.filter((e) => e.type === 'study' && e.name === 'English essay');
    assert.equal(blocks.length, 1, `expected 1 block, found ${blocks.length}`);
    assert.equal(blocks[0].end - blocks[0].start, 45);
  });
  check('no study block overlaps a class or meal', () => {
    const study = result.events.filter((e) => e.type === 'study');
    const fixed = result.events.filter((e) => e.type === 'class' || e.type === 'meal');
    for (const s of study) {
      for (const f of fixed) {
        assert.ok(!(s.start < f.end && s.end > f.start), `"${s.name}" overlaps "${f.name}"`);
      }
    }
  });
  check('nothing is scheduled before wake or after 1:00 AM next day', () => assertWithinDay(result.events, dayStart, dayEnd));
  check('no overlaps anywhere in the full schedule', () => assertNoOverlaps(result.events));
});

// ---------------------------------------------------------------------------
scenario('2. Minimum block does not pad or split a short request (12 min, min block 30)', () => {
  const result = generateSchedule({
    wakeTime: '08:00',
    sleepTime: '20:00',
    classes: [],
    meals: OFF_MEALS,
    subjects: [{ name: 'Quick review', minutes: 12 }],
    prefs: DEFAULT_PREFS,
  });
  printEvents(result.events);
  const dayStart = timeToMinutes('08:00');
  const dayEnd = timeToMinutes('20:00');

  check('ran without an error', () => assert.equal(result.error, undefined));
  check('scheduled as one 12-minute block, not padded to 30 or split', () => {
    const blocks = result.events.filter((e) => e.type === 'study' && e.name === 'Quick review');
    assert.equal(blocks.length, 1, `expected 1 block, found ${blocks.length}`);
    assert.equal(blocks[0].end - blocks[0].start, 12);
  });
  check('no overlaps anywhere', () => assertNoOverlaps(result.events));
  check('everything stays within the wake-to-bedtime day', () => assertWithinDay(result.events, dayStart, dayEnd));
});

// ---------------------------------------------------------------------------
scenario('3. Insufficient available time (E)', () => {
  const result = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '22:00',
    classes: [],
    meals: OFF_MEALS,
    subjects: [{ name: 'Marathon reading', minutes: 1000 }],
    prefs: DEFAULT_PREFS,
  });
  printEvents(result.events);
  const dayStart = timeToMinutes('07:00');
  const dayEnd = timeToMinutes('22:00');

  check('ran without an error', () => assert.equal(result.error, undefined));
  check('scheduled less than the full request instead of forcing it in', () => {
    const scheduled = studyMinutesFor(result.events, 'Marathon reading');
    assert.ok(scheduled > 0 && scheduled < 1000, `scheduled ${scheduled} of 1000 requested minutes`);
  });
  check('a shortfall note names the subject', () => {
    assert.ok(
      result.notes.some((n) => n.includes('Marathon reading') && /short/i.test(n)),
      `notes were: ${JSON.stringify(result.notes)}`
    );
  });
  check('no overlaps anywhere', () => assertNoOverlaps(result.events));
  check('everything stays within the wake-to-bedtime day', () => assertWithinDay(result.events, dayStart, dayEnd));
});

// ---------------------------------------------------------------------------
scenario('4. High priority is scheduled before low priority when time is tight (F)', () => {
  const result = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '22:00',
    classes: [{ name: 'Busy', start: '10:00', end: '22:00' }], // leaves a single 180-min gap: 7:00-10:00
    meals: OFF_MEALS,
    subjects: [
      { name: 'Low priority task', minutes: 120, priority: 'low' },
      { name: 'High priority task', minutes: 120, priority: 'high' },
    ],
    prefs: DEFAULT_PREFS,
  });
  printEvents(result.events);

  check('ran without an error', () => assert.equal(result.error, undefined));
  check('high-priority task is fully scheduled (120 min)', () => {
    assert.equal(studyMinutesFor(result.events, 'High priority task'), 120);
  });
  check('low-priority task only gets what is left over (less than the full 120 min)', () => {
    const mins = studyMinutesFor(result.events, 'Low priority task');
    assert.ok(mins > 0 && mins < 120, `scheduled ${mins} of 120 requested minutes`);
  });
  check('no overlaps anywhere', () => assertNoOverlaps(result.events));
});

// ---------------------------------------------------------------------------
scenario('5. Earlier deadline is scheduled before a later one at equal priority (G)', () => {
  const result = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '22:00',
    classes: [{ name: 'Busy', start: '10:00', end: '22:00' }], // same tight single 180-min gap
    meals: OFF_MEALS,
    subjects: [
      { name: 'Due later', minutes: 120, priority: 'medium', dueDate: '2026-12-01' },
      { name: 'Due soon', minutes: 120, priority: 'medium', dueDate: '2026-09-20' },
    ],
    prefs: DEFAULT_PREFS,
  });
  printEvents(result.events);

  check('ran without an error', () => assert.equal(result.error, undefined));
  check('earlier-deadline task is fully scheduled (120 min)', () => {
    assert.equal(studyMinutesFor(result.events, 'Due soon'), 120);
  });
  check('later-deadline task only gets what is left over (less than the full 120 min)', () => {
    const mins = studyMinutesFor(result.events, 'Due later');
    assert.ok(mins > 0 && mins < 120, `scheduled ${mins} of 120 requested minutes`);
  });
  check('no overlaps anywhere', () => assertNoOverlaps(result.events));
});

// ---------------------------------------------------------------------------
scenario('6. Preferred study period is honored without breaking placement rules (I)', () => {
  const classes = [
    { name: 'Morning block', start: '06:00', end: '08:00' },
    { name: 'Midday block', start: '09:00', end: '13:00' },
    { name: 'Evening block', start: '16:00', end: '22:00' },
  ];
  // leaves two gaps: 8:00-9:00 (60 min, morning) and 13:00-16:00 (180 min, afternoon)
  const subjects = [{ name: 'Reading', minutes: 60 }];

  const withoutPreference = generateSchedule({
    wakeTime: '06:00',
    sleepTime: '22:00',
    classes,
    meals: OFF_MEALS,
    subjects,
    prefs: { ...DEFAULT_PREFS, preferredPeriod: 'none' },
  });
  const withPreference = generateSchedule({
    wakeTime: '06:00',
    sleepTime: '22:00',
    classes,
    meals: OFF_MEALS,
    subjects,
    prefs: { ...DEFAULT_PREFS, preferredPeriod: 'morning' },
  });

  console.log('  -- without preference --');
  printEvents(withoutPreference.events);
  console.log('  -- with morning preference --');
  printEvents(withPreference.events);

  check('without a preference, the larger 3-hour afternoon gap is used', () => {
    const b = withoutPreference.events.find((e) => e.type === 'study' && e.name === 'Reading');
    assert.ok(b, 'no study block scheduled');
    assert.equal(formatClock(b.start), '1:00 PM');
  });
  check('with a morning preference, the smaller 1-hour morning gap is used instead', () => {
    const b = withPreference.events.find((e) => e.type === 'study' && e.name === 'Reading');
    assert.ok(b, 'no study block scheduled');
    assert.equal(formatClock(b.start), '8:00 AM');
  });
  check('no overlaps anywhere (with preference)', () => assertNoOverlaps(withPreference.events));
});

// ---------------------------------------------------------------------------
scenario('7. Earliest/latest study time confines study placement (window)', () => {
  const result = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '23:00',
    classes: [],
    meals: OFF_MEALS,
    subjects: [{ name: 'Late reading', minutes: 60 }],
    prefs: { ...DEFAULT_PREFS, earliestStudyTime: '20:00', latestStudyTime: '23:00' },
  });
  printEvents(result.events);
  const dayStart = timeToMinutes('07:00');
  const dayEnd = timeToMinutes('23:00');

  check('ran without an error', () => assert.equal(result.error, undefined));
  check('study is placed at or after the earliest study time (8:00 PM)', () => {
    const b = result.events.find((e) => e.type === 'study' && e.name === 'Late reading');
    assert.ok(b, 'no study block was scheduled');
    assert.ok(b.start >= timeToMinutes('20:00'), `started at ${formatClock(b.start)}`);
  });
  check('the hours before the study window stay free, not study', () => {
    const earlyFree = result.events.filter((e) => e.type === 'free' && e.start < timeToMinutes('20:00'));
    assert.ok(earlyFree.length > 0, 'expected free time before 8:00 PM');
  });
  check('no overlaps anywhere', () => assertNoOverlaps(result.events));
  check('everything stays within the wake-to-bedtime day', () => assertWithinDay(result.events, dayStart, dayEnd));
});

// ---------------------------------------------------------------------------
scenario('8. Max daily study minutes caps total study placement (V2-B)', () => {
  const result = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '23:00', // 16 hours awake — far more physical room than either subject needs
    classes: [],
    meals: OFF_MEALS,
    subjects: [
      { name: 'A', minutes: 120 },
      { name: 'B', minutes: 120 },
    ],
    prefs: { ...DEFAULT_PREFS, maxDailyStudyMinutes: 150 },
  });
  printEvents(result.events);

  check('the first subject in queue order is fully scheduled', () => assert.equal(studyMinutesFor(result.events, 'A'), 120));
  check('the second subject only gets what fits under the remaining cap', () => assert.equal(studyMinutesFor(result.events, 'B'), 30));
  check('total study minutes placed across every subject never exceeds the cap', () => {
    const total = result.events.filter((e) => e.type === 'study').reduce((sum, e) => sum + (e.end - e.start), 0);
    assert.equal(total, 150);
  });
  check('the capped-out remainder is reported as a shortfall, same as a physical shortfall', () => {
    assert.ok(result.notes.some((n) => n.includes('B') && n.includes('90')), `notes: ${JSON.stringify(result.notes)}`);
  });
  check('no overlaps anywhere', () => assertNoOverlaps(result.events));

  const withoutCap = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '23:00',
    classes: [],
    meals: OFF_MEALS,
    subjects: [
      { name: 'A', minutes: 120 },
      { name: 'B', minutes: 120 },
    ],
    prefs: DEFAULT_PREFS, // maxDailyStudyMinutes omitted entirely
  });
  check('with no cap set at all, both subjects are scheduled in full exactly as before this feature existed', () => {
    assert.equal(studyMinutesFor(withoutCap.events, 'A'), 120);
    assert.equal(studyMinutesFor(withoutCap.events, 'B'), 120);
  });
});

// ---------------------------------------------------------------------------
scenario('9. Max daily study minutes counts already-locked study time toward the cap', () => {
  const lockedStart = timeToMinutes('09:00');
  const result = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '23:00',
    classes: [],
    meals: OFF_MEALS,
    subjects: [{ name: 'New Subject', minutes: 120 }],
    prefs: { ...DEFAULT_PREFS, maxDailyStudyMinutes: 100 },
    lockedBlocks: [{ name: 'Already Locked', start: lockedStart, end: lockedStart + 60, sourceSubjectId: null }],
  });
  printEvents(result.events);

  check('the locked 60 minutes count toward the cap, leaving only 40 for the new subject', () => {
    assert.equal(studyMinutesFor(result.events, 'New Subject'), 40);
  });
  check('the locked block itself is echoed back unchanged', () => {
    const locked = result.events.find((e) => e.name === 'Already Locked');
    assert.ok(locked, 'locked block missing from output');
    assert.equal(locked.start, lockedStart);
    assert.equal(locked.locked, true);
  });
  check('no overlaps anywhere', () => assertNoOverlaps(result.events));
});

// ---------------------------------------------------------------------------
console.log('\n------------------------');
if (totalFailures > 0) {
  console.log(`${totalFailures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
