// Plain Node tests for lock/unlock + regenerate behavior in the pure scheduling
// algorithm. No DOM, no Supabase — `lockedBlocks` here is exactly the shape
// dashboard.js builds from schedule_items rows: [{ name, start, end }] in the
// same absolute-minutes space as every other event. Run with `npm test` or
// `node tests/lock-regenerate.test.js`.

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
  events.forEach((e) => console.log(`  ${formatClock(e.start)} - ${formatClock(e.end)}  [${e.type}]${e.locked ? ' 🔒' : ''} ${e.name}`));
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

function studyMinutesFor(events, name, { lockedOnly = false, unlockedOnly = false } = {}) {
  return events
    .filter((e) => e.type === 'study' && e.name === name)
    .filter((e) => (lockedOnly ? e.locked : true))
    .filter((e) => (unlockedOnly ? !e.locked : true))
    .reduce((sum, e) => sum + (e.end - e.start), 0);
}

const OFF_MEALS = [
  { name: 'Breakfast', duration: 30, on: false, time: '08:00' },
  { name: 'Lunch', duration: 45, on: false, time: '12:00' },
  { name: 'Dinner', duration: 45, on: false, time: '18:00' },
];
const DEFAULT_PREFS = { sessionCap: 60, staminaBreak: 15, switchBreak: 10, minNewBlock: 30 };

// ---------------------------------------------------------------------------
scenario('A. A locked Physics block survives regeneration at exactly the same time', () => {
  const lockStart = timeToMinutes('14:00');
  const lockEnd = timeToMinutes('15:00');
  const result = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '22:00',
    classes: [],
    meals: OFF_MEALS,
    subjects: [{ name: 'Physics', minutes: 60 }],
    prefs: DEFAULT_PREFS,
    lockedBlocks: [{ name: 'Physics', start: lockStart, end: lockEnd }],
  });
  printEvents(result.events);

  check('ran without an error or lock conflict', () => {
    assert.equal(result.error, undefined);
    assert.deepEqual(result.lockConflicts, []);
  });
  check('Physics is still at exactly 2:00 PM - 3:00 PM and marked locked', () => {
    const blocks = result.events.filter((e) => e.type === 'study' && e.name === 'Physics');
    assert.equal(blocks.length, 1, `expected 1 Physics block, found ${blocks.length}`);
    assert.equal(blocks[0].start, lockStart);
    assert.equal(blocks[0].end, lockEnd);
    assert.equal(blocks[0].locked, true);
  });
  check('no additional Physics time was scheduled (60 requested, 60 locked)', () => {
    assert.equal(studyMinutesFor(result.events, 'Physics'), 60);
  });
});

// ---------------------------------------------------------------------------
scenario('B. Remaining requested minutes are calculated correctly around a locked block', () => {
  // Physics requested 90 min; 60 of it is already locked at 7:00-8:00 AM —
  // only the remaining 30 min should be newly scheduled.
  const result = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '22:00',
    classes: [],
    meals: OFF_MEALS,
    subjects: [{ name: 'Physics', minutes: 90 }],
    prefs: DEFAULT_PREFS,
    lockedBlocks: [{ name: 'Physics', start: timeToMinutes('07:00'), end: timeToMinutes('08:00') }],
  });
  printEvents(result.events);

  check('ran without an error or lock conflict', () => {
    assert.equal(result.error, undefined);
    assert.deepEqual(result.lockConflicts, []);
  });
  check('locked portion stays 60 min', () => {
    assert.equal(studyMinutesFor(result.events, 'Physics', { lockedOnly: true }), 60);
  });
  check('exactly 30 additional minutes were scheduled — not another full 90', () => {
    assert.equal(studyMinutesFor(result.events, 'Physics', { unlockedOnly: true }), 30);
  });
  check('total Physics time (locked + new) equals the 90-minute request', () => {
    assert.equal(studyMinutesFor(result.events, 'Physics'), 90);
  });
  check('no shortfall note (the full 90 minutes was accounted for)', () => {
    assert.ok(!result.notes.some((n) => /short/i.test(n)), `notes: ${JSON.stringify(result.notes)}`);
  });
});

// ---------------------------------------------------------------------------
scenario('C. Two locked study blocks both survive regeneration', () => {
  const physicsStart = timeToMinutes('07:00');
  const physicsEnd = timeToMinutes('07:30');
  const historyStart = timeToMinutes('08:00');
  const historyEnd = timeToMinutes('08:30');
  const result = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '20:00',
    classes: [],
    meals: OFF_MEALS,
    subjects: [
      { name: 'Physics', minutes: 30 },
      { name: 'History', minutes: 30 },
    ],
    prefs: DEFAULT_PREFS,
    lockedBlocks: [
      { name: 'Physics', start: physicsStart, end: physicsEnd },
      { name: 'History', start: historyStart, end: historyEnd },
    ],
  });
  printEvents(result.events);

  check('ran without an error or lock conflict', () => {
    assert.equal(result.error, undefined);
    assert.deepEqual(result.lockConflicts, []);
  });
  check('Physics is unchanged and locked', () => {
    const b = result.events.find((e) => e.type === 'study' && e.name === 'Physics');
    assert.ok(b && b.start === physicsStart && b.end === physicsEnd && b.locked);
  });
  check('History is unchanged and locked', () => {
    const b = result.events.find((e) => e.type === 'study' && e.name === 'History');
    assert.ok(b && b.start === historyStart && b.end === historyEnd && b.locked);
  });
  check('no extra study blocks were created (both requests fully covered by locks)', () => {
    const studyBlocks = result.events.filter((e) => e.type === 'study');
    assert.equal(studyBlocks.length, 2, `expected 2 study blocks, found ${studyBlocks.length}`);
  });
});

// ---------------------------------------------------------------------------
scenario('D. Other study blocks never overlap a locked block', () => {
  const lockStart = timeToMinutes('13:00');
  const lockEnd = timeToMinutes('14:00');
  const result = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '20:00',
    classes: [],
    meals: OFF_MEALS,
    subjects: [
      { name: 'Physics', minutes: 60 }, // fully covered by the lock
      { name: 'English essay', minutes: 120 },
    ],
    prefs: DEFAULT_PREFS,
    lockedBlocks: [{ name: 'Physics', start: lockStart, end: lockEnd }],
  });
  printEvents(result.events);

  check('ran without an error or lock conflict', () => {
    assert.equal(result.error, undefined);
    assert.deepEqual(result.lockConflicts, []);
  });
  check('no event overlaps the locked 1:00-2:00 PM block', () => {
    for (const e of result.events) {
      if (e.locked) continue;
      const overlaps = e.start < lockEnd && e.end > lockStart;
      assert.ok(!overlaps, `"${e.name}" (${formatClock(e.start)}-${formatClock(e.end)}) overlaps the locked block`);
    }
  });
  check('no overlaps anywhere in the full schedule', () => assertNoOverlaps(result.events));
});

// ---------------------------------------------------------------------------
scenario('E. Locked block conflicting with a class is detected', () => {
  const result = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '22:00',
    classes: [{ name: 'Math', start: '09:00', end: '10:00' }],
    meals: OFF_MEALS,
    subjects: [{ name: 'Physics', minutes: 60 }],
    prefs: DEFAULT_PREFS,
    lockedBlocks: [{ name: 'Physics', start: timeToMinutes('09:10'), end: timeToMinutes('10:10') }],
  });
  console.log(`  lockConflicts: ${JSON.stringify(result.lockConflicts, null, 2)}`);

  check('a lock conflict is reported', () => assert.ok(result.lockConflicts.length > 0));
  check('the conflict message names both the locked subject and the class', () => {
    assert.ok(result.lockConflicts.some((c) => c.includes('Physics') && c.includes('Math')));
  });
  check('no schedule was produced (nothing silently moved)', () => assert.equal(result.events.length, 0));
});

// ---------------------------------------------------------------------------
scenario('F. Locked block conflicting with a meal is detected', () => {
  const result = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '22:00',
    classes: [],
    meals: [{ name: 'Lunch', duration: 45, on: true, time: '12:00' }],
    subjects: [{ name: 'Physics', minutes: 60 }],
    prefs: DEFAULT_PREFS,
    lockedBlocks: [{ name: 'Physics', start: timeToMinutes('12:10'), end: timeToMinutes('13:10') }],
  });
  console.log(`  lockConflicts: ${JSON.stringify(result.lockConflicts, null, 2)}`);

  check('a lock conflict is reported', () => assert.ok(result.lockConflicts.length > 0));
  check('the conflict message names both the locked subject and the meal', () => {
    assert.ok(result.lockConflicts.some((c) => c.includes('Physics') && c.includes('Lunch')));
  });
  check('no schedule was produced (nothing silently moved)', () => assert.equal(result.events.length, 0));
});

// ---------------------------------------------------------------------------
scenario('G. Locked block outside wake/bedtime is detected', () => {
  const result = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '22:00',
    classes: [],
    meals: OFF_MEALS,
    subjects: [{ name: 'Physics', minutes: 60 }],
    prefs: DEFAULT_PREFS,
    // 5:00-6:00 AM — before the 7:00 AM wake-up time
    lockedBlocks: [{ name: 'Physics', start: timeToMinutes('05:00'), end: timeToMinutes('06:00') }],
  });
  console.log(`  lockConflicts: ${JSON.stringify(result.lockConflicts, null, 2)}`);

  check('a lock conflict is reported', () => assert.ok(result.lockConflicts.length > 0));
  check('the conflict message mentions the wake-up/bedtime window', () => {
    assert.ok(result.lockConflicts.some((c) => c.includes('Physics') && /wake-up\/bedtime/.test(c)));
  });
  check('no schedule was produced (nothing silently moved)', () => assert.equal(result.events.length, 0));
});

// ---------------------------------------------------------------------------
scenario('H. Locked blocks work on a day that crosses midnight', () => {
  // wake 7:00 AM, sleep 1:00 AM next day — locked block sits AFTER midnight
  const lockStart = timeToMinutes('00:00') + 1440; // 12:00 AM next day
  const lockEnd = timeToMinutes('00:30') + 1440; // 12:30 AM next day
  const result = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '01:00',
    classes: [],
    meals: OFF_MEALS,
    subjects: [{ name: 'Physics', minutes: 30 }],
    prefs: DEFAULT_PREFS,
    lockedBlocks: [{ name: 'Physics', start: lockStart, end: lockEnd }],
  });
  printEvents(result.events);
  const dayStart = timeToMinutes('07:00');
  const dayEnd = 25 * 60; // 1:00 AM next day

  check('ran without an error or lock conflict', () => {
    assert.equal(result.error, undefined);
    assert.deepEqual(result.lockConflicts, []);
  });
  check('the post-midnight locked block is preserved exactly', () => {
    const b = result.events.find((e) => e.type === 'study' && e.name === 'Physics');
    assert.ok(b && b.locked);
    assert.equal(b.start, lockStart);
    assert.equal(b.end, lockEnd);
  });
  check('no overlaps anywhere', () => assertNoOverlaps(result.events));
  check('everything stays within the wake-to-bedtime day', () => assertWithinDay(result.events, dayStart, dayEnd));
});

// ---------------------------------------------------------------------------
scenario('I. Regeneration still respects priority for unlocked subjects', () => {
  // An unrelated locked block eats into the only free gap (7:00-10:00, 180 min),
  // leaving 150 min for two competing subjects.
  const result = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '22:00',
    classes: [{ name: 'Busy', start: '10:00', end: '22:00' }],
    meals: OFF_MEALS,
    subjects: [
      { name: 'Low priority task', minutes: 120, priority: 'low' },
      { name: 'High priority task', minutes: 120, priority: 'high' },
    ],
    prefs: DEFAULT_PREFS,
    lockedBlocks: [{ name: 'Reserved', start: timeToMinutes('07:00'), end: timeToMinutes('07:30') }],
  });
  printEvents(result.events);

  check('ran without an error or lock conflict', () => {
    assert.equal(result.error, undefined);
    assert.deepEqual(result.lockConflicts, []);
  });
  check('the unrelated locked block is preserved', () => {
    const b = result.events.find((e) => e.name === 'Reserved');
    assert.ok(b && b.locked && b.start === timeToMinutes('07:00') && b.end === timeToMinutes('07:30'));
  });
  check('high-priority task is fully scheduled (120 min)', () => {
    assert.equal(studyMinutesFor(result.events, 'High priority task'), 120);
  });
  check('low-priority task is not fully scheduled (less than 120 min — the lock and the higher-priority task left it short)', () => {
    const mins = studyMinutesFor(result.events, 'Low priority task');
    assert.ok(mins < 120, `scheduled ${mins} minutes`);
  });
  check('no overlaps anywhere', () => assertNoOverlaps(result.events));
});

// ---------------------------------------------------------------------------
scenario('J. Regeneration with locks + multiple subjects still produces no overlaps anywhere', () => {
  const result = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '23:30',
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
      { name: 'Physics', minutes: 90, priority: 'high', dueDate: '2026-09-20' },
      { name: 'English essay', minutes: 45, priority: 'medium' },
      { name: 'Chemistry', minutes: 60, priority: 'low', dueDate: '2026-10-01' },
    ],
    prefs: DEFAULT_PREFS,
    lockedBlocks: [{ name: 'Physics', start: timeToMinutes('14:00'), end: timeToMinutes('15:00') }],
  });
  printEvents(result.events);
  const dayStart = timeToMinutes('07:00');
  const dayEnd = timeToMinutes('23:30');

  check('ran without an error or lock conflict', () => {
    assert.equal(result.error, undefined);
    assert.deepEqual(result.lockConflicts, []);
  });
  check('locked Physics block is unchanged', () => {
    const b = result.events.find((e) => e.type === 'study' && e.name === 'Physics' && e.locked);
    assert.ok(b && b.start === timeToMinutes('14:00') && b.end === timeToMinutes('15:00'));
  });
  check('no overlaps anywhere in the full schedule', () => assertNoOverlaps(result.events));
  check('everything stays within the wake-to-bedtime day', () => assertWithinDay(result.events, dayStart, dayEnd));
});

// ---------------------------------------------------------------------------
scenario('K. Lock state survives the database save/load representation', () => {
  // Simulates the round trip dashboard.js/data.js perform: generate → shape
  // events as schedule_items DB rows (start_minutes/end_minutes/locked) →
  // read them back into the {name,start,end} shape generateSchedule expects
  // for lockedBlocks — without an actual Supabase connection (not available
  // in this test environment), but exercising the exact same field mapping.
  const first = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '20:00',
    classes: [],
    meals: OFF_MEALS,
    subjects: [{ name: 'Physics', minutes: 60 }],
    prefs: DEFAULT_PREFS,
    lockedBlocks: [],
  });
  const physicsBlock = first.events.find((e) => e.type === 'study' && e.name === 'Physics');

  // "save": shape like a schedule_items row (see data.js saveGeneratedSchedule / supabase/migrations/0001_*.sql)
  const dbRow = {
    id: 'fake-row-id',
    item_type: physicsBlock.type,
    name: physicsBlock.name,
    start_minutes: physicsBlock.start,
    end_minutes: physicsBlock.end,
    locked: true, // the user pressed Lock after the first generate
  };

  // "load": shape back the way dashboard.js reads schedule_items rows
  const lockedBlocksFromDb = [dbRow]
    .filter((r) => r.item_type === 'study' && r.locked)
    .map((r) => ({ name: r.name, start: r.start_minutes, end: r.end_minutes }));

  const second = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '20:00',
    classes: [],
    meals: OFF_MEALS,
    subjects: [{ name: 'Physics', minutes: 60 }],
    prefs: DEFAULT_PREFS,
    lockedBlocks: lockedBlocksFromDb,
  });
  printEvents(second.events);

  check('the round-tripped lock produces no conflicts', () => assert.deepEqual(second.lockConflicts, []));
  check('Physics survives the save/load round trip at the same time, marked locked', () => {
    const b = second.events.find((e) => e.type === 'study' && e.name === 'Physics');
    assert.ok(b);
    assert.equal(b.start, physicsBlock.start);
    assert.equal(b.end, physicsBlock.end);
    assert.equal(b.locked, true);
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
