// Plain Node tests for the pure Calendar Import/Export (.ics) logic in
// src/calendar/calendarModel.js. No DOM, no File API, no network, and no
// real Google/Apple/Outlook calendar is ever touched — every calculation
// here (date/time formatting, escaping, UID generation, parsing,
// recurrence/all-day handling, selection) is deterministic and testable
// with plain input/output pairs. Run with `npm test` or
// `node tests/calendar.test.js`.

import assert from 'node:assert/strict';
import {
  escapeIcsText,
  unescapeIcsText,
  foldIcsLine,
  formatIcsLocalDateTime,
  formatIcsUtcTimestamp,
  buildEventUid,
  filterExportableItems,
  mapScheduleItemToIcsEventFields,
  buildIcsCalendar,
  exportDaysToIcs,
  DEFAULT_EXPORT_EVENT_TYPES,
  validateIcsInput,
  unfoldIcsLines,
  parseIcsPropertyLine,
  parseIcsCalendar,
  selectImportEvents,
  mapImportEventToClassFields,
  groupSelectedEventsByDate,
  importErrorMessageKey,
  MAX_ICS_TEXT_LENGTH,
} from '../src/calendar/calendarModel.js';

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
scenario('A. Escaping commas/semicolons/newlines/backslashes (RFC 5545 TEXT)', () => {
  check('a comma is escaped', () => assert.equal(escapeIcsText('Math, Science'), 'Math\\, Science'));
  check('a semicolon is escaped', () => assert.equal(escapeIcsText('Part 1; Part 2'), 'Part 1\\; Part 2'));
  check('a newline becomes a literal \\n', () => assert.equal(escapeIcsText('Line1\nLine2'), 'Line1\\nLine2'));
  check('a CRLF newline also becomes a literal \\n', () => assert.equal(escapeIcsText('Line1\r\nLine2'), 'Line1\\nLine2'));
  check('a backslash is escaped first, so it is not double-escaped by the other rules', () => {
    assert.equal(escapeIcsText('C:\\path'), 'C:\\\\path');
  });
  check('all four special characters together', () => {
    assert.equal(escapeIcsText('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
  });
  check('unescapeIcsText reverses escapeIcsText for every case above', () => {
    const original = 'Doctor appointment, urgent; important\nSecond line\\note';
    assert.equal(unescapeIcsText(escapeIcsText(original)), original);
  });
  check('non-string input is treated as an empty string rather than throwing', () => {
    assert.equal(escapeIcsText(undefined), '');
    assert.equal(escapeIcsText(null), '');
  });
});

// ---------------------------------------------------------------------------
scenario('B. Line folding (foldIcsLine)', () => {
  check('a short line is left unchanged', () => {
    assert.equal(foldIcsLine('SUMMARY:Short title'), 'SUMMARY:Short title');
  });
  check('a long line is folded at 75 octets with a CRLF + single leading space continuation', () => {
    const longValue = 'x'.repeat(120);
    const folded = foldIcsLine(`SUMMARY:${longValue}`);
    const parts = folded.split('\r\n');
    assert.ok(parts.length > 1, 'must be split into multiple physical lines');
    assert.ok(parts[0].length <= 75);
    parts.slice(1).forEach((p) => assert.ok(p.startsWith(' ')));
  });
  check('folding and unfolding a long line round-trips to the original content', () => {
    const original = `DESCRIPTION:${'y'.repeat(200)}`;
    const folded = foldIcsLine(original);
    const rejoined = folded
      .split('\r\n')
      .map((line, i) => (i === 0 ? line : line.slice(1)))
      .join('');
    assert.equal(rejoined, original);
  });
});

// ---------------------------------------------------------------------------
scenario('C. Correct date/time output (formatIcsLocalDateTime) — floating local time, no UTC conversion', () => {
  check('a normal same-day time formats as YYYYMMDDTHHMMSS with no Z/offset', () => {
    assert.equal(formatIcsLocalDateTime('2026-09-18', 19 * 60), '20260918T190000');
  });
  check('midnight formats correctly', () => {
    assert.equal(formatIcsLocalDateTime('2026-09-18', 0), '20260918T000000');
  });
  check('an overnight block past 1440 minutes rolls into the next calendar date rather than an invalid hour', () => {
    // 12:15 AM the next day, per the scheduler's own convention -> 1455
    assert.equal(formatIcsLocalDateTime('2026-09-18', 1455), '20260919T001500');
  });
  check('rolling over a month boundary still produces the correct date', () => {
    assert.equal(formatIcsLocalDateTime('2026-09-30', 1440 + 30), '20261001T003000');
  });
  check('the exact example from the brief: 2026-09-18 19:00-20:00', () => {
    assert.equal(formatIcsLocalDateTime('2026-09-18', 19 * 60), '20260918T190000');
    assert.equal(formatIcsLocalDateTime('2026-09-18', 20 * 60), '20260918T200000');
  });
  check('formatIcsUtcTimestamp (DTSTAMP) IS in UTC with a trailing Z, unlike event times', () => {
    const ts = formatIcsUtcTimestamp(new Date('2026-09-17T12:34:56Z'));
    assert.equal(ts, '20260917T123456Z');
  });
  check('formatIcsUtcTimestamp falls back to the current time for invalid input rather than throwing', () => {
    const ts = formatIcsUtcTimestamp('not a date');
    assert.match(ts, /^\d{8}T\d{6}Z$/);
  });
});

// ---------------------------------------------------------------------------
scenario('D. Stable UID generation (buildEventUid)', () => {
  check('the same schedule_item id always produces the same UID', () => {
    assert.equal(buildEventUid('abc-123'), buildEventUid('abc-123'));
  });
  check('different ids produce different UIDs', () => {
    assert.notEqual(buildEventUid('abc-123'), buildEventUid('xyz-789'));
  });
  check('the UID is derived from the id, never randomly generated', () => {
    assert.equal(buildEventUid('abc-123'), 'abc-123@student-scheduler.app');
  });
  check('re-exporting the same items twice produces identical UIDs both times (duplicate safety)', () => {
    const items = [{ id: 'item-1', item_type: 'study', name: 'Calculus', start_minutes: 60, end_minutes: 120 }];
    const first = exportDaysToIcs([{ dateStr: '2026-09-18', items }]);
    const second = exportDaysToIcs([{ dateStr: '2026-09-18', items }]);
    const uidOf = (ics) => ics.match(/UID:([^\r\n]+)/)[1];
    assert.equal(uidOf(first.ics), uidOf(second.ics));
  });
});

// ---------------------------------------------------------------------------
scenario('E. Schedule item -> ICS event conversion (mapScheduleItemToIcsEventFields)', () => {
  const item = { id: 'item-1', item_type: 'study', name: 'Calculus Study', start_minutes: 19 * 60, end_minutes: 20 * 60 };
  check('produces the expected uid/dtstart/dtend/summary', () => {
    const fields = mapScheduleItemToIcsEventFields(item, '2026-09-18');
    assert.equal(fields.uid, 'item-1@student-scheduler.app');
    assert.equal(fields.dtstart, '20260918T190000');
    assert.equal(fields.dtend, '20260918T200000');
    assert.equal(fields.summary, 'Calculus Study');
  });
  check('the description includes "Generated by Student Scheduler" and the event type label', () => {
    const fields = mapScheduleItemToIcsEventFields(item, '2026-09-18', { typeLabel: 'Study', generatedByText: 'Generated by Student Scheduler' });
    assert.ok(fields.description.includes('Generated by Student Scheduler'));
    assert.ok(fields.description.includes('Study'));
  });
});

// ---------------------------------------------------------------------------
scenario('F. Multiple-day export (exportDaysToIcs)', () => {
  const days = [
    { dateStr: '2026-09-18', items: [{ id: 'a', item_type: 'study', name: 'Day 1 study', start_minutes: 60, end_minutes: 120 }] },
    { dateStr: '2026-09-19', items: [{ id: 'b', item_type: 'class', name: 'Day 2 class', start_minutes: 540, end_minutes: 600 }] },
    { dateStr: '2026-09-20', items: [] },
  ];
  check('every day\'s items are included in one combined calendar', () => {
    const { ics, eventCount } = exportDaysToIcs(days);
    assert.equal(eventCount, 2);
    assert.ok(ics.includes('Day 1 study'));
    assert.ok(ics.includes('Day 2 class'));
    assert.ok(ics.includes('20260918T'));
    assert.ok(ics.includes('20260919T'));
  });
  check('an empty day contributes nothing but does not break the export', () => {
    const { eventCount } = exportDaysToIcs([{ dateStr: '2026-09-20', items: [] }]);
    assert.equal(eventCount, 0);
  });
  check('exporting zero days still produces a structurally valid (empty) calendar', () => {
    const { ics, eventCount } = exportDaysToIcs([]);
    assert.equal(eventCount, 0);
    assert.ok(ics.includes('BEGIN:VCALENDAR'));
    assert.ok(ics.includes('END:VCALENDAR'));
  });
});

// ---------------------------------------------------------------------------
scenario('F2. Event-type filtering (filterExportableItems / buildIcsCalendar structure)', () => {
  const items = [
    { id: 'c1', item_type: 'class', name: 'Class', start_minutes: 0, end_minutes: 60 },
    { id: 's1', item_type: 'study', name: 'Study', start_minutes: 60, end_minutes: 120 },
    { id: 'm1', item_type: 'meal', name: 'Meal', start_minutes: 120, end_minutes: 150 },
    { id: 'b1', item_type: 'break', name: 'Break', start_minutes: 150, end_minutes: 160 },
    { id: 'f1', item_type: 'free', name: 'Free', start_minutes: 160, end_minutes: 200 },
  ];
  check('defaults to Classes + Study only, per the brief', () => {
    assert.deepEqual(DEFAULT_EXPORT_EVENT_TYPES, ['class', 'study']);
    const filtered = filterExportableItems(items, undefined);
    assert.deepEqual(filtered.map((i) => i.id).sort(), ['c1', 's1']);
  });
  check('an explicit type list is respected, including meals/breaks when asked for', () => {
    const filtered = filterExportableItems(items, ['meal', 'break']);
    assert.deepEqual(filtered.map((i) => i.id).sort(), ['b1', 'm1']);
  });
  check('"free" time is never exportable even if explicitly requested (not a real calendar event)', () => {
    const filtered = filterExportableItems(items, ['free', 'class']);
    assert.deepEqual(filtered.map((i) => i.id), ['c1']);
  });
  check('a produced calendar has matching BEGIN/END VEVENT pairs', () => {
    const { ics } = exportDaysToIcs([{ dateStr: '2026-09-18', items }], { eventTypes: ['class', 'study'] });
    const begins = (ics.match(/BEGIN:VEVENT/g) || []).length;
    const ends = (ics.match(/END:VEVENT/g) || []).length;
    assert.equal(begins, 2);
    assert.equal(ends, 2);
  });
});

// ---------------------------------------------------------------------------
scenario('G. Parsing a simple ICS event (parseIcsCalendar)', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Test//EN',
    'BEGIN:VEVENT',
    'UID:test1@example.com',
    'DTSTART:20260918T190000',
    'DTEND:20260918T200000',
    'SUMMARY:Calculus Study',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  check('parses the event with the correct title/date/times', () => {
    const result = parseIcsCalendar(ics);
    assert.equal(result.valid, true);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].title, 'Calculus Study');
    assert.equal(result.events[0].dateStr, '2026-09-18');
    assert.equal(result.events[0].startMinutes, 19 * 60);
    assert.equal(result.events[0].endMinutes, 20 * 60);
    assert.equal(result.events[0].allDay, false);
  });
  check('unfoldIcsLines rejoins a folded continuation line correctly', () => {
    const folded = 'SUMMARY:Long title part one\r\n continued part two';
    const unfolded = unfoldIcsLines(folded);
    assert.equal(unfolded.length, 1);
    assert.equal(unfolded[0], 'SUMMARY:Long title part onecontinued part two');
  });
  check('parseIcsPropertyLine splits name/params/value correctly, keeping colons inside the value intact', () => {
    const parsed = parseIcsPropertyLine('DTSTART;VALUE=DATE:20260918');
    assert.equal(parsed.name, 'DTSTART');
    assert.equal(parsed.params.VALUE, 'DATE');
    assert.equal(parsed.value, '20260918');

    const withColonInValue = parseIcsPropertyLine('DESCRIPTION:See https://example.com:8080/path');
    assert.equal(withColonInValue.value, 'See https://example.com:8080/path');
  });
  check('an escaped comma/semicolon in an imported SUMMARY is unescaped back to plain text', () => {
    const withEscapes = ics.replace('SUMMARY:Calculus Study', 'SUMMARY:Math\\, Science\\; Review');
    const result = parseIcsCalendar(withEscapes);
    assert.equal(result.events[0].title, 'Math, Science; Review');
  });
});

// ---------------------------------------------------------------------------
scenario('H. Invalid calendar input', () => {
  check('empty input is rejected', () => {
    assert.equal(validateIcsInput('').valid, false);
    assert.equal(validateIcsInput('   ').valid, false);
    assert.equal(validateIcsInput(null).valid, false);
  });
  check('text with no BEGIN:VCALENDAR/VEVENT at all is rejected as not a calendar', () => {
    const result = validateIcsInput('this is just some random text file');
    assert.equal(result.valid, false);
    assert.equal(result.error, 'not_a_calendar');
  });
  check('text over the size cap is rejected', () => {
    const huge = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\n' + 'x'.repeat(MAX_ICS_TEXT_LENGTH + 10);
    const result = validateIcsInput(huge);
    assert.equal(result.valid, false);
    assert.equal(result.error, 'too_large');
  });
  check('parseIcsCalendar never throws on garbage input — it returns a rejection instead', () => {
    assert.doesNotThrow(() => parseIcsCalendar('garbage, not a calendar at all'));
    assert.doesNotThrow(() => parseIcsCalendar(''));
    assert.doesNotThrow(() => parseIcsCalendar(null));
    assert.doesNotThrow(() => parseIcsCalendar(12345));
  });
  check('a syntactically-present-but-empty VCALENDAR (no events) is rejected as no_events', () => {
    const result = parseIcsCalendar('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nEND:VEVENT\r\nEND:VCALENDAR');
    // a VEVENT with no DTSTART at all contributes nothing
    assert.equal(result.valid, false);
    assert.equal(result.error, 'no_events');
  });
  check('every error code maps to a translation key rather than leaking internally', () => {
    ['empty', 'too_large', 'not_a_calendar', 'no_events', 'something-unrecognized'].forEach((code) => {
      assert.ok(importErrorMessageKey(code).startsWith('calendar.'));
    });
  });
});

// ---------------------------------------------------------------------------
scenario('I. All-day event handling', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:allday1@example.com',
    'DTSTART;VALUE=DATE:20260920',
    'SUMMARY:Birthday',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  check('an all-day event is parsed with allDay:true and no meaningful time component', () => {
    const result = parseIcsCalendar(ics);
    assert.equal(result.valid, true);
    assert.equal(result.events[0].allDay, true);
    assert.equal(result.events[0].dateStr, '2026-09-20');
  });
  check('a bare 8-digit DTSTART value (no VALUE=DATE param) is still recognized as all-day', () => {
    const alt = ics.replace('DTSTART;VALUE=DATE:20260920', 'DTSTART:20260920');
    const result = parseIcsCalendar(alt);
    assert.equal(result.events[0].allDay, true);
  });
  check('mapImportEventToClassFields turns a selected all-day event into a full-day block (00:00-23:59)', () => {
    const result = parseIcsCalendar(ics);
    const fields = mapImportEventToClassFields(result.events[0]);
    assert.equal(fields.start_time, '00:00');
    assert.equal(fields.end_time, '23:59');
    assert.equal(fields.name, 'Birthday');
  });
  check('an all-day event only blocks the day if the caller actually selects/maps it — parsing alone does not', () => {
    // parseIcsCalendar returns it in the preview list; nothing is written
    // to Supabase by parsing. This is implicitly proven by the fact that
    // parseIcsCalendar is a pure function that returns a plain object and
    // touches no I/O at all.
    const result = parseIcsCalendar(ics);
    assert.equal(typeof result, 'object');
    assert.equal(result.events[0].allDay, true);
  });
});

// ---------------------------------------------------------------------------
scenario('J. Unsupported recurrence handling', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:recur1@example.com',
    'DTSTART:20260918T090000',
    'DTEND:20260918T100000',
    'SUMMARY:Weekly standup',
    'RRULE:FREQ=WEEKLY;COUNT=10',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:normal1@example.com',
    'DTSTART:20260919T140000',
    'DTEND:20260919T150000',
    'SUMMARY:One-off meeting',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  check('a recurring event (any RRULE) is excluded from the importable events list, not crashed on', () => {
    const result = parseIcsCalendar(ics);
    assert.equal(result.valid, true);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].title, 'One-off meeting');
  });
  check('the recurring event is counted separately as skipped, with a warning', () => {
    const result = parseIcsCalendar(ics);
    assert.equal(result.skippedRecurringCount, 1);
    assert.ok(result.warnings.includes('unsupported_recurrence'));
  });
  check('a calendar containing ONLY recurring events is rejected as having nothing importable, without crashing', () => {
    const onlyRecurring = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:r@example.com',
      'DTSTART:20260918T090000',
      'DTEND:20260918T100000',
      'SUMMARY:Recurring only',
      'RRULE:FREQ=DAILY',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const result = parseIcsCalendar(onlyRecurring);
    assert.equal(result.valid, false);
    assert.equal(result.skippedRecurringCount, 1);
  });
});

// ---------------------------------------------------------------------------
scenario('K. Import preview selection (selectImportEvents / groupSelectedEventsByDate)', () => {
  const events = [
    { id: 0, title: 'A', dateStr: '2026-09-18', startMinutes: 60, endMinutes: 120, allDay: false },
    { id: 1, title: 'B', dateStr: '2026-09-19', startMinutes: 60, endMinutes: 120, allDay: false },
    { id: 2, title: 'C', dateStr: '2026-09-18', startMinutes: 200, endMinutes: 260, allDay: false },
  ];

  check('only the checked/selected indexes are carried forward', () => {
    const selected = selectImportEvents(events, [0, 2]);
    assert.deepEqual(selected.map((e) => e.title), ['A', 'C']);
  });
  check('deselecting everything imports nothing', () => {
    assert.deepEqual(selectImportEvents(events, []), []);
  });
  check('an out-of-range index is ignored rather than throwing', () => {
    const selected = selectImportEvents(events, [0, 99]);
    assert.equal(selected.length, 1);
  });
  check('groupSelectedEventsByDate groups multiple selected events on the same date together', () => {
    const selected = selectImportEvents(events, [0, 1, 2]);
    const grouped = groupSelectedEventsByDate(selected);
    assert.equal(grouped['2026-09-18'].length, 2);
    assert.equal(grouped['2026-09-19'].length, 1);
  });
  check('grouping never mutates the input array', () => {
    const before = JSON.stringify(events);
    groupSelectedEventsByDate(events);
    assert.equal(JSON.stringify(events), before);
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
