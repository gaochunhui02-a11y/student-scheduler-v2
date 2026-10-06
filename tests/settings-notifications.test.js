// Tests for V2-F Settings: granular notification options
// (notificationsModel.js) and Data export (src/shared/dataExport.js).
// Plain Node, no DOM, no Supabase. Run with `npm test` or
// `node tests/settings-notifications.test.js`.

import assert from 'node:assert/strict';
import {
  normalizeNotificationSettings,
  isDeadlineReminderTypeEnabled,
  isMissedReminderDue,
  buildMissedReminderKey,
  formatMissedReminderText,
  shouldNotify,
  markNotified,
  MISSED_GRACE_MINUTES,
  MISSED_WINDOW_MINUTES,
} from '../src/notifications/notificationsModel.js';
import { EXPORT_TABLES, buildExportPayload, buildExportFilename, totalExportedRows } from '../src/shared/dataExport.js';

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
scenario('A. Settings migrate cleanly from the pre-V2-F shape', () => {
  check('old saved settings keep both deadline reminder kinds on', () => {
    const s = normalizeNotificationSettings({ studyRemindersEnabled: true, deadlineRemindersEnabled: true, leadMinutes: 15 });
    assert.equal(s.deadlineDueToday, true);
    assert.equal(s.deadlineDueTomorrow, true);
    assert.equal(s.missedRemindersEnabled, false);
    assert.equal(s.leadMinutes, 15);
  });
  check('sub-options turn off only on an explicit false', () => {
    const s = normalizeNotificationSettings({ deadlineDueToday: false, deadlineDueTomorrow: 'no' });
    assert.equal(s.deadlineDueToday, false);
    assert.equal(s.deadlineDueTomorrow, true);
  });
  check('missed reminders need an explicit true (opt-in)', () => {
    assert.equal(normalizeNotificationSettings({ missedRemindersEnabled: 'yes' }).missedRemindersEnabled, false);
    assert.equal(normalizeNotificationSettings({ missedRemindersEnabled: true }).missedRemindersEnabled, true);
  });
});

// ---------------------------------------------------------------------------
scenario('B. Deadline sub-options', () => {
  const base = normalizeNotificationSettings({ deadlineRemindersEnabled: true });
  check('both on by default when the master toggle is on', () => {
    assert.equal(isDeadlineReminderTypeEnabled(base, 'due_today'), true);
    assert.equal(isDeadlineReminderTypeEnabled(base, 'due_tomorrow'), true);
  });
  check('each sub-option is independent', () => {
    const s = { ...base, deadlineDueTomorrow: false };
    assert.equal(isDeadlineReminderTypeEnabled(s, 'due_today'), true);
    assert.equal(isDeadlineReminderTypeEnabled(s, 'due_tomorrow'), false);
  });
  check('master toggle off silences everything', () => {
    const s = normalizeNotificationSettings({ deadlineRemindersEnabled: false });
    assert.equal(isDeadlineReminderTypeEnabled(s, 'due_today'), false);
    assert.equal(isDeadlineReminderTypeEnabled(s, 'due_tomorrow'), false);
  });
  check('unknown type / no settings -> false', () => {
    assert.equal(isDeadlineReminderTypeEnabled(base, 'overdue'), false);
    assert.equal(isDeadlineReminderTypeEnabled(null, 'due_today'), false);
  });
});

// ---------------------------------------------------------------------------
scenario('C. Missed-session reminder timing (no spam)', () => {
  const block = { id: 'b1', type: 'study', name: 'Calculus', start: 600, end: 660, completed: false, missed: false, completedMinutes: 0 };
  const dueAt = 660 + MISSED_GRACE_MINUTES;
  check('not before the grace period ends', () => {
    assert.equal(isMissedReminderDue(block, 659), false);
    assert.equal(isMissedReminderDue(block, dueAt - 1), false);
  });
  check('due from end + grace, inside the window', () => {
    assert.equal(isMissedReminderDue(block, dueAt), true);
    assert.equal(isMissedReminderDue(block, dueAt + MISSED_WINDOW_MINUTES - 1), true);
  });
  check('silent once the window has passed (no evening burst)', () => {
    assert.equal(isMissedReminderDue(block, dueAt + MISSED_WINDOW_MINUTES), false);
    assert.equal(isMissedReminderDue(block, 1400), false);
  });
  check('never for completed, already-missed, fully logged, unsaved or non-study blocks', () => {
    assert.equal(isMissedReminderDue({ ...block, completed: true }, dueAt), false);
    assert.equal(isMissedReminderDue({ ...block, missed: true }, dueAt), false);
    assert.equal(isMissedReminderDue({ ...block, completedMinutes: 60 }, dueAt), false);
    assert.equal(isMissedReminderDue({ ...block, id: null }, dueAt), false);
    assert.equal(isMissedReminderDue({ ...block, type: 'class' }, dueAt), false);
    assert.equal(isMissedReminderDue(null, dueAt), false);
  });
  check('a partly logged block still counts as missed', () => {
    assert.equal(isMissedReminderDue({ ...block, completedMinutes: 20 }, dueAt), true);
  });
  check('fires once per block per session via the existing dedupe keys', () => {
    const key = buildMissedReminderKey('b1');
    let seen = new Set();
    assert.equal(shouldNotify(key, seen), true);
    seen = markNotified(seen, key);
    assert.equal(shouldNotify(key, seen), false);
    assert.notEqual(key, 'study:b1'); // distinct from the "starts soon" key
  });
  check('text', () => {
    assert.equal(formatMissedReminderText('Calculus', { endedNotDone: 'ended' }), 'Calculus ended');
    assert.match(formatMissedReminderText('  '), /^Study session /);
  });
});

// ---------------------------------------------------------------------------
scenario('D. Data export payload', () => {
  const tables = {
    schedules: [{ id: 's1' }, { id: 's2' }],
    classes: [{ id: 'c1' }],
    study_subjects: [],
    boards: [{ id: 'b1' }],
    unrelated_table: [{ id: 'x' }],
  };
  const errors = { class_series: 'relation does not exist', study_subject_subtasks: 'relation does not exist' };
  const payload = buildExportPayload({ tables, errors, exportedAt: '2026-10-06T10:00:00.000Z' });

  check('self-describing header', () => {
    assert.equal(payload.format, 'student-scheduler-export');
    assert.equal(payload.version, 1);
    assert.equal(payload.exportedAt, '2026-10-06T10:00:00.000Z');
  });
  check('every known table appears (missing -> []), unknown tables are dropped', () => {
    const expected = EXPORT_TABLES.filter((t) => !errors[t]);
    assert.deepEqual(Object.keys(payload.tables), expected);
    assert.deepEqual(payload.tables.board_edges, []);
    assert.equal('unrelated_table' in payload.tables, false);
  });
  check('unreadable tables are listed as skipped, not silently empty', () => {
    assert.deepEqual(payload.skipped.map((s) => s.table).sort(), ['class_series', 'study_subject_subtasks']);
    assert.equal('class_series' in payload.tables, false);
  });
  check('counts and total', () => {
    assert.equal(payload.counts.schedules, 2);
    assert.equal(totalExportedRows(payload), 4);
    assert.equal(totalExportedRows(null), 0);
  });
  check('filename', () => {
    assert.equal(buildExportFilename('2026-10-06'), 'student-scheduler-export-2026-10-06.json');
    assert.equal(buildExportFilename('../evil'), 'student-scheduler-export-data.json');
  });
  check('defaults are safe', () => {
    const p = buildExportPayload({ exportedAt: 'x' });
    assert.equal(totalExportedRows(p), 0);
    assert.deepEqual(p.skipped, []);
  });
});

console.log('\n------------------------');
if (totalFailures > 0) {
  console.log(`${totalFailures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
