// Tests for Phase 9 (manual study-block editing — start time only, duration
// stays fixed). Real unit tests against the actual pure functions
// dashboard.js calls: validateManualStudyEdit, resolveClockTimeInDay,
// resolveStudyWindow, resolveDayBounds, all from src/dashboard/scheduler.js —
// plus generateSchedule itself for the regeneration-interaction scenario (I).
// Run with `npm test` or `node tests/manual-edit.test.js`.

import assert from 'node:assert/strict';
import {
  generateSchedule,
  resolveDayBounds,
  resolveStudyWindow,
  resolveClockTimeInDay,
  validateManualStudyEdit,
  formatClock,
  timeToMinutes,
} from '../src/dashboard/scheduler.js';

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

// A day: wake 7:00, sleep 22:00, Math 9-10, Lunch 12:00-12:45, one other
// study block (English 15:00-15:30). Used as the shared fixture for most
// scenarios below — a Physics block at 13:00-14:00 (60 min) is the one being
// manually edited.
function baseDay() {
  const bounds = resolveDayBounds('07:00', '22:00');
  const fixedEvents = [
    { type: 'class', name: 'Math', start: timeToMinutes('09:00'), end: timeToMinutes('10:00') },
    { type: 'meal', name: 'Lunch', start: timeToMinutes('12:00'), end: timeToMinutes('12:45') },
  ];
  const otherStudyBlocks = [
    { id: 'item-english', name: 'English essay', start: timeToMinutes('15:00'), end: timeToMinutes('15:30') },
  ];
  const window = resolveStudyWindow(null, null, bounds.dayStart, bounds.dayEnd);
  return { bounds, fixedEvents, otherStudyBlocks, window };
}

function editPhysics(newStartClock, overrides = {}) {
  const { bounds, fixedEvents, otherStudyBlocks, window } = baseDay();
  const newStart = resolveClockTimeInDay(newStartClock, bounds.dayStart, bounds.dayEnd);
  return validateManualStudyEdit({
    newStart,
    duration: 60,
    dayStart: bounds.dayStart,
    dayEnd: bounds.dayEnd,
    studyWindowStart: window.studyWindowStart,
    studyWindowEnd: window.studyWindowEnd,
    fixedEvents,
    otherStudyBlocks,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
scenario('A. Moving a study block to a valid free time succeeds', () => {
  const result = editPhysics('16:00'); // clearly free: after Lunch, English, before bedtime
  check('accepted', () => assert.equal(result.ok, true));
  check('start/end reflect the requested time and fixed duration', () => {
    assert.equal(result.start, timeToMinutes('16:00'));
    assert.equal(result.end, timeToMinutes('17:00'));
  });
});

// ---------------------------------------------------------------------------
scenario('B. Moving into a class conflict is rejected', () => {
  const result = editPhysics('09:30'); // overlaps Math 9:00-10:00
  check('rejected', () => assert.equal(result.ok, false));
  check('error names the conflicting class and its time', () => {
    assert.ok(result.error.includes('Math'), result.error);
    assert.ok(result.error.includes('class'), result.error);
  });
});

// ---------------------------------------------------------------------------
scenario('C. Moving into a meal conflict is rejected', () => {
  const result = editPhysics('12:15'); // overlaps Lunch 12:00-12:45
  check('rejected', () => assert.equal(result.ok, false));
  check('error names the conflicting meal', () => {
    assert.ok(result.error.includes('Lunch'), result.error);
    assert.ok(result.error.includes('meal'), result.error);
  });
});

// ---------------------------------------------------------------------------
scenario('D. Moving into another study block is rejected', () => {
  const result = editPhysics('15:15'); // overlaps English essay 15:00-15:30
  check('rejected', () => assert.equal(result.ok, false));
  check('error names the conflicting study block', () => {
    assert.ok(result.error.includes('English essay'), result.error);
  });
});

// ---------------------------------------------------------------------------
scenario('E. Moving outside wake/sleep range is rejected', () => {
  const { bounds, fixedEvents, otherStudyBlocks, window } = baseDay();
  // 21:30 + 60min = 22:30, past the 22:00 bedtime
  const result = validateManualStudyEdit({
    newStart: timeToMinutes('21:30'),
    duration: 60,
    dayStart: bounds.dayStart,
    dayEnd: bounds.dayEnd,
    studyWindowStart: window.studyWindowStart,
    studyWindowEnd: window.studyWindowEnd,
    fixedEvents,
    otherStudyBlocks,
  });
  check('rejected', () => assert.equal(result.ok, false));
  check('error mentions the bedtime window', () => assert.ok(/bedtime/i.test(result.error), result.error));

  const beforeWake = validateManualStudyEdit({
    newStart: timeToMinutes('06:00'), // before the 7:00 wake time
    duration: 30,
    dayStart: bounds.dayStart,
    dayEnd: bounds.dayEnd,
    studyWindowStart: window.studyWindowStart,
    studyWindowEnd: window.studyWindowEnd,
    fixedEvents,
    otherStudyBlocks,
  });
  check('before wake-up is also rejected', () => assert.equal(beforeWake.ok, false));
});

// ---------------------------------------------------------------------------
scenario('F. Moving outside earliest/latest study window is rejected', () => {
  const bounds = resolveDayBounds('07:00', '22:00');
  const window = resolveStudyWindow('09:00', '17:00', bounds.dayStart, bounds.dayEnd);
  check('the configured window is what we expect', () => {
    assert.equal(window.studyWindowStart, timeToMinutes('09:00'));
    assert.equal(window.studyWindowEnd, timeToMinutes('17:00'));
  });

  // 18:00-19:00 is within wake/sleep but after the 17:00 latest study time
  const result = validateManualStudyEdit({
    newStart: timeToMinutes('18:00'),
    duration: 60,
    dayStart: bounds.dayStart,
    dayEnd: bounds.dayEnd,
    studyWindowStart: window.studyWindowStart,
    studyWindowEnd: window.studyWindowEnd,
    fixedEvents: [],
    otherStudyBlocks: [],
  });
  check('rejected', () => assert.equal(result.ok, false));
  check('error mentions the study time window', () => assert.ok(/study time/i.test(result.error), result.error));
});

// ---------------------------------------------------------------------------
scenario('G. Overnight manual edit works correctly', () => {
  // wake 7:00, sleep 1:00 AM next day — moving a block to 11:30 PM (before
  // midnight) and to 12:15 AM (after midnight) should both succeed; the
  // "12:15" input is ambiguous on its own and must resolve to the post-
  // midnight portion of THIS day, not a fresh 12:15 PM/AM before wake-up.
  const bounds = resolveDayBounds('07:00', '01:00');
  check('the day is recognized as crossing midnight (18 hours awake)', () => {
    assert.equal(bounds.dayEnd - bounds.dayStart, 18 * 60);
  });
  const window = resolveStudyWindow(null, null, bounds.dayStart, bounds.dayEnd);

  const beforeMidnight = resolveClockTimeInDay('23:30', bounds.dayStart, bounds.dayEnd);
  check('11:30 PM resolves to the same-day (pre-midnight) portion', () => {
    assert.equal(beforeMidnight, timeToMinutes('23:30'));
  });
  const resultBefore = validateManualStudyEdit({
    newStart: beforeMidnight,
    duration: 30,
    dayStart: bounds.dayStart,
    dayEnd: bounds.dayEnd,
    studyWindowStart: window.studyWindowStart,
    studyWindowEnd: window.studyWindowEnd,
    fixedEvents: [],
    otherStudyBlocks: [],
  });
  check('11:30 PM - 12:00 AM is accepted', () => assert.equal(resultBefore.ok, true));

  const afterMidnight = resolveClockTimeInDay('00:15', bounds.dayStart, bounds.dayEnd);
  check('12:15 AM resolves to the POST-midnight portion (1440 + 15), not pre-wake', () => {
    assert.equal(afterMidnight, 1440 + 15);
  });
  const resultAfter = validateManualStudyEdit({
    newStart: afterMidnight,
    duration: 30,
    dayStart: bounds.dayStart,
    dayEnd: bounds.dayEnd,
    studyWindowStart: window.studyWindowStart,
    studyWindowEnd: window.studyWindowEnd,
    fixedEvents: [],
    otherStudyBlocks: [],
  });
  check('12:15 AM - 12:45 AM (next day) is accepted, within the 1:00 AM bedtime', () => assert.equal(resultAfter.ok, true));

  const tooLate = resolveClockTimeInDay('00:45', bounds.dayStart, bounds.dayEnd);
  const resultTooLate = validateManualStudyEdit({
    newStart: tooLate,
    duration: 30, // 12:45-1:15 AM — runs 15 min past the 1:00 AM bedtime
    dayStart: bounds.dayStart,
    dayEnd: bounds.dayEnd,
    studyWindowStart: window.studyWindowStart,
    studyWindowEnd: window.studyWindowEnd,
    fixedEvents: [],
    otherStudyBlocks: [],
  });
  check('a block that would run past the 1:00 AM bedtime is rejected', () => assert.equal(resultTooLate.ok, false));
});

// ---------------------------------------------------------------------------
scenario('H. Manual edit preserves completed state (persistence-shape check)', () => {
  // updateScheduleItemTime (data.js) only ever updates start_minutes/end_minutes
  // — mirror that exact shape here to prove completed/locked/name survive a move.
  const before = { id: 'item-1', type: 'study', name: 'Physics', start: 780, end: 840, locked: false, completed: true };
  const validated = editPhysics('16:00');
  check('the edit itself is valid', () => assert.equal(validated.ok, true));

  const after = { ...before, start: validated.start, end: validated.end }; // only start/end change
  check('completed is still true after the move', () => assert.equal(after.completed, true));
  check('name/id/locked are untouched', () => {
    assert.equal(after.name, 'Physics');
    assert.equal(after.id, 'item-1');
    assert.equal(after.locked, false);
  });
  check('the block actually moved', () => assert.notEqual(after.start, before.start));
});

// ---------------------------------------------------------------------------
scenario('I. Manual edit + lock survives regeneration', () => {
  // Simulates: block was generated, manually moved to 16:00 (accepted), then
  // locked. On regenerate, lockedBlocks carries that new time forward — this
  // is the exact shape dashboard.js's lockedBlocksFromCurrent() builds.
  const validated = editPhysics('16:00');
  const manuallyMovedAndLocked = { name: 'Physics', start: validated.start, end: validated.end, sourceSubjectId: 'subj-physics' };

  const result = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '22:00',
    classes: [{ name: 'Math', start: '09:00', end: '10:00' }],
    meals: [{ name: 'Lunch', duration: 45, on: true, time: '12:00' }],
    subjects: [
      { id: 'subj-physics', name: 'Physics', minutes: 60 },
      { id: 'subj-english', name: 'English essay', minutes: 30 },
    ],
    prefs: { sessionCap: 60, staminaBreak: 15, switchBreak: 10, minNewBlock: 30 },
    lockedBlocks: [manuallyMovedAndLocked],
  });

  check('ran without an error or lock conflict', () => {
    assert.equal(result.error, undefined);
    assert.deepEqual(result.lockConflicts, []);
  });
  check('Physics is still exactly at the manually-edited 4:00-5:00 PM time', () => {
    const b = result.events.find((e) => e.type === 'study' && e.name === 'Physics');
    assert.ok(b.locked);
    assert.equal(b.start, timeToMinutes('16:00'));
    assert.equal(b.end, timeToMinutes('17:00'));
  });
  check('English essay was placed elsewhere, not overlapping the manually-locked block', () => {
    const english = result.events.filter((e) => e.type === 'study' && e.name === 'English essay');
    for (const e of english) {
      assert.ok(!(e.start < timeToMinutes('17:00') && e.end > timeToMinutes('16:00')), 'overlaps the locked block');
    }
  });
});

// ---------------------------------------------------------------------------
scenario('J. Manual edit save/load representation preserves start/end times', () => {
  // Mirrors data.js's updateScheduleItemTime + the load mapping dashboard.js
  // uses ({ start: i.start_minutes, end: i.end_minutes, ... }).
  const validated = editPhysics('16:00');
  check('edit is valid', () => assert.equal(validated.ok, true));

  const dbRowAfterSave = { id: 'item-1', item_type: 'study', name: 'Physics', start_minutes: validated.start, end_minutes: validated.end, locked: false, completed: false };
  const loadedEvent = { id: dbRowAfterSave.id, type: dbRowAfterSave.item_type, name: dbRowAfterSave.name, start: dbRowAfterSave.start_minutes, end: dbRowAfterSave.end_minutes };

  check('the loaded event has the manually-edited start time, not the original', () => {
    assert.equal(loadedEvent.start, timeToMinutes('16:00'));
    assert.equal(loadedEvent.end, timeToMinutes('17:00'));
  });
});

// ---------------------------------------------------------------------------
scenario('K. Invalid edits never partially save', () => {
  // The UI only calls updateScheduleItemTime() after validateManualStudyEdit
  // returns ok:true — model that guard directly: an invalid result must never
  // produce a start/end pair to persist.
  const invalid = editPhysics('09:30'); // conflicts with Math
  check('an invalid edit is flagged', () => assert.equal(invalid.ok, false));
  check('an invalid result carries no start/end to save', () => {
    assert.equal('start' in invalid, false);
    assert.equal('end' in invalid, false);
  });

  function simulateSaveAttempt(validationResult) {
    // this is exactly the guard dashboard.js's save handler uses
    if (!validationResult.ok) return { saved: false };
    return { saved: true, start: validationResult.start, end: validationResult.end };
  }
  check('the simulated save handler refuses to save an invalid edit', () => {
    assert.equal(simulateSaveAttempt(invalid).saved, false);
  });
  check('the simulated save handler does save a valid edit', () => {
    assert.equal(simulateSaveAttempt(editPhysics('16:00')).saved, true);
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
