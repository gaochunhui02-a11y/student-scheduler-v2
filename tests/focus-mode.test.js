// Tests for Focus Mode (V2-C). Plain Node, no DOM, no Supabase. Covers:
//
// 1. Timestamp-based timer math in focusMode.js — elapsed/remaining,
//    pause/resume, backgrounded-tab gaps, clock skew, formatting.
// 2. buildFocusCompletionWrite — proving a Focus Mode write is the same
//    (completedMinutes, completed) pair the Partial Completion panel
//    produces, and reads identically through carryOverModel.js and
//    analyticsModel.js afterwards.
// 3. analyticsModel.js's effectiveActualMinutes / computeActualVsPlanned.
//
// Run with `npm test` or `node tests/focus-mode.test.js`.

import assert from 'node:assert/strict';
import {
  createFocusSession,
  isPaused,
  getElapsedMs,
  getRemainingMs,
  isTimeUp,
  pauseSession,
  resumeSession,
  getFocusedMinutes,
  formatCountdown,
  buildFocusCompletionWrite,
  computeTodaySessionProgress,
  serializeSession,
  parseStoredSession,
  canStartFocus,
} from '../src/dashboard/focusMode.js';
import { computeRemainingMinutes, isFullyCompletedByMinutes, validateCompletedMinutesInput } from '../src/dashboard/carryOverModel.js';
import {
  computeWeeklyTotals,
  computeSubjectTotals,
  effectiveActualMinutes,
  computeActualVsPlanned,
} from '../src/analytics/analyticsModel.js';

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

const MIN = 60000;
const T0 = 1_760_000_000_000;

// ---------------------------------------------------------------------------
scenario('A. Basic countdown', () => {
  const s = createFocusSession({ itemId: 'b1', plannedMinutes: 45, now: T0 });
  check('starts running, nothing elapsed', () => {
    assert.equal(isPaused(s), false);
    assert.equal(getElapsedMs(s, T0), 0);
    assert.equal(getRemainingMs(s, T0), 45 * MIN);
  });
  check('12m42s later shows 32:18 remaining', () => {
    assert.equal(formatCountdown(getRemainingMs(s, T0 + 12 * MIN + 42000)), '32:18');
  });
  check('remaining never goes negative, time is up', () => {
    assert.equal(getRemainingMs(s, T0 + 90 * MIN), 0);
    assert.equal(isTimeUp(s, T0 + 90 * MIN), true);
    assert.equal(isTimeUp(s, T0 + 44 * MIN), false);
  });
  check('focused minutes cap at the planned length (no overtime credit)', () => {
    assert.equal(getFocusedMinutes(s, T0 + 30 * MIN + 59000), 30);
    assert.equal(getFocusedMinutes(s, T0 + 200 * MIN), 45);
  });
});

// ---------------------------------------------------------------------------
scenario('B. Pause / resume', () => {
  let s = createFocusSession({ itemId: 'b1', plannedMinutes: 60, now: T0 });
  s = pauseSession(s, T0 + 10 * MIN);
  check('paused after 10 min', () => {
    assert.equal(isPaused(s), true);
    assert.equal(getElapsedMs(s, T0 + 10 * MIN), 10 * MIN);
  });
  check('time while paused is not counted', () => {
    assert.equal(getElapsedMs(s, T0 + 55 * MIN), 10 * MIN);
  });
  s = resumeSession(s, T0 + 55 * MIN);
  check('resume continues from 10 min', () => {
    assert.equal(getElapsedMs(s, T0 + 60 * MIN), 15 * MIN);
    assert.equal(getRemainingMs(s, T0 + 60 * MIN), 45 * MIN);
  });
  check('double pause is a no-op (no double counting)', () => {
    const p1 = pauseSession(s, T0 + 61 * MIN);
    const p2 = pauseSession(p1, T0 + 70 * MIN);
    assert.deepEqual(p2, p1);
    assert.equal(getElapsedMs(p2, T0 + 99 * MIN), 16 * MIN);
  });
  check('double resume is a no-op (does not reset runningSince)', () => {
    const r = resumeSession(s, T0 + 80 * MIN);
    assert.deepEqual(r, s);
  });
});

// ---------------------------------------------------------------------------
scenario('C. Backgrounded tab and clock skew', () => {
  const s = createFocusSession({ itemId: 'b1', plannedMinutes: 30, now: T0 });
  check('a 20-minute gap with no ticks is still exact', () => {
    // No intermediate calls at all — simulates a throttled background tab.
    assert.equal(getRemainingMs(s, T0 + 20 * MIN), 10 * MIN);
  });
  check('clock jumping backwards contributes 0, never negative', () => {
    assert.equal(getElapsedMs(s, T0 - 5 * MIN), 0);
    assert.equal(getRemainingMs(s, T0 - 5 * MIN), 30 * MIN);
  });
});

// ---------------------------------------------------------------------------
scenario('D. formatCountdown', () => {
  check('m:ss', () => assert.equal(formatCountdown(5 * MIN + 7000), '5:07'));
  check('h:mm:ss over an hour', () => assert.equal(formatCountdown(62 * MIN + 5000), '1:02:05'));
  check('rounds up partial seconds (never 0:00 early)', () => assert.equal(formatCountdown(400), '0:01'));
  check('zero and negative', () => {
    assert.equal(formatCountdown(0), '0:00');
    assert.equal(formatCountdown(-5000), '0:00');
  });
});

// ---------------------------------------------------------------------------
scenario('E. Completion writes match the existing Partial Completion model', () => {
  const duration = 90;
  const s = createFocusSession({ itemId: 'b1', plannedMinutes: duration, now: T0 });

  check('Complete after 72 min: completed=true, 72 actual minutes', () => {
    const w = buildFocusCompletionWrite({ kind: 'complete', session: s, now: T0 + 72 * MIN + 30000, duration });
    assert.deepEqual(w, { completedMinutes: 72, completed: true });
  });
  check('Complete immediately records full duration (same as plain Done)', () => {
    const w = buildFocusCompletionWrite({ kind: 'complete', session: s, now: T0 + 20000, duration });
    assert.deepEqual(w, { completedMinutes: 90, completed: true });
  });
  check('Stop early after 40 min: partial 40, not completed', () => {
    const w = buildFocusCompletionWrite({ kind: 'stop', session: s, now: T0 + 40 * MIN, duration });
    assert.deepEqual(w, { completedMinutes: 40, completed: false });
    // Same value the Partial Completion panel would accept and produce.
    const v = validateCompletedMinutesInput(String(w.completedMinutes), duration);
    assert.equal(v.ok, true);
    assert.equal(isFullyCompletedByMinutes(v.value, duration), w.completed);
  });
  check('Stop after the timer ran out counts as fully completed', () => {
    const w = buildFocusCompletionWrite({ kind: 'stop', session: s, now: T0 + 120 * MIN, duration });
    assert.deepEqual(w, { completedMinutes: 90, completed: true });
  });
  check('Stop with no time spent writes 0 (harmless, leaves block open)', () => {
    const w = buildFocusCompletionWrite({ kind: 'stop', session: s, now: T0 + 10000, duration });
    assert.deepEqual(w, { completedMinutes: 0, completed: false });
  });

  check('re-focusing a 30/90 block counts down 60 and adds to the 30', () => {
    const s2 = createFocusSession({ itemId: 'b1', plannedMinutes: 60, baseCompletedMinutes: 30, now: T0 });
    const stop = buildFocusCompletionWrite({ kind: 'stop', session: s2, now: T0 + 25 * MIN, duration });
    assert.deepEqual(stop, { completedMinutes: 55, completed: false });
    const done = buildFocusCompletionWrite({ kind: 'complete', session: s2, now: T0 + 50 * MIN, duration });
    assert.deepEqual(done, { completedMinutes: 80, completed: true });
  });

  check('a stopped block reads the same through carryOverModel', () => {
    const w = buildFocusCompletionWrite({ kind: 'stop', session: s, now: T0 + 40 * MIN, duration });
    const row = { type: 'study', start: 600, end: 690, completed: w.completed, completedMinutes: w.completedMinutes };
    assert.equal(computeRemainingMinutes(row), 50);
  });
  check('a completed-early block has 0 remaining (never carried over)', () => {
    const w = buildFocusCompletionWrite({ kind: 'complete', session: s, now: T0 + 72 * MIN, duration });
    const row = { type: 'study', start: 600, end: 690, completed: w.completed, completedMinutes: w.completedMinutes };
    assert.equal(computeRemainingMinutes(row), 0);
  });
});

// ---------------------------------------------------------------------------
scenario('F. Completed-early block: full completion credit, real actual time', () => {
  const items = [
    // Focus Mode Complete after 72 of 90
    { item_type: 'study', date: '2026-10-06', start_minutes: 600, end_minutes: 690, completed: true, completed_minutes: 72, source_subject_id: 's1' },
    // Plain Done, no timing data
    { item_type: 'study', date: '2026-10-06', start_minutes: 700, end_minutes: 760, completed: true, completed_minutes: 0, source_subject_id: 's2' },
    // Focus Mode Stop after 20 of 45
    { item_type: 'study', date: '2026-10-06', start_minutes: 800, end_minutes: 845, completed: false, completed_minutes: 20, source_subject_id: 's1' },
    // Untouched
    { item_type: 'study', date: '2026-10-06', start_minutes: 900, end_minutes: 930, completed: false, completed_minutes: 0, source_subject_id: 's2' },
  ];
  const subjects = [
    { id: 's1', name: 'Calculus', minutes_requested: 150 },
    { id: 's2', name: 'Biology', minutes_requested: 90 },
  ];

  check('weekly Completed totals are unchanged by Focus Mode (90 + 60 + 20)', () => {
    const w = computeWeeklyTotals(items, ['2026-10-06']);
    assert.equal(w.totalPlanned, 225);
    assert.equal(w.totalCompleted, 170);
  });
  check('subject Completed totals are unchanged by Focus Mode', () => {
    const t = computeSubjectTotals(subjects, items);
    assert.equal(t.find((r) => r.subject === 'Calculus').completed, 110);
    assert.equal(t.find((r) => r.subject === 'Biology').completed, 60);
  });
  check('effectiveActualMinutes per block', () => {
    assert.equal(effectiveActualMinutes(items[0], 90), 72);
    assert.equal(effectiveActualMinutes(items[1], 60), 60);
    assert.equal(effectiveActualMinutes(items[2], 45), 20);
    assert.equal(effectiveActualMinutes(items[3], 30), 0);
  });
  check('actual is clamped to the block duration', () => {
    assert.equal(effectiveActualMinutes({ completed: true, completed_minutes: 500 }, 60), 60);
    assert.equal(effectiveActualMinutes({ completed: false, completed_minutes: -4 }, 60), 0);
  });
  check('computeActualVsPlanned: estimated / planned / actual per subject', () => {
    const r = computeActualVsPlanned(subjects, items);
    assert.deepEqual(r.subjects, [
      { subject: 'Calculus', estimated: 150, planned: 135, actual: 92 },
      { subject: 'Biology', estimated: 90, planned: 90, actual: 60 },
    ]);
    assert.deepEqual(r.totals, { estimated: 240, planned: 225, actual: 152 });
  });
  check('subjects with nothing estimated or planned are omitted', () => {
    const r = computeActualVsPlanned([{ id: 'x', name: 'Empty', minutes_requested: 0 }], []);
    assert.deepEqual(r.subjects, []);
    assert.deepEqual(r.totals, { estimated: 0, planned: 0, actual: 0 });
  });
  check('non-study and unlinked blocks are ignored; empty input is safe', () => {
    const r = computeActualVsPlanned(subjects, [
      { item_type: 'class', start_minutes: 0, end_minutes: 60, source_subject_id: 's1' },
      { item_type: 'study', start_minutes: 0, end_minutes: 60, completed: true },
    ]);
    assert.equal(r.totals.planned, 0);
    assert.doesNotThrow(() => computeActualVsPlanned(null, null));
  });
});

// ---------------------------------------------------------------------------
scenario('G. Today progress, eligibility, persistence', () => {
  check('today session progress counts study blocks only', () => {
    const p = computeTodaySessionProgress([
      { type: 'study', completed: true },
      { type: 'study', completed: true },
      { type: 'study', completed: false },
      { type: 'study' },
      { type: 'class', completed: true },
    ]);
    assert.deepEqual(p, { done: 2, total: 4 });
    assert.deepEqual(computeTodaySessionProgress(null), { done: 0, total: 0 });
  });

  const base = { id: 'b1', type: 'study', start: 600, end: 690, completed: false, locked: false, completedMinutes: 0 };
  check('open study block can start focus', () => assert.equal(canStartFocus(base), true));
  check('completed / locked / unsaved / non-study / fully-logged cannot', () => {
    assert.equal(canStartFocus({ ...base, completed: true }), false);
    assert.equal(canStartFocus({ ...base, locked: true }), false);
    assert.equal(canStartFocus({ ...base, id: undefined }), false);
    assert.equal(canStartFocus({ ...base, type: 'class' }), false);
    assert.equal(canStartFocus({ ...base, completedMinutes: 90 }), false);
    assert.equal(canStartFocus(null), false);
  });

  check('serialize → parse round-trips a running and a paused session', () => {
    const running = createFocusSession({ itemId: 'b1', plannedMinutes: 45, baseCompletedMinutes: 10, now: T0 });
    assert.deepEqual(parseStoredSession(serializeSession(running)), running);
    const paused = pauseSession(running, T0 + 5 * MIN);
    assert.deepEqual(parseStoredSession(serializeSession(paused)), paused);
  });
  check('a reloaded running session resumes with correct remaining time', () => {
    const running = createFocusSession({ itemId: 'b1', plannedMinutes: 45, now: T0 });
    const restored = parseStoredSession(serializeSession(running));
    assert.equal(getRemainingMs(restored, T0 + 15 * MIN), 30 * MIN);
  });
  check('malformed stored data is rejected', () => {
    assert.equal(parseStoredSession(null), null);
    assert.equal(parseStoredSession(''), null);
    assert.equal(parseStoredSession('{not json'), null);
    assert.equal(parseStoredSession('[]'), null);
    assert.equal(parseStoredSession(JSON.stringify({ itemId: 'b1' })), null);
    assert.equal(
      parseStoredSession(JSON.stringify({ itemId: 'b1', plannedMs: -1, accumulatedMs: 0, baseCompletedMinutes: 0, runningSince: null })),
      null
    );
    assert.equal(
      parseStoredSession(JSON.stringify({ itemId: 'b1', plannedMs: 1, accumulatedMs: 0, baseCompletedMinutes: 0, runningSince: 'x' })),
      null
    );
  });
});

console.log(`\n${totalFailures === 0 ? 'ALL PASSED' : `${totalFailures} FAILURE(S)`}`);
if (totalFailures > 0) process.exit(1);
