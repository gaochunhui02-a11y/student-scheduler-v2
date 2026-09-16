// Plain Node tests for the pure Dashboard + Analytics logic in
// src/analytics/analyticsModel.js. No DOM, no Supabase, no AI — every
// calculation here (weekly totals, completion rate, subject aggregation,
// deadline risk, productivity period) is deterministic and computed
// straight from plain input/output pairs. Run with `npm test` or
// `node tests/analytics.test.js`.

import assert from 'node:assert/strict';
import {
  lastNDates,
  daysBetween,
  attachDatesToItems,
  computeWeeklyTotals,
  computeCompletionRate,
  computeSubjectTotals,
  classifyDeadlineRisk,
  isValidRiskLevel,
  computeUpcomingDeadlines,
  countByRisk,
  computeProductivityPeriod,
  summarizeBoards,
  buildAdvisorPromptForTask,
  computeTodayBlockStatus,
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

// ---------------------------------------------------------------------------
scenario('A. Date helpers (lastNDates / daysBetween)', () => {
  check('lastNDates returns n dates, oldest first, ending on the given date', () => {
    const dates = lastNDates('2026-09-18', 7);
    assert.equal(dates.length, 7);
    assert.equal(dates[6], '2026-09-18');
    assert.equal(dates[0], '2026-09-12');
  });
  check('daysBetween is positive when the second date is later', () => {
    assert.equal(daysBetween('2026-09-18', '2026-09-20'), 2);
  });
  check('daysBetween is negative when the second date is earlier (overdue)', () => {
    assert.equal(daysBetween('2026-09-18', '2026-09-15'), -3);
  });
  check('daysBetween is 0 for the same date', () => {
    assert.equal(daysBetween('2026-09-18', '2026-09-18'), 0);
  });
  check('daysBetween is correct across a month boundary', () => {
    assert.equal(daysBetween('2026-01-30', '2026-02-02'), 3);
  });
});

// ---------------------------------------------------------------------------
scenario('B. attachDatesToItems (joining schedule_items to their date)', () => {
  const schedules = [
    { id: 'sch1', for_date: '2026-09-17' },
    { id: 'sch2', for_date: '2026-09-18' },
  ];
  check('each item gets the for_date of its schedule_id', () => {
    const items = [
      { id: 'i1', schedule_id: 'sch1' },
      { id: 'i2', schedule_id: 'sch2' },
    ];
    const result = attachDatesToItems(items, schedules);
    assert.equal(result[0].date, '2026-09-17');
    assert.equal(result[1].date, '2026-09-18');
  });
  check('an item whose schedule_id is not in the schedules list is dropped, not crashed on', () => {
    const items = [{ id: 'orphan', schedule_id: 'unknown' }];
    assert.deepEqual(attachDatesToItems(items, schedules), []);
  });
});

// ---------------------------------------------------------------------------
scenario('C. Weekly planned totals (computeWeeklyTotals)', () => {
  const dates = ['2026-09-17', '2026-09-18'];
  check('planned sums every study block\'s duration regardless of completion', () => {
    const items = [
      { item_type: 'study', date: '2026-09-17', start_minutes: 540, end_minutes: 600, completed: false }, // 60
      { item_type: 'study', date: '2026-09-17', start_minutes: 600, end_minutes: 630, completed: true }, // 30
      { item_type: 'study', date: '2026-09-18', start_minutes: 480, end_minutes: 540, completed: false }, // 60
    ];
    const result = computeWeeklyTotals(items, dates);
    assert.equal(result.byDay[0].planned, 90);
    assert.equal(result.byDay[1].planned, 60);
    assert.equal(result.totalPlanned, 150);
  });
  check('non-study item types (class/meal/break/free) are excluded from planned totals', () => {
    const items = [
      { item_type: 'class', date: '2026-09-17', start_minutes: 0, end_minutes: 60, completed: false },
      { item_type: 'meal', date: '2026-09-17', start_minutes: 60, end_minutes: 90, completed: false },
    ];
    const result = computeWeeklyTotals(items, dates);
    assert.equal(result.totalPlanned, 0);
  });
  check('an item on a date outside the requested window is ignored', () => {
    const items = [{ item_type: 'study', date: '2026-09-01', start_minutes: 0, end_minutes: 60, completed: false }];
    const result = computeWeeklyTotals(items, dates);
    assert.equal(result.totalPlanned, 0);
  });
});

// ---------------------------------------------------------------------------
scenario('D. Weekly completed totals (computeWeeklyTotals)', () => {
  const dates = ['2026-09-17'];
  check('completed sums only study blocks marked completed:true', () => {
    const items = [
      { item_type: 'study', date: '2026-09-17', start_minutes: 0, end_minutes: 60, completed: true }, // 60
      { item_type: 'study', date: '2026-09-17', start_minutes: 60, end_minutes: 150, completed: false }, // not counted
    ];
    const result = computeWeeklyTotals(items, dates);
    assert.equal(result.totalCompleted, 60);
    assert.equal(result.totalPlanned, 150);
  });
  check('zero completed blocks gives a completed total of 0, not undefined/NaN', () => {
    const items = [{ item_type: 'study', date: '2026-09-17', start_minutes: 0, end_minutes: 30, completed: false }];
    const result = computeWeeklyTotals(items, dates);
    assert.equal(result.totalCompleted, 0);
  });
});

// ---------------------------------------------------------------------------
scenario('E. Completion rate (computeCompletionRate)', () => {
  check('a normal planned/completed pair gives a rounded percentage', () => {
    assert.equal(computeCompletionRate(600, 450), 75);
  });
  check('nothing planned gives null ("no data"), not 0', () => {
    assert.equal(computeCompletionRate(0, 0), null);
    assert.equal(computeCompletionRate(null, 0), null);
  });
  check('completed cannot exceed 100%, even if the input is inconsistent', () => {
    assert.equal(computeCompletionRate(60, 999), 100);
  });
  check('a negative/invalid completed value is treated as 0, not a negative percentage', () => {
    assert.equal(computeCompletionRate(60, -30), 0);
  });
});

// ---------------------------------------------------------------------------
scenario('F. Subject aggregation (computeSubjectTotals)', () => {
  const studySubjects = [
    { id: 's1', name: 'Calculus', minutes_requested: 60 },
    { id: 's2', name: 'Calculus', minutes_requested: 40 }, // same subject, a different day's row
    { id: 's3', name: 'English', minutes_requested: 30 },
  ];
  const items = [
    { item_type: 'study', source_subject_id: 's1', completed: true, start_minutes: 0, end_minutes: 60 }, // 60 completed for Calculus
    { item_type: 'study', source_subject_id: 's2', completed: false, start_minutes: 0, end_minutes: 40 }, // not completed
    { item_type: 'study', source_subject_id: 's3', completed: true, start_minutes: 0, end_minutes: 20 }, // 20 completed for English
  ];

  check('planned is summed across every row sharing the same subject name', () => {
    const totals = computeSubjectTotals(studySubjects, items);
    const calc = totals.find((t) => t.subject === 'Calculus');
    assert.equal(calc.planned, 100);
  });
  check('completed is summed only from completed study blocks, attributed by source_subject_id', () => {
    const totals = computeSubjectTotals(studySubjects, items);
    const calc = totals.find((t) => t.subject === 'Calculus');
    const eng = totals.find((t) => t.subject === 'English');
    assert.equal(calc.completed, 60);
    assert.equal(eng.completed, 20);
  });
  check('results are sorted by planned minutes, largest first', () => {
    const totals = computeSubjectTotals(studySubjects, items);
    assert.equal(totals[0].subject, 'Calculus');
    assert.equal(totals[1].subject, 'English');
  });
  check('an item whose source_subject_id matches nothing is ignored, not crashed on', () => {
    const totals = computeSubjectTotals(studySubjects, [{ item_type: 'study', source_subject_id: 'ghost', completed: true, start_minutes: 0, end_minutes: 10 }]);
    assert.ok(totals.every((t) => t.completed === 0));
  });
});

// ---------------------------------------------------------------------------
scenario('G. Overdue task classification (classifyDeadlineRisk)', () => {
  const today = '2026-09-18';
  check('a due date already in the past with time still owed is at_risk', () => {
    assert.equal(classifyDeadlineRisk({ dueDate: '2026-09-15', remainingMinutes: 60, priority: 'medium' }, today), 'at_risk');
  });
  check('a task due today with a meaningful amount of work left is at_risk', () => {
    assert.equal(classifyDeadlineRisk({ dueDate: today, remainingMinutes: 90, priority: 'medium' }, today), 'at_risk');
  });
  check('no due date at all is on_track — nothing to risk-assess', () => {
    assert.equal(classifyDeadlineRisk({ dueDate: null, remainingMinutes: 999, priority: 'high' }, today), 'on_track');
  });
  check('zero/negative remaining minutes is on_track regardless of the date', () => {
    assert.equal(classifyDeadlineRisk({ dueDate: '2026-09-10', remainingMinutes: 0, priority: 'high' }, today), 'on_track');
  });
  check('every returned value is one of the three defined risk levels', () => {
    assert.equal(isValidRiskLevel(classifyDeadlineRisk({ dueDate: '2026-09-15', remainingMinutes: 60, priority: 'medium' }, today)), true);
    assert.equal(isValidRiskLevel('bogus'), false);
  });
});

// ---------------------------------------------------------------------------
scenario('H. Near-due high-priority risk (classifyDeadlineRisk)', () => {
  const today = '2026-09-18';
  check('a large amount of remaining work spread over few days is at_risk', () => {
    // 300 minutes over 2 days = 150 min/day, well past the 120 min/day at_risk threshold
    assert.equal(classifyDeadlineRisk({ dueDate: '2026-09-20', remainingMinutes: 300, priority: 'medium' }, today), 'at_risk');
  });
  check('a moderate amount needing 60-120 min/day is needs_attention', () => {
    // 200 minutes over 2 days = 100 min/day
    assert.equal(classifyDeadlineRisk({ dueDate: '2026-09-20', remainingMinutes: 200, priority: 'medium' }, today), 'needs_attention');
  });
  check('a HIGH priority task due soon is needs_attention even with a light workload', () => {
    // only 20 min/day needed, but high priority and due within 2 days
    assert.equal(classifyDeadlineRisk({ dueDate: '2026-09-19', remainingMinutes: 20, priority: 'high' }, today), 'needs_attention');
  });
  check('the same light workload at medium priority stays on_track', () => {
    assert.equal(classifyDeadlineRisk({ dueDate: '2026-09-19', remainingMinutes: 20, priority: 'medium' }, today), 'on_track');
  });
  check('a light workload with plenty of days left is on_track even at high priority', () => {
    assert.equal(classifyDeadlineRisk({ dueDate: '2026-10-01', remainingMinutes: 30, priority: 'high' }, today), 'on_track');
  });
});

// ---------------------------------------------------------------------------
scenario('I. Upcoming deadlines list (computeUpcomingDeadlines / countByRisk)', () => {
  const today = '2026-09-18';
  const subjects = [
    { id: 'a', name: 'Late thing', due_date: '2026-09-10', minutes_requested: 60, priority: 'medium' },
    { id: 'b', name: 'Soon thing', due_date: '2026-09-19', minutes_requested: 30, priority: 'low' },
    { id: 'c', name: 'No due date', due_date: null, minutes_requested: 30, priority: 'low' },
    { id: 'd', name: 'Far thing', due_date: '2026-10-01', minutes_requested: 30, priority: 'low' },
  ];

  check('subjects with no due date are excluded entirely', () => {
    const upcoming = computeUpcomingDeadlines(subjects, today, 10);
    assert.ok(!upcoming.some((u) => u.title === 'No due date'));
  });
  check('the list is sorted soonest due date first', () => {
    const upcoming = computeUpcomingDeadlines(subjects, today, 10);
    assert.deepEqual(upcoming.map((u) => u.title), ['Late thing', 'Soon thing', 'Far thing']);
  });
  check('the list is capped at the given limit', () => {
    const upcoming = computeUpcomingDeadlines(subjects, today, 2);
    assert.equal(upcoming.length, 2);
  });
  check('each entry carries a computed risk level', () => {
    const upcoming = computeUpcomingDeadlines(subjects, today, 10);
    upcoming.forEach((u) => assert.equal(isValidRiskLevel(u.risk), true));
  });
  check('countByRisk counts only the matching level', () => {
    const upcoming = computeUpcomingDeadlines(subjects, today, 10);
    const atRisk = countByRisk(upcoming, 'at_risk');
    assert.equal(atRisk, upcoming.filter((u) => u.risk === 'at_risk').length);
    assert.ok(atRisk >= 1, 'the overdue "Late thing" must count as at_risk');
  });
});

// ---------------------------------------------------------------------------
scenario('J. No-history productivity fallback (computeProductivityPeriod)', () => {
  check('zero completed sessions reports insufficientData, not a guess', () => {
    const result = computeProductivityPeriod([]);
    assert.equal(result.insufficientData, true);
    assert.equal(result.period, null);
  });
  check('fewer than the minimum session count reports insufficientData', () => {
    const result = computeProductivityPeriod([{ start: 480, end: 540 }, { start: 500, end: 560 }], { minSessions: 3, minTotalMinutes: 0 });
    assert.equal(result.insufficientData, true);
  });
  check('enough sessions but too little total time still reports insufficientData', () => {
    const items = [
      { start: 480, end: 485 },
      { start: 600, end: 605 },
      { start: 700, end: 705 },
    ]; // 15 total minutes
    const result = computeProductivityPeriod(items, { minSessions: 3, minTotalMinutes: 60 });
    assert.equal(result.insufficientData, true);
  });
});

// ---------------------------------------------------------------------------
scenario('K. Productivity period calculation (computeProductivityPeriod)', () => {
  check('the period with the most completed minutes wins', () => {
    const items = [
      { start: 6 * 60, end: 7 * 60 }, // 60 min morning
      { start: 19 * 60, end: 21 * 60 }, // 120 min evening
      { start: 20 * 60, end: 21 * 60 }, // 60 min evening
    ];
    const result = computeProductivityPeriod(items, { minSessions: 2, minTotalMinutes: 60 });
    assert.equal(result.insufficientData, false);
    assert.equal(result.period, 'evening');
    assert.equal(result.minutesByPeriod.evening, 180);
    assert.equal(result.minutesByPeriod.morning, 60);
  });
  check('a block that crosses midnight (absolute minutes past 1440) is still bucketed correctly', () => {
    // 11:30 PM - 12:15 AM -> start=1410, end=1455 (per the scheduler's own
    // overnight-day convention); midpoint ~1432, which %1440 lands at 23:52 -> night
    const items = [
      { start: 1410, end: 1455 },
      { start: 1420, end: 1460 },
      { start: 1430, end: 1470 },
    ];
    const result = computeProductivityPeriod(items, { minSessions: 2, minTotalMinutes: 30 });
    assert.equal(result.period, 'night');
  });
  check('morning/afternoon/evening/night boundaries are respected', () => {
    const items = [
      { start: 8 * 60, end: 8 * 60 + 30 }, // morning
      { start: 13 * 60, end: 13 * 60 + 30 }, // afternoon
      { start: 22 * 60, end: 22 * 60 + 30 }, // night
    ];
    const result = computeProductivityPeriod(items, { minSessions: 2, minTotalMinutes: 30 });
    assert.equal(result.minutesByPeriod.morning, 30);
    assert.equal(result.minutesByPeriod.afternoon, 30);
    assert.equal(result.minutesByPeriod.night, 30);
    assert.equal(result.minutesByPeriod.evening, 0);
  });
});

// ---------------------------------------------------------------------------
scenario('L. Board summary (summarizeBoards) and Advisor prompt (buildAdvisorPromptForTask)', () => {
  check('summarizeBoards reports the count and the first (most-recently-updated) board\'s title', () => {
    const summary = summarizeBoards([{ id: 'b1', title: 'Fall Semester' }, { id: 'b2', title: 'Personal' }]);
    assert.equal(summary.count, 2);
    assert.equal(summary.mostRecentTitle, 'Fall Semester');
  });
  check('summarizeBoards handles zero boards without crashing', () => {
    assert.deepEqual(summarizeBoards([]), { count: 0, mostRecentTitle: null });
    assert.deepEqual(summarizeBoards(null), { count: 0, mostRecentTitle: null });
  });

  check('buildAdvisorPromptForTask includes the task title and due date', () => {
    const prompt = buildAdvisorPromptForTask({ title: 'Finish essay', dueDate: '2026-09-19' });
    assert.ok(prompt.includes('Finish essay'));
    assert.ok(prompt.includes('2026-09-19'));
  });
  check('buildAdvisorPromptForTask uses the supplied (translated) labels rather than hardcoded English', () => {
    const prompt = buildAdvisorPromptForTask(
      { title: 'x', dueDate: '2026-09-19' },
      { help: '帮我处理', due: '截止日期', riskNote: '有风险' }
    );
    assert.ok(prompt.includes('帮我处理'));
    assert.ok(prompt.includes('截止日期'));
    assert.ok(prompt.includes('有风险'));
  });
  check('buildAdvisorPromptForTask returns an empty string for a task with no title', () => {
    assert.equal(buildAdvisorPromptForTask({}), '');
    assert.equal(buildAdvisorPromptForTask(null), '');
  });
});

// ---------------------------------------------------------------------------
scenario('M. Today block status (computeTodayBlockStatus) — Home dashboard "Today" card', () => {
  check('a block spanning right now is reported as current, not next', () => {
    const items = [
      { item_type: 'class', start_minutes: 480, end_minutes: 540, completed: false }, // 8:00-9:00
      { item_type: 'study', start_minutes: 540, end_minutes: 600, completed: false }, // 9:00-10:00
    ];
    const result = computeTodayBlockStatus(items, 500); // 8:20am, inside the class
    assert.equal(result.current.item_type, 'class');
    assert.equal(result.next, null);
  });
  check('with nothing currently happening, the soonest future block is "next"', () => {
    const items = [
      { item_type: 'study', start_minutes: 540, end_minutes: 600, completed: false },
      { item_type: 'class', start_minutes: 700, end_minutes: 750, completed: false },
    ];
    const result = computeTodayBlockStatus(items, 620); // between the two, nothing active
    assert.equal(result.current, null);
    assert.equal(result.next.start_minutes, 700);
  });
  check('a day with nothing left at all reports both as null, no crash', () => {
    const items = [{ item_type: 'study', start_minutes: 480, end_minutes: 540, completed: true }];
    const result = computeTodayBlockStatus(items, 700);
    assert.equal(result.current, null);
    assert.equal(result.next, null);
  });
  check('empty/missing items never throws', () => {
    assert.deepEqual(computeTodayBlockStatus([], 600), { current: null, next: null, remainingPlannedMinutes: 0 });
    assert.deepEqual(computeTodayBlockStatus(null, 600), { current: null, next: null, remainingPlannedMinutes: 0 });
  });
  check('remainingPlannedMinutes sums only not-yet-completed study time still ahead of now', () => {
    const items = [
      { item_type: 'study', start_minutes: 480, end_minutes: 540, completed: true }, // done, in the past — excluded
      { item_type: 'class', start_minutes: 540, end_minutes: 600, completed: false }, // a class, not study — excluded
      { item_type: 'study', start_minutes: 600, end_minutes: 660, completed: false }, // fully ahead: 60 min
    ];
    assert.equal(computeTodayBlockStatus(items, 550).remainingPlannedMinutes, 60);
  });
  check('a study block already in progress only counts its remaining half, not the full duration', () => {
    const items = [{ item_type: 'study', start_minutes: 540, end_minutes: 600, completed: false }]; // 9:00-10:00
    assert.equal(computeTodayBlockStatus(items, 570).remainingPlannedMinutes, 30); // 9:30 -> 30 min left
  });
  check('a completed study block never counts toward remaining minutes even if technically still ahead', () => {
    const items = [{ item_type: 'study', start_minutes: 700, end_minutes: 760, completed: true }];
    assert.equal(computeTodayBlockStatus(items, 600).remainingPlannedMinutes, 0);
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
