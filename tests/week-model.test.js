// Plain Node tests for the pure Week View aggregation logic in
// src/dashboard/weekModel.js. No DOM, no Supabase. Run with `npm test` or
// `node tests/week-model.test.js`.

import assert from 'node:assert/strict';
import {
  getWeekStart,
  getWeekDates,
  shiftWeek,
  isCurrentWeek,
  OVERLOAD_THRESHOLD_MINUTES,
  isOverloadedDay,
  aggregateWeekView,
  computeWeekWorkloadBars,
  computeWeekSummary,
} from '../src/dashboard/weekModel.js';

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
scenario('A. getWeekStart', () => {
  check('a Wednesday rolls back to that week\'s Monday', () => assert.equal(getWeekStart('2026-10-07'), '2026-10-05'));
  check('a Monday maps to itself', () => assert.equal(getWeekStart('2026-10-05'), '2026-10-05'));
  check('a Sunday rolls back to the Monday that started its week (not the next one)', () => {
    assert.equal(getWeekStart('2026-10-11'), '2026-10-05');
  });
  check('a Saturday rolls back correctly', () => assert.equal(getWeekStart('2026-10-10'), '2026-10-05'));
  check('crosses a month boundary correctly', () => assert.equal(getWeekStart('2026-11-01'), '2026-10-26'));
});

// ---------------------------------------------------------------------------
scenario('B. getWeekDates', () => {
  check('returns exactly 7 dates, Monday through Sunday', () => {
    assert.deepEqual(getWeekDates('2026-10-05'), [
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
    ]);
  });
});

// ---------------------------------------------------------------------------
scenario('C. shiftWeek / isCurrentWeek', () => {
  check('shifting by +1 week moves exactly 7 days forward', () => assert.equal(shiftWeek('2026-10-05', 1), '2026-10-12'));
  check('shifting by -1 week moves exactly 7 days back', () => assert.equal(shiftWeek('2026-10-05', -1), '2026-09-28'));
  check('isCurrentWeek is true when today falls inside that week', () => assert.equal(isCurrentWeek('2026-10-05', '2026-10-07'), true));
  check('isCurrentWeek is false for a different week', () => assert.equal(isCurrentWeek('2026-10-05', '2026-10-13'), false));
});

// ---------------------------------------------------------------------------
scenario('D. isOverloadedDay', () => {
  check('exactly at the threshold is not overloaded', () => assert.equal(isOverloadedDay(OVERLOAD_THRESHOLD_MINUTES), false));
  check('just over the threshold is overloaded', () => assert.equal(isOverloadedDay(OVERLOAD_THRESHOLD_MINUTES + 1), true));
  check('zero is never overloaded', () => assert.equal(isOverloadedDay(0), false));
});

// ---------------------------------------------------------------------------
scenario('E. aggregateWeekView', () => {
  const weekDates = getWeekDates('2026-10-05');
  const schedules = [
    { id: 'sched-mon', for_date: '2026-10-05' },
    { id: 'sched-tue', for_date: '2026-10-06' },
  ];
  const classes = [
    { schedule_id: 'sched-mon', name: 'Calculus', start_time: '09:00', end_time: '10:00' },
    { schedule_id: 'sched-mon', name: 'Biology', start_time: '08:00', end_time: '08:50' },
  ];
  const items = [
    { schedule_id: 'sched-mon', item_type: 'study', start_minutes: 600, end_minutes: 660 },
    { schedule_id: 'sched-mon', item_type: 'class', start_minutes: 0, end_minutes: 30 },
    { schedule_id: 'sched-tue', item_type: 'study', start_minutes: 0, end_minutes: 90 },
  ];
  const dueSubjects = [{ id: 's1', name: 'CS Project', due_date: '2026-10-08', priority: 'high' }];

  const days = aggregateWeekView({ weekDates, schedules, classes, items, dueSubjects });

  check('returns exactly 7 day entries in Mon..Sun order', () => {
    assert.deepEqual(days.map((d) => d.date), weekDates);
  });
  check('classes on Monday are sorted by start time, with class item_type blocks ignored for study minutes', () => {
    const monday = days.find((d) => d.date === '2026-10-05');
    assert.deepEqual(monday.classes.map((c) => c.name), ['Biology', 'Calculus']);
    assert.equal(monday.studyMinutes, 60);
  });
  check('Tuesday study minutes are summed independently of Monday', () => {
    const tuesday = days.find((d) => d.date === '2026-10-06');
    assert.equal(tuesday.studyMinutes, 90);
  });
  check('a deadline attaches to its own due_date, independent of any schedule_id', () => {
    const thursday = days.find((d) => d.date === '2026-10-08');
    assert.equal(thursday.deadlines.length, 1);
    assert.equal(thursday.deadlines[0].name, 'CS Project');
  });
  check('a day with no matching rows at all still gets a real, empty entry', () => {
    const sunday = days.find((d) => d.date === '2026-10-11');
    assert.deepEqual(sunday, { date: '2026-10-11', classes: [], studyMinutes: 0, deadlines: [] });
  });
  check('input arrays are never mutated', () => {
    assert.equal(classes.length, 2);
    assert.equal(items.length, 3);
  });
});

// ---------------------------------------------------------------------------
scenario('F. computeWeekWorkloadBars', () => {
  check('scales every bar relative to the week\'s busiest day', () => {
    const days = [
      { date: 'd1', studyMinutes: 60 },
      { date: 'd2', studyMinutes: 120 },
      { date: 'd3', studyMinutes: 0 },
    ];
    const bars = computeWeekWorkloadBars(days);
    assert.equal(bars[0].barFraction, 0.5);
    assert.equal(bars[1].barFraction, 1);
    assert.equal(bars[2].barFraction, 0);
  });
  check('an all-zero week never divides by zero', () => {
    const bars = computeWeekWorkloadBars([{ date: 'd1', studyMinutes: 0 }]);
    assert.equal(bars[0].barFraction, 0);
  });
  check('flags an overloaded day', () => {
    const bars = computeWeekWorkloadBars([{ date: 'd1', studyMinutes: 300 }]);
    assert.equal(bars[0].overloaded, true);
  });
});

// ---------------------------------------------------------------------------
scenario('G. computeWeekSummary', () => {
  check('sums totals and finds the busiest day', () => {
    const days = [
      { date: 'd1', studyMinutes: 60, classes: [{}], deadlines: [] },
      { date: 'd2', studyMinutes: 120, classes: [], deadlines: [{}, {}] },
    ];
    const summary = computeWeekSummary(days);
    assert.deepEqual(summary, { totalStudyMinutes: 180, totalClasses: 1, totalDeadlines: 2, busiestDate: 'd2' });
  });
  check('an all-zero week reports no busiest day', () => {
    const days = [{ date: 'd1', studyMinutes: 0, classes: [], deadlines: [] }];
    assert.equal(computeWeekSummary(days).busiestDate, null);
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
