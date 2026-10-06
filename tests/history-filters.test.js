// Tests for V2-E History: the per-day minutes/missed/carry-over additions to
// aggregateScheduleHistory and the pure filterHistory filters. Plain Node,
// no DOM, no Supabase. Run with `npm test` or `node tests/history-filters.test.js`.

import assert from 'node:assert/strict';
import {
  aggregateScheduleHistory,
  filterHistory,
  collectHistorySubjects,
  countActiveHistoryFilters,
} from '../src/dashboard/history.js';

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

const block = (scheduleId, name, start, end, extra = {}) => ({
  schedule_id: scheduleId,
  item_type: 'study',
  name,
  start_minutes: start,
  end_minutes: end,
  completed: false,
  completed_minutes: 0,
  carried_over_minutes: 0,
  missed: false,
  ...extra,
});

const schedules = [
  { id: 'a', for_date: '2026-10-01' },
  { id: 'b', for_date: '2026-10-02' },
  { id: 'c', for_date: '2026-10-03' },
  { id: 'd', for_date: '2026-10-04' },
];
const subjects = [
  { schedule_id: 'a', name: 'Calculus' },
  { schedule_id: 'b', name: 'Biology' },
  { schedule_id: 'c', name: 'Calculus' },
  { schedule_id: 'd', name: 'Writing' }, // added but never scheduled
];
const items = [
  block('a', 'Calculus', 540, 600, { completed: true }),
  block('a', 'Calculus', 620, 680, { completed: true, completed_minutes: 50 }),
  block('b', 'Biology', 540, 630, { completed_minutes: 30, carried_over_minutes: 40, missed: true }),
  block('c', 'Calculus', 540, 600, { completed_minutes: 15 }),
  { schedule_id: 'c', item_type: 'class', name: 'Lecture', start_minutes: 0, end_minutes: 120 },
];
const history = aggregateScheduleHistory(schedules, [], subjects, items);
const byDate = (d) => history.find((h) => h.forDate === d);

// ---------------------------------------------------------------------------
scenario('A. Per-day minutes, carry-over, missed, subjects', () => {
  check('fully done day: planned 120, completed 120', () => {
    const a = byDate('2026-10-01');
    assert.equal(a.plannedMinutes, 120);
    assert.equal(a.completedMinutes, 120);
    assert.equal(a.missedBlockCount, 0);
    assert.deepEqual(a.subjectNames, ['Calculus']);
  });
  check('partial + missed + carried day', () => {
    const b = byDate('2026-10-02');
    assert.equal(b.plannedMinutes, 90);
    assert.equal(b.completedMinutes, 30);
    assert.equal(b.carriedOverMinutes, 40);
    assert.equal(b.missedBlockCount, 1);
  });
  check('non-study items never count toward minutes', () => {
    assert.equal(byDate('2026-10-03').plannedMinutes, 60);
  });
  check('a subject added but never scheduled still counts for the Subject filter', () => {
    assert.deepEqual(byDate('2026-10-04').subjectNames, ['Writing']);
    assert.equal(byDate('2026-10-04').plannedMinutes, 0);
  });
  check('legacy rows without start/end/minutes read as 0, never NaN', () => {
    const [h] = aggregateScheduleHistory([{ id: 'x', for_date: '2026-01-01' }], [], [{ schedule_id: 'x' }], [
      { schedule_id: 'x', item_type: 'study', completed: true },
    ]);
    assert.equal(h.plannedMinutes, 0);
    assert.equal(h.completedMinutes, 0);
    assert.equal(h.carriedOverMinutes, 0);
    assert.deepEqual(h.subjectNames, []);
  });
});

// ---------------------------------------------------------------------------
scenario('B. Filters', () => {
  const dates = (rows) => rows.map((h) => h.forDate);
  check('no filters -> everything, in original order', () => {
    assert.deepEqual(dates(filterHistory(history, {})), dates(history));
    assert.deepEqual(dates(filterHistory(history)), dates(history));
  });
  check('date range is inclusive on both ends', () => {
    assert.deepEqual(dates(filterHistory(history, { from: '2026-10-02', to: '2026-10-03' })), ['2026-10-02', '2026-10-03']);
    assert.deepEqual(dates(filterHistory(history, { from: '2026-10-04' })), ['2026-10-04']);
  });
  check('subject', () => {
    assert.deepEqual(dates(filterHistory(history, { subject: 'Calculus' })), ['2026-10-01', '2026-10-03']);
    assert.deepEqual(dates(filterHistory(history, { subject: 'Nope' })), []);
  });
  check('status: completed / incomplete / missed / carried', () => {
    assert.deepEqual(dates(filterHistory(history, { status: 'completed' })), ['2026-10-01']);
    assert.deepEqual(dates(filterHistory(history, { status: 'incomplete' })), ['2026-10-02', '2026-10-03']);
    assert.deepEqual(dates(filterHistory(history, { status: 'missed' })), ['2026-10-02']);
    assert.deepEqual(dates(filterHistory(history, { status: 'carried' })), ['2026-10-02']);
  });
  check('a day with no study blocks is neither completed nor incomplete', () => {
    assert.equal(filterHistory(history, { status: 'completed' }).some((h) => h.forDate === '2026-10-04'), false);
    assert.equal(filterHistory(history, { status: 'incomplete' }).some((h) => h.forDate === '2026-10-04'), false);
  });
  check('filters combine (AND)', () => {
    assert.deepEqual(dates(filterHistory(history, { subject: 'Calculus', status: 'incomplete' })), ['2026-10-03']);
  });
  check('input is never mutated', () => {
    const copy = JSON.stringify(history);
    filterHistory(history, { status: 'missed', subject: 'Biology' });
    assert.equal(JSON.stringify(history), copy);
  });
});

// ---------------------------------------------------------------------------
scenario('C. Helpers', () => {
  check('subject options are unique and sorted', () => {
    assert.deepEqual(collectHistorySubjects(history), ['Biology', 'Calculus', 'Writing']);
    assert.deepEqual(collectHistorySubjects(null), []);
  });
  check('active filter count', () => {
    assert.equal(countActiveHistoryFilters({}), 0);
    assert.equal(countActiveHistoryFilters({ status: 'all' }), 0);
    assert.equal(countActiveHistoryFilters({ from: '2026-10-01', subject: 'x', status: 'missed' }), 3);
  });
});

console.log('\n------------------------');
if (totalFailures > 0) {
  console.log(`${totalFailures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
