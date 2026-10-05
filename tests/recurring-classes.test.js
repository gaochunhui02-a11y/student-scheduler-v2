// Plain Node tests for the pure Recurring Classes logic in
// src/dashboard/recurringClasses.js. No DOM, no Supabase. Run with
// `npm test` or `node tests/recurring-classes.test.js`.
//
// Calculus (days_of_week [2,4] = Tue/Thu) runs 2026-09-01 (a Tuesday)
// through 2026-12-15 (a Tuesday) at 14:00-15:20 — the exact example from
// the V2 product brief ("Tuesday + Thursday, 14:00-15:20, Sep 1 - Dec 15").

import assert from 'node:assert/strict';
import {
  VALID_DAYS_OF_WEEK,
  normalizeDaysOfWeek,
  isValidDaysOfWeek,
  isValidTimeRange,
  isValidDateRange,
  buildSeriesFields,
  validateSeriesFields,
  occursOnDate,
  findException,
  resolveOccurrenceForDate,
  buildEffectiveClassesForDate,
  buildSkipExceptionFields,
  buildModifyExceptionFields,
} from '../src/dashboard/recurringClasses.js';

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

const CALCULUS = {
  id: 'series-calc',
  name: 'Calculus',
  days_of_week: [2, 4],
  start_time: '14:00',
  end_time: '15:20',
  start_date: '2026-09-01',
  end_date: '2026-12-15',
};

// ---------------------------------------------------------------------------
scenario('A. normalizeDaysOfWeek / isValidDaysOfWeek', () => {
  check('VALID_DAYS_OF_WEEK is 0..6', () => assert.deepEqual(VALID_DAYS_OF_WEEK, [0, 1, 2, 3, 4, 5, 6]));
  check('sorts and dedupes', () => assert.deepEqual(normalizeDaysOfWeek([4, 2, 2, 4]), [2, 4]));
  check('drops out-of-range values', () => assert.deepEqual(normalizeDaysOfWeek([2, 7, -1, 'x']), [2]));
  check('non-array input becomes an empty list', () => assert.deepEqual(normalizeDaysOfWeek(null), []));
  check('an empty list is invalid', () => assert.equal(isValidDaysOfWeek([]), false));
  check('a real list is valid', () => assert.equal(isValidDaysOfWeek([2, 4]), true));
});

// ---------------------------------------------------------------------------
scenario('B. isValidTimeRange / isValidDateRange', () => {
  check('end after start is valid', () => assert.equal(isValidTimeRange('14:00', '15:20'), true));
  check('end equal to start is invalid', () => assert.equal(isValidTimeRange('14:00', '14:00'), false));
  check('end before start is invalid', () => assert.equal(isValidTimeRange('15:00', '14:00'), false));
  check('end date on or after start date is valid', () => {
    assert.equal(isValidDateRange('2026-09-01', '2026-12-15'), true);
    assert.equal(isValidDateRange('2026-09-01', '2026-09-01'), true);
  });
  check('end date before start date is invalid', () => assert.equal(isValidDateRange('2026-12-15', '2026-09-01'), false));
});

// ---------------------------------------------------------------------------
scenario('C. buildSeriesFields / validateSeriesFields', () => {
  check('maps and normalizes raw form input', () => {
    const fields = buildSeriesFields({
      name: '  Calculus  ',
      daysOfWeek: [4, 2],
      startTime: '14:00',
      endTime: '15:20',
      startDate: '2026-09-01',
      endDate: '2026-12-15',
    });
    assert.deepEqual(fields, {
      name: 'Calculus',
      days_of_week: [2, 4],
      start_time: '14:00',
      end_time: '15:20',
      start_date: '2026-09-01',
      end_date: '2026-12-15',
    });
  });
  check('a fully valid series passes', () => assert.equal(validateSeriesFields(CALCULUS).valid, true));
  check('rejects a blank name', () => assert.equal(validateSeriesFields({ ...CALCULUS, name: '' }).valid, false));
  check('rejects no days selected', () => assert.equal(validateSeriesFields({ ...CALCULUS, days_of_week: [] }).valid, false));
  check('rejects end time before start time', () => assert.equal(validateSeriesFields({ ...CALCULUS, end_time: '13:00' }).valid, false));
  check('rejects end date before start date', () => assert.equal(validateSeriesFields({ ...CALCULUS, end_date: '2026-01-01' }).valid, false));
});

// ---------------------------------------------------------------------------
scenario('D. occursOnDate', () => {
  check('a Tuesday inside the range matches', () => assert.equal(occursOnDate(CALCULUS, '2026-10-06'), true));
  check('a Thursday inside the range matches', () => assert.equal(occursOnDate(CALCULUS, '2026-10-08'), true));
  check('a Monday inside the range does not match (wrong day of week)', () => assert.equal(occursOnDate(CALCULUS, '2026-10-05'), false));
  check('the start_date itself matches (inclusive)', () => assert.equal(occursOnDate(CALCULUS, '2026-09-01'), true));
  check('the end_date itself matches (inclusive)', () => assert.equal(occursOnDate(CALCULUS, '2026-12-15'), true));
  check('a Tuesday before start_date does not match', () => assert.equal(occursOnDate(CALCULUS, '2026-08-25'), false));
  check('a Tuesday after end_date does not match', () => assert.equal(occursOnDate(CALCULUS, '2026-12-22'), false));
  check('null series never matches', () => assert.equal(occursOnDate(null, '2026-10-06'), false));
});

// ---------------------------------------------------------------------------
scenario('E. findException / resolveOccurrenceForDate', () => {
  const skipException = { series_id: 'series-calc', exception_date: '2026-10-06', action: 'skip' };
  const modifyException = {
    series_id: 'series-calc',
    exception_date: '2026-10-08',
    action: 'modify',
    override_name: 'Calculus (room change)',
    override_start_time: '15:00',
    override_end_time: null,
  };
  const exceptions = [skipException, modifyException];

  check('findException finds the exact series+date match', () => {
    assert.equal(findException(exceptions, 'series-calc', '2026-10-06'), skipException);
  });
  check('findException misses a different date', () => assert.equal(findException(exceptions, 'series-calc', '2026-10-13'), null));

  check('a plain occurrence with no exception resolves to the series defaults', () => {
    assert.deepEqual(resolveOccurrenceForDate(CALCULUS, '2026-10-13', []), {
      seriesId: 'series-calc',
      name: 'Calculus',
      start_time: '14:00',
      end_time: '15:20',
      isModified: false,
    });
  });
  check('a skipped occurrence resolves to null', () => assert.equal(resolveOccurrenceForDate(CALCULUS, '2026-10-06', exceptions), null));
  check('a modified occurrence applies only the overridden fields, falling back for the rest', () => {
    assert.deepEqual(resolveOccurrenceForDate(CALCULUS, '2026-10-08', exceptions), {
      seriesId: 'series-calc',
      name: 'Calculus (room change)',
      start_time: '15:00',
      end_time: '15:20', // not overridden -> falls back to the series default
      isModified: true,
    });
  });
  check('a date the series does not occur on at all resolves to null regardless of exceptions', () => {
    assert.equal(resolveOccurrenceForDate(CALCULUS, '2026-10-05', exceptions), null);
  });
});

// ---------------------------------------------------------------------------
scenario('F. buildEffectiveClassesForDate', () => {
  const adHocClasses = [{ id: 'c1', name: 'Art Club', start_time: '16:00', end_time: '17:00' }];
  const seriesList = [CALCULUS];
  const exceptions = [];

  check('merges ad-hoc and recurring classes, sorted by start time', () => {
    const result = buildEffectiveClassesForDate({ adHocClasses, seriesList, exceptions, dateStr: '2026-10-06' });
    assert.deepEqual(
      result.map((c) => c.name),
      ['Calculus', 'Art Club']
    );
  });
  check('tags the ad-hoc class as manual and the recurring one as recurring', () => {
    const result = buildEffectiveClassesForDate({ adHocClasses, seriesList, exceptions, dateStr: '2026-10-06' });
    const art = result.find((c) => c.name === 'Art Club');
    const calc = result.find((c) => c.name === 'Calculus');
    assert.equal(art.source, 'manual');
    assert.equal(calc.source, 'recurring');
    assert.equal(calc.seriesId, 'series-calc');
    assert.equal(calc.isModified, false);
  });
  check('a date the series does not occur on shows only the ad-hoc classes', () => {
    const result = buildEffectiveClassesForDate({ adHocClasses, seriesList, exceptions, dateStr: '2026-10-05' });
    assert.deepEqual(result.map((c) => c.name), ['Art Club']);
  });
  check('a skipped occurrence is simply absent, not a gap or an error', () => {
    const skipped = [{ series_id: 'series-calc', exception_date: '2026-10-06', action: 'skip' }];
    const result = buildEffectiveClassesForDate({ adHocClasses, seriesList, exceptions: skipped, dateStr: '2026-10-06' });
    assert.deepEqual(result.map((c) => c.name), ['Art Club']);
  });

  check('PURITY: calling it twice with identical inputs returns deep-equal results and never mutates inputs', () => {
    const adHocFrozen = JSON.parse(JSON.stringify(adHocClasses));
    const seriesFrozen = JSON.parse(JSON.stringify(seriesList));
    const first = buildEffectiveClassesForDate({ adHocClasses, seriesList, exceptions, dateStr: '2026-10-06' });
    const second = buildEffectiveClassesForDate({ adHocClasses, seriesList, exceptions, dateStr: '2026-10-06' });
    assert.deepEqual(first, second);
    assert.deepEqual(adHocClasses, adHocFrozen);
    assert.deepEqual(seriesList, seriesFrozen);
  });
  check('calling it 50 times never grows the result — this is the exact "no duplicate classes on load" guarantee', () => {
    let result;
    for (let i = 0; i < 50; i++) {
      result = buildEffectiveClassesForDate({ adHocClasses, seriesList, exceptions, dateStr: '2026-10-06' });
    }
    assert.equal(result.length, 2);
  });
});

// ---------------------------------------------------------------------------
scenario('G. buildSkipExceptionFields / buildModifyExceptionFields', () => {
  check('a skip exception carries no override fields', () => {
    assert.deepEqual(buildSkipExceptionFields('series-calc', '2026-10-06'), {
      series_id: 'series-calc',
      exception_date: '2026-10-06',
      action: 'skip',
      override_name: null,
      override_start_time: null,
      override_end_time: null,
    });
  });
  check('a modify exception stores only what actually changed from the series default', () => {
    const fields = buildModifyExceptionFields(CALCULUS, '2026-10-08', { name: 'Calculus', startTime: '15:00', endTime: '15:20' });
    assert.deepEqual(fields, {
      series_id: 'series-calc',
      exception_date: '2026-10-08',
      action: 'modify',
      override_name: null, // unchanged from series.name -> null, not a redundant copy
      override_start_time: '15:00',
      override_end_time: null, // unchanged from series.end_time -> null
    });
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
