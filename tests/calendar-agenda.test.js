// Tests for V2-E Calendar agenda (src/calendar/agendaModel.js) and the
// Week View recurring-class fix (aggregateWeekView with seriesList).
// Plain Node, no DOM, no Supabase. Run with `npm test` or
// `node tests/calendar-agenda.test.js`.

import assert from 'node:assert/strict';
import { buildAgenda, filterAgenda, countAgendaCategories, agendaCategory, AGENDA_FILTERS } from '../src/calendar/agendaModel.js';
import { aggregateWeekView } from '../src/week/weekModel.js';

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

// Mon 2026-10-05 .. Wed 2026-10-07 (Tue has no schedule row at all)
const dates = ['2026-10-05', '2026-10-06', '2026-10-07'];
const schedules = [
  { id: 'mon', for_date: '2026-10-05' },
  { id: 'wed', for_date: '2026-10-07' },
];
const classes = [
  { schedule_id: 'mon', name: 'Chem Lab', start_time: '13:00:00', end_time: '15:00:00', source: 'manual' },
  { schedule_id: 'mon', name: 'Dentist', start_time: '08:30:00', end_time: '09:15:00', source: 'imported' },
  { schedule_id: 'wed', name: 'Office hours', start_time: null, end_time: null }, // legacy row: no source, no time
];
const items = [
  { schedule_id: 'mon', item_type: 'study', name: 'Calculus', start_minutes: 600, end_minutes: 660, completed: true },
  { schedule_id: 'mon', item_type: 'class', name: 'Chem Lab', start_minutes: 780, end_minutes: 900 }, // must not duplicate the class row
  { schedule_id: 'mon', item_type: 'break', name: 'Break', start_minutes: 660, end_minutes: 675 },
  { schedule_id: 'wed', item_type: 'study', name: 'Biology', start_minutes: 540, end_minutes: 600 },
];
// Calculus lecture Mon/Wed 14:00–15:20; Wed is moved to 16:00 by an exception
const seriesList = [
  { id: 'calc', name: 'Calculus lecture', days_of_week: [1, 3], start_time: '14:00', end_time: '15:20', start_date: '2026-09-01', end_date: '2026-12-15' },
  { id: 'gone', name: 'Ended seminar', days_of_week: [1, 2, 3], start_time: '09:00', end_time: '10:00', start_date: '2026-01-01', end_date: '2026-06-01' },
];
const exceptions = [
  { series_id: 'calc', exception_date: '2026-10-07', action: 'modify', override_start_time: '16:00', override_end_time: '17:20' },
];

const agenda = buildAgenda({ dates, schedules, classes, items, seriesList, exceptions });
const day = (d) => agenda.find((x) => x.date === d);

// ---------------------------------------------------------------------------
scenario('A. Merging sources', () => {
  check('one entry per date, in order, even with no schedule row', () => {
    assert.deepEqual(agenda.map((d) => d.date), dates);
    assert.deepEqual(day('2026-10-06').entries, []);
  });
  check('Monday: imported, study, recurring, manual — sorted by start', () => {
    assert.deepEqual(
      day('2026-10-05').entries.map((e) => [e.name, e.kind, e.origin, e.start]),
      [
        ['Dentist', 'class', 'imported', 510],
        ['Calculus', 'study', 'planner', 600],
        ['Chem Lab', 'class', 'manual', 780],
        ['Calculus lecture', 'class', 'recurring', 840],
      ]
    );
  });
  check('class/break schedule_items are never listed (no duplicates)', () => {
    assert.equal(day('2026-10-05').entries.filter((e) => e.name === 'Chem Lab').length, 1);
    assert.equal(day('2026-10-05').entries.some((e) => e.name === 'Break'), false);
  });
  check('a modified occurrence uses its override time and is flagged', () => {
    const occ = day('2026-10-07').entries.find((e) => e.name === 'Calculus lecture');
    assert.equal(occ.start, 960);
    assert.equal(occ.modified, true);
  });
  check('an ended series contributes nothing', () => {
    assert.equal(agenda.some((d) => d.entries.some((e) => e.name === 'Ended seminar')), false);
  });
  check('untimed legacy class sorts last and reads as a manual class', () => {
    const wed = day('2026-10-07').entries;
    assert.equal(wed[wed.length - 1].name, 'Office hours');
    assert.equal(wed[wed.length - 1].start, null);
    assert.equal(wed[wed.length - 1].origin, 'manual');
  });
  check('study completion is carried through', () => {
    assert.equal(day('2026-10-05').entries.find((e) => e.kind === 'study').completed, true);
  });
  check('empty input is safe', () => {
    assert.deepEqual(buildAgenda({ dates: ['2026-10-05'] }), [{ date: '2026-10-05', entries: [] }]);
  });
});

// ---------------------------------------------------------------------------
scenario('B. Filters', () => {
  check('categories: manual + recurring = classes, imported = external', () => {
    assert.equal(agendaCategory({ kind: 'class', origin: 'manual' }), 'classes');
    assert.equal(agendaCategory({ kind: 'class', origin: 'recurring' }), 'classes');
    assert.equal(agendaCategory({ kind: 'class', origin: 'imported' }), 'external');
    assert.equal(agendaCategory({ kind: 'study', origin: 'planner' }), 'study');
  });
  check('counts per chip', () => {
    assert.deepEqual(countAgendaCategories(agenda), { all: 7, classes: 4, study: 2, external: 1 });
  });
  check('each filter keeps every day but only matching entries', () => {
    const study = filterAgenda(agenda, 'study');
    assert.equal(study.length, 3);
    assert.deepEqual(study.flatMap((d) => d.entries.map((e) => e.name)), ['Calculus', 'Biology']);
    assert.deepEqual(filterAgenda(agenda, 'external').flatMap((d) => d.entries.map((e) => e.name)), ['Dentist']);
  });
  check("'all' and unknown filters return everything; input not mutated", () => {
    const before = JSON.stringify(agenda);
    assert.equal(filterAgenda(agenda, 'all').flatMap((d) => d.entries).length, 7);
    assert.equal(filterAgenda(agenda, 'bogus').flatMap((d) => d.entries).length, 7);
    assert.equal(JSON.stringify(agenda), before);
    assert.deepEqual(AGENDA_FILTERS, ['all', 'classes', 'study', 'external']);
  });
});

// ---------------------------------------------------------------------------
scenario('C. Week View now includes recurring classes', () => {
  const week = aggregateWeekView({ weekDates: dates, schedules, classes, items, dueSubjects: [], seriesList, exceptions });
  check('recurring occurrences appear on their days, incl. a date with no schedule row', () => {
    assert.equal(week[0].classes.some((c) => c.name === 'Calculus lecture' && c.recurring), true);
    assert.equal(week[2].classes.some((c) => c.name === 'Calculus lecture' && c.start_time === '16:00'), true);
    assert.equal(week[1].classes.length, 0); // Tue: not a lecture day
  });
  check('a skipped occurrence is left out', () => {
    const skipped = aggregateWeekView({
      weekDates: dates, schedules, classes, items, dueSubjects: [], seriesList,
      exceptions: [{ series_id: 'calc', exception_date: '2026-10-05', action: 'skip' }],
    });
    assert.equal(skipped[0].classes.some((c) => c.name === 'Calculus lecture'), false);
  });
  check('without series (old callers) behavior is unchanged', () => {
    const plain = aggregateWeekView({ weekDates: dates, schedules, classes, items, dueSubjects: [] });
    assert.equal(plain[0].classes.length, 2);
    assert.equal(plain[0].studyMinutes, 60);
  });
});

console.log('\n------------------------');
if (totalFailures > 0) {
  console.log(`${totalFailures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
