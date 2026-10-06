// Tests for V2 items 10 (manual scheduling: duration + nudges) and 11
// (Schedule conflicts panel). Plain Node, no DOM, no Supabase.
// Run with `npm test` or `node tests/manual-edit-conflicts.test.js`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateBlockDuration, nudgeClock, MIN_BLOCK_DURATION, MAX_BLOCK_DURATION } from '../src/dashboard/manualEditModel.js';
import { detectScheduleConflicts, classesToMinutes } from '../src/dashboard/conflictModel.js';
import { generateSchedule, validateManualStudyEdit, timeToMinutes } from '../src/dashboard/scheduler.js';
import { tMessage } from '../src/shared/i18n.js';

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

const range = (s, e) => `${s}-${e}`;

// ---------------------------------------------------------------------------
scenario('A. Block duration validation', () => {
  check('valid durations pass, rounded to whole minutes', () => {
    assert.deepEqual(validateBlockDuration('45'), { ok: true, value: 45 });
    assert.deepEqual(validateBlockDuration(44.6), { ok: true, value: 45 });
  });
  check('out of range is rejected with a translatable key', () => {
    assert.equal(validateBlockDuration(String(MIN_BLOCK_DURATION - 1)).errorKey, 'manualEdit.errDurationRange');
    assert.equal(validateBlockDuration(MAX_BLOCK_DURATION + 1).errorKey, 'manualEdit.errDurationRange');
    assert.equal(validateBlockDuration('').errorKey, 'manualEdit.errDuration');
    assert.equal(validateBlockDuration('abc').errorKey, 'manualEdit.errDuration');
  });
  check('cannot shrink below minutes already logged', () => {
    const r = validateBlockDuration('30', { completedMinutes: 40 });
    assert.equal(r.ok, false);
    assert.equal(r.errorKey, 'manualEdit.errBelowLogged');
    assert.equal(r.errorParams.minutes, 40);
    assert.equal(validateBlockDuration('40', { completedMinutes: 40 }).ok, true);
  });
  check('messages render without leftover placeholders', () => {
    assert.doesNotMatch(tMessage(validateBlockDuration('1')), /\{\w+\}/);
    assert.doesNotMatch(tMessage(validateBlockDuration('30', { completedMinutes: 40 })), /\{\w+\}/);
  });
  check('a longer block is still checked by the existing placement rule', () => {
    // 9:00 block lengthened to 120 min runs into a 10:00 class -> rejected
    const r = validateManualStudyEdit({
      newStart: 540,
      duration: validateBlockDuration('120').value,
      dayStart: 420,
      dayEnd: 1380,
      studyWindowStart: 420,
      studyWindowEnd: 1380,
      fixedEvents: [{ type: 'class', name: 'Chem', start: 600, end: 675 }],
      otherStudyBlocks: [],
    });
    assert.equal(r.ok, false);
    assert.equal(r.errorKey, 'schedulerMsg.conflict');
  });
});

// ---------------------------------------------------------------------------
scenario('B. Start-time nudges', () => {
  check('±15 minutes, wrapping at midnight', () => {
    assert.equal(nudgeClock('09:00', 15), '09:15');
    assert.equal(nudgeClock('09:00', -15), '08:45');
    assert.equal(nudgeClock('23:50', 15), '00:05');
    assert.equal(nudgeClock('00:05', -15), '23:50');
  });
  check('invalid input -> null', () => {
    assert.equal(nudgeClock('', 15), null);
    assert.equal(nudgeClock('9:00', 15), null);
    assert.equal(nudgeClock('25:00', 15), null);
  });
});

// ---------------------------------------------------------------------------
scenario('C. Conflict detection', () => {
  const classes = [
    { name: 'Calculus', start: 840, end: 920 }, // 14:00-15:20
    { name: 'Biology', start: 900, end: 960 }, // 15:00-16:00 -> overlaps Calculus
    { name: 'Late lab', start: 1400, end: 1430 }, // after a 23:00 bedtime
    { name: '', start: 600, end: 660 }, // incomplete row: ignored
  ];
  const items = [
    { id: 's1', type: 'study', name: 'Essay', start: 870, end: 930 }, // overlaps Calculus (classes edited after planning)
    { id: 's2', type: 'study', name: 'Reading', start: 1000, end: 1060 },
    { id: 's3', type: 'study', name: 'Review', start: 1030, end: 1090, locked: true }, // overlaps Reading
    { id: 'c', type: 'class', name: 'Calculus', start: 840, end: 920 }, // class block itself is not a conflict
  ];
  const conflicts = detectScheduleConflicts({ classes, items, dayStart: 420, dayEnd: 1380, formatRange: range });
  const kinds = conflicts.map((c) => c.kind);

  check('overlapping classes, once per pair, with the overlap range', () => {
    const o = conflicts.filter((c) => c.kind === 'class_overlap');
    assert.equal(o.length, 1);
    assert.deepEqual(o[0].params, { a: 'Calculus', b: 'Biology', range: '900-920' });
    assert.equal(o[0].action, 'edit_classes');
  });
  check('class outside wake/sleep window -> edit_day', () => {
    const o = conflicts.filter((c) => c.kind === 'class_outside_day');
    assert.deepEqual(o.map((c) => c.params.name), ['Late lab']);
    assert.equal(o[0].action, 'edit_day');
  });
  check('study block now overlapping a class -> move that block', () => {
    const o = conflicts.find((c) => c.key === 'conflicts.studyOverlapsClass');
    assert.equal(o.params.name, 'Essay');
    assert.equal(o.action, 'edit_block');
    assert.equal(o.itemId, 's1');
  });
  check('two overlapping study blocks -> move the UNLOCKED one', () => {
    const o = conflicts.find((c) => c.key === 'conflicts.studyOverlapsStudy');
    assert.equal(o.itemId, 's2');
    assert.equal(o.action, 'edit_block');
  });
  check('a clean day has no conflicts', () => {
    assert.deepEqual(detectScheduleConflicts({ classes: [{ name: 'A', start: 540, end: 600 }], items: [], dayStart: 420, dayEnd: 1380, formatRange: range }), []);
    assert.deepEqual(detectScheduleConflicts({ formatRange: range }), []);
  });
  check('overnight day: a 00:30 class after a 01:00 bedtime is inside the day', () => {
    const r = detectScheduleConflicts({ classes: [{ name: 'Night', start: 30, end: 50 }], dayStart: 600, dayEnd: 1500, formatRange: range });
    assert.deepEqual(r, []);
  });
  check('lock conflicts and insufficient time join the same list', () => {
    const r = detectScheduleConflicts({
      lockConflictDetails: [{ key: 'schedulerMsg.lockOverlap', params: { a: 'X', rangeA: '1', b: 'Y', rangeB: '2' } }, { error: 'legacy text' }],
      shortfall: { unscheduledTotal: 105 },
      formatRange: range,
    });
    assert.deepEqual(r.map((c) => c.kind), ['lock_conflict', 'lock_conflict', 'insufficient_time']);
    assert.equal(r[1].error, 'legacy text');
    assert.equal(r[2].params.minutes, 105);
    assert.equal(r[2].action, 'shortfall_details');
  });
  check('every conflict key exists and renders without placeholders', () => {
    const all = [...conflicts, ...detectScheduleConflicts({ shortfall: { unscheduledTotal: 30 }, formatRange: range })];
    all.forEach((c) => assert.doesNotMatch(tMessage({ key: c.key, params: c.params }), /\{\w+\}/, c.key));
    assert.ok(kinds.includes('study_conflict'));
  });
  check('classesToMinutes converts the Planner rows', () => {
    assert.deepEqual(classesToMinutes([{ name: ' Chem ', start: '09:00', end: '10:15' }], timeToMinutes), [{ name: 'Chem', start: 540, end: 615 }]);
  });
});

// ---------------------------------------------------------------------------
scenario('D. Locked-block conflicts are translatable too', () => {
  check('generateSchedule returns lockConflictDetails alongside the strings', () => {
    const r = generateSchedule({
      wakeTime: '07:00',
      sleepTime: '22:00',
      classes: [{ name: 'Chem', start: '10:00', end: '11:00' }],
      meals: [],
      subjects: [{ id: 's', name: 'Calc', minutes: 60 }],
      prefs: { sessionCap: 60, staminaBreak: 15, switchBreak: 10, minNewBlock: 30 },
      lockedBlocks: [{ id: 'l', name: 'Calc', start: 600, end: 660, sourceSubjectId: 's' }],
    });
    assert.ok(r.lockConflicts.length >= 1);
    assert.equal(r.lockConflictDetails.length, r.lockConflicts.length);
    r.lockConflictDetails.forEach((d) => assert.doesNotMatch(tMessage(d), /\{\w+\}/));
  });
});

// ---------------------------------------------------------------------------
scenario('E. Wiring', () => {
  const src = readFileSync(join(__dirname, '../src/dashboard/dashboard.js'), 'utf8');
  check('duration edits go through validateBlockDuration AND validateManualStudyEdit', () => {
    const save = src.slice(src.indexOf("const saveBtn = e.target.closest('.edit-save-btn')"), src.indexOf('await updateScheduleItemTime(id, result.start, result.end)'));
    assert.match(save, /validateBlockDuration\(/);
    assert.match(save, /duration: durationCheck\.value/);
    assert.match(save, /validateManualStudyEdit\(/);
  });
  check('the old separate lock-conflict card is gone; one conflicts panel remains', () => {
    const html = readFileSync(join(__dirname, '../dashboard.html'), 'utf8');
    assert.doesNotMatch(html, /id="lockConflictWarning"/);
    assert.match(html, /id="conflictPanel"/);
  });
});

console.log('\n------------------------');
if (totalFailures > 0) {
  console.log(`${totalFailures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
