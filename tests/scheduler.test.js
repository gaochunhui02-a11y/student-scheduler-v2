// Plain Node test for the pure scheduling algorithm — no framework, no DOM,
// no Supabase. Run with `npm test` or `node tests/scheduler.test.js`.

import assert from 'node:assert/strict';
import { generateSchedule, formatClock } from '../src/dashboard/scheduler.js';

const DAY_END = 25 * 60; // 1:00 AM next day, measured from midnight of day 1

const input = {
  wakeTime: '07:00',
  sleepTime: '01:00', // <= wakeTime, so the algorithm treats it as "next day"
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
  // matches the DB defaults in supabase/schema.sql
  prefs: { sessionCap: 60, staminaBreak: 15, switchBreak: 10, minNewBlock: 30 },
};

const result = generateSchedule(input);

console.log('--- Scheduler output ---');
if (result.error) {
  console.log('error:', result.error);
} else {
  for (const e of result.events) {
    console.log(`${formatClock(e.start)} - ${formatClock(e.end)}  [${e.type}] ${e.name}`);
  }
}
if (result.notes.length) {
  console.log('--- Notes ---');
  result.notes.forEach((n) => console.log(n));
}
console.log('------------------------');

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`PASS  ${label}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${label}`);
    console.log(`      ${e.message}`);
  }
}

check('generateSchedule ran without an error', () => {
  assert.equal(result.error, undefined);
});

check('Physics is a single continuous 60-minute block', () => {
  const blocks = result.events.filter((e) => e.type === 'study' && e.name === 'Physics');
  assert.equal(blocks.length, 1, `expected 1 Physics block, found ${blocks.length}`);
  assert.equal(blocks[0].end - blocks[0].start, 60, `expected 60 minutes, got ${blocks[0].end - blocks[0].start}`);
});

check('English essay is a single continuous 45-minute block', () => {
  const blocks = result.events.filter((e) => e.type === 'study' && e.name === 'English essay');
  assert.equal(blocks.length, 1, `expected 1 English essay block, found ${blocks.length}`);
  assert.equal(blocks[0].end - blocks[0].start, 45, `expected 45 minutes, got ${blocks[0].end - blocks[0].start}`);
});

check('No study block overlaps a class or meal', () => {
  const study = result.events.filter((e) => e.type === 'study');
  const fixed = result.events.filter((e) => e.type === 'class' || e.type === 'meal');
  for (const s of study) {
    for (const f of fixed) {
      const overlaps = s.start < f.end && s.end > f.start;
      assert.ok(!overlaps, `"${s.name}" (${formatClock(s.start)}-${formatClock(s.end)}) overlaps "${f.name}" (${formatClock(f.start)}-${formatClock(f.end)})`);
    }
  }
});

check('Nothing is scheduled after 1:00 AM next day', () => {
  for (const e of result.events) {
    assert.ok(e.end <= DAY_END, `"${e.name}" ends at ${formatClock(e.end)}, after the 1:00 AM cutoff`);
  }
});

check('The full schedule has no overlaps at all', () => {
  const sorted = [...result.events].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(
      sorted[i].start >= sorted[i - 1].end,
      `"${sorted[i - 1].name}" (${formatClock(sorted[i - 1].start)}-${formatClock(sorted[i - 1].end)}) overlaps "${sorted[i].name}" (${formatClock(sorted[i].start)}-${formatClock(sorted[i].end)})`
    );
  }
});

console.log('------------------------');
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
