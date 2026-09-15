// Plain Node tests for the pure Notifications logic in
// src/notifications/notificationsModel.js. No DOM, no Notification API, no
// localStorage, and no real OS notification is ever sent — every
// calculation here (reminder-time math, eligibility, deadline
// classification, duplicate prevention, settings defaults, permission-
// state mapping) is deterministic and testable with plain input/output
// pairs. Run with `npm test` or `node tests/notifications.test.js`.

import assert from 'node:assert/strict';
import {
  VALID_LEAD_MINUTES,
  DEFAULT_NOTIFICATION_SETTINGS,
  normalizeLeadMinutes,
  normalizeNotificationSettings,
  classifyPermissionState,
  isEligibleForStudyReminder,
  computeReminderTime,
  isStudyReminderDue,
  formatStudyReminderText,
  classifyDeadlineReminderType,
  formatDeadlineReminderText,
  buildStudyReminderKey,
  buildDeadlineReminderKey,
  shouldNotify,
  markNotified,
} from '../src/notifications/notificationsModel.js';

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
scenario('A. Reminder-time calculation (computeReminderTime)', () => {
  check('a 19:00 (1140-minute) block with a 10-minute lead reminds at 18:50 (1130)', () => {
    assert.equal(computeReminderTime(19 * 60, 10), 18 * 60 + 50);
  });
  check('each of the four offered lead times computes correctly', () => {
    assert.equal(computeReminderTime(600, 5), 595);
    assert.equal(computeReminderTime(600, 10), 590);
    assert.equal(computeReminderTime(600, 15), 585);
    assert.equal(computeReminderTime(600, 30), 570);
  });
  check('an overnight block past 1440 minutes stays in the same absolute-minute space', () => {
    // 12:15 AM the next day, per the scheduler's own overnight convention -> 1455
    assert.equal(computeReminderTime(1455, 15), 1440);
  });
  check('a non-finite block start returns null rather than NaN', () => {
    assert.equal(computeReminderTime(NaN, 10), null);
    assert.equal(computeReminderTime(undefined, 10), null);
  });
});

// ---------------------------------------------------------------------------
scenario('B. Invalid reminder offset (normalizeLeadMinutes)', () => {
  check('every one of the four offered options passes through unchanged', () => {
    VALID_LEAD_MINUTES.forEach((v) => assert.equal(normalizeLeadMinutes(v), v));
  });
  check('a value outside the offered options falls back to the default (10)', () => {
    assert.equal(normalizeLeadMinutes(7), 10);
    assert.equal(normalizeLeadMinutes(60), 10);
    assert.equal(normalizeLeadMinutes(0), 10);
    assert.equal(normalizeLeadMinutes(-5), 10);
  });
  check('a numeric string from a <select> value is coerced before validating', () => {
    assert.equal(normalizeLeadMinutes('15'), 15);
    assert.equal(normalizeLeadMinutes('99'), 10);
  });
  check('missing/non-numeric input falls back to the default rather than crashing', () => {
    assert.equal(normalizeLeadMinutes(undefined), 10);
    assert.equal(normalizeLeadMinutes(null), 10);
    assert.equal(normalizeLeadMinutes('abc'), 10);
  });
  check('computeReminderTime itself normalizes an invalid lead rather than propagating it', () => {
    assert.equal(computeReminderTime(600, 999), 600 - 10);
  });
});

// ---------------------------------------------------------------------------
scenario('C. Study reminder eligibility + due-window (isEligibleForStudyReminder / isStudyReminderDue)', () => {
  check('a study block with a valid start and not completed is eligible', () => {
    assert.equal(isEligibleForStudyReminder({ type: 'study', start: 600, completed: false }), true);
  });
  check('a non-study item (class/meal/break/free) is never eligible', () => {
    assert.equal(isEligibleForStudyReminder({ type: 'class', start: 600, completed: false }), false);
  });
  check('an already-completed study block is never eligible', () => {
    assert.equal(isEligibleForStudyReminder({ type: 'study', start: 600, completed: true }), false);
  });
  check('a block with a non-finite start is never eligible', () => {
    assert.equal(isEligibleForStudyReminder({ type: 'study', start: NaN, completed: false }), false);
  });

  check('isStudyReminderDue is true once "now" reaches the reminder time but before the block starts', () => {
    const item = { type: 'study', name: 'Calculus', start: 1140, completed: false }; // 19:00
    assert.equal(isStudyReminderDue(item, 1130, 10), true); // 18:50, exactly the reminder time
    assert.equal(isStudyReminderDue(item, 1135, 10), true); // 18:55, still before start
  });
  check('isStudyReminderDue is false before the reminder window opens', () => {
    const item = { type: 'study', name: 'Calculus', start: 1140, completed: false };
    assert.equal(isStudyReminderDue(item, 1100, 10), false); // 18:20, too early
  });
  check('isStudyReminderDue is false once the block has actually started', () => {
    const item = { type: 'study', name: 'Calculus', start: 1140, completed: false };
    assert.equal(isStudyReminderDue(item, 1140, 10), false);
    assert.equal(isStudyReminderDue(item, 1200, 10), false);
  });
  check('isStudyReminderDue is false for an ineligible item regardless of timing', () => {
    assert.equal(isStudyReminderDue({ type: 'study', start: 1140, completed: true }, 1135, 10), false);
    assert.equal(isStudyReminderDue({ type: 'class', start: 1140, completed: false }, 1135, 10), false);
  });
});

// ---------------------------------------------------------------------------
scenario('D. Study reminder text (formatStudyReminderText)', () => {
  check('matches the example from the brief: "Calculus starts in 10 minutes"', () => {
    const text = formatStudyReminderText('Calculus', 10, { startsIn: 'starts in', minutes: 'minutes' });
    assert.equal(text, 'Calculus starts in 10 minutes');
  });
  check('an invalid lead is normalized before formatting', () => {
    const text = formatStudyReminderText('Calculus', 999, { startsIn: 'starts in', minutes: 'minutes' });
    assert.ok(text.includes('10'));
  });
  check('a missing/blank item name falls back to a safe placeholder rather than "undefined"', () => {
    const text = formatStudyReminderText('', 10, { untitled: 'Study session', startsIn: 'starts in', minutes: 'minutes' });
    assert.ok(text.startsWith('Study session'));
  });
});

// ---------------------------------------------------------------------------
scenario('E. Deadline reminder eligibility (classifyDeadlineReminderType)', () => {
  const today = '2026-09-18';
  check('a subject due exactly today classifies as due_today', () => {
    assert.equal(classifyDeadlineReminderType('2026-09-18', today), 'due_today');
  });
  check('a subject due exactly tomorrow classifies as due_tomorrow', () => {
    assert.equal(classifyDeadlineReminderType('2026-09-19', today), 'due_tomorrow');
  });
  check('a subject due further in the future is not eligible', () => {
    assert.equal(classifyDeadlineReminderType('2026-09-25', today), null);
  });
  check('an overdue subject (due in the past) is not eligible for this reminder type', () => {
    assert.equal(classifyDeadlineReminderType('2026-09-10', today), null);
  });
  check('no due date at all is not eligible', () => {
    assert.equal(classifyDeadlineReminderType(null, today), null);
    assert.equal(classifyDeadlineReminderType(undefined, today), null);
  });
});

// ---------------------------------------------------------------------------
scenario('F. Deadline reminder text (formatDeadlineReminderText)', () => {
  check('due_today produces an "is due today" message', () => {
    const text = formatDeadlineReminderText('Essay', 'due_today', { dueToday: 'is due today', dueTomorrow: 'is due tomorrow' });
    assert.equal(text, 'Essay is due today');
  });
  check('due_tomorrow produces an "is due tomorrow" message', () => {
    const text = formatDeadlineReminderText('Essay', 'due_tomorrow', { dueToday: 'is due today', dueTomorrow: 'is due tomorrow' });
    assert.equal(text, 'Essay is due tomorrow');
  });
  check('a missing subject name falls back to a safe placeholder', () => {
    const text = formatDeadlineReminderText('', 'due_today', { untitled: 'Task', dueToday: 'is due today' });
    assert.ok(text.startsWith('Task'));
  });
});

// ---------------------------------------------------------------------------
scenario('G. Duplicate notification prevention (shouldNotify / markNotified)', () => {
  check('a fresh key with an empty seen-set should notify', () => {
    assert.equal(shouldNotify('study:item1', new Set()), true);
  });
  check('a key already in the seen-set should NOT notify again', () => {
    const seen = new Set(['study:item1']);
    assert.equal(shouldNotify('study:item1', seen), false);
  });
  check('markNotified returns a NEW Set containing the key, without mutating the input', () => {
    const before = new Set(['a']);
    const after = markNotified(before, 'b');
    assert.equal(before.has('b'), false, 'the original set must be untouched');
    assert.equal(after.has('a'), true);
    assert.equal(after.has('b'), true);
    assert.notEqual(before, after);
  });
  check('a full create -> check -> mark -> re-check cycle prevents a second notification for the same key', () => {
    let seen = new Set();
    const key = buildStudyReminderKey('item42');
    assert.equal(shouldNotify(key, seen), true);
    seen = markNotified(seen, key);
    assert.equal(shouldNotify(key, seen), false);
  });
  check('study and deadline reminder keys for the same underlying id never collide', () => {
    const studyKey = buildStudyReminderKey('subject1');
    const deadlineKey = buildDeadlineReminderKey('subject1', 'due_today');
    assert.notEqual(studyKey, deadlineKey);
  });
  check('due_today and due_tomorrow for the same subject are tracked as distinct notifications', () => {
    const todayKey = buildDeadlineReminderKey('subject1', 'due_today');
    const tomorrowKey = buildDeadlineReminderKey('subject1', 'due_tomorrow');
    assert.notEqual(todayKey, tomorrowKey);
  });
});

// ---------------------------------------------------------------------------
scenario('H. Settings defaults (normalizeNotificationSettings)', () => {
  check('both reminder kinds default OFF and the lead time defaults to 10 — opt-in, never assumed', () => {
    assert.deepEqual(DEFAULT_NOTIFICATION_SETTINGS, { studyRemindersEnabled: false, deadlineRemindersEnabled: false, leadMinutes: 10 });
  });
  check('null/undefined/garbage stored settings normalize to the full default object', () => {
    assert.deepEqual(normalizeNotificationSettings(null), DEFAULT_NOTIFICATION_SETTINGS);
    assert.deepEqual(normalizeNotificationSettings(undefined), DEFAULT_NOTIFICATION_SETTINGS);
    assert.deepEqual(normalizeNotificationSettings('not an object'), DEFAULT_NOTIFICATION_SETTINGS);
    assert.deepEqual(normalizeNotificationSettings(42), DEFAULT_NOTIFICATION_SETTINGS);
  });
  check('a partial stored object is merged onto the defaults, not replaced wholesale', () => {
    const result = normalizeNotificationSettings({ studyRemindersEnabled: true });
    assert.equal(result.studyRemindersEnabled, true);
    assert.equal(result.deadlineRemindersEnabled, false);
    assert.equal(result.leadMinutes, 10);
  });
  check('a non-boolean truthy value for an enabled flag is coerced to a real boolean', () => {
    const result = normalizeNotificationSettings({ studyRemindersEnabled: 'yes' });
    assert.equal(result.studyRemindersEnabled, false); // strictly === true only, "yes" is not accepted as truthy-magic
  });
  check('an invalid stored leadMinutes normalizes to the default', () => {
    const result = normalizeNotificationSettings({ leadMinutes: 999 });
    assert.equal(result.leadMinutes, 10);
  });
});

// ---------------------------------------------------------------------------
scenario('I. Permission-state handling helpers (classifyPermissionState)', () => {
  check('an unsupported browser is classified "unsupported" regardless of the permission value', () => {
    assert.equal(classifyPermissionState('granted', false), 'unsupported');
    assert.equal(classifyPermissionState(undefined, false), 'unsupported');
  });
  check('a supported browser with permission "granted" is classified "granted"', () => {
    assert.equal(classifyPermissionState('granted', true), 'granted');
  });
  check('a supported browser with permission "denied" is classified "denied"', () => {
    assert.equal(classifyPermissionState('denied', true), 'denied');
  });
  check('a supported browser that has not been asked yet ("default") is classified "default"', () => {
    assert.equal(classifyPermissionState('default', true), 'default');
    assert.equal(classifyPermissionState(undefined, true), 'default');
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
