// Pure, DOM-free, Supabase-free logic for Recurring Classes (V2-B). No
// network, no Date.now() — every function takes "today" or a target date as
// a plain "YYYY-MM-DD" string argument, so it's testable the same way
// scheduler.js/multiDayPlanner.js are.
//
// THE CORE GUARANTEE THIS MODULE EXISTS TO PROVIDE: a recurring class's
// occurrences are never written anywhere just because a date was viewed.
// buildEffectiveClassesForDate (below) is a pure, read-only PROJECTION —
// call it 1 time or 1000 times with the same inputs and it returns the
// same thing, writing nothing, growing nothing. The only writes a caller
// ever needs for recurring classes are: create/update/delete one
// class_series row, or create/update/delete one class_series_exceptions
// row (never a classes row) — see src/dashboard/data.js's
// class_series/class_series_exceptions CRUD.
//
// days_of_week uses JavaScript's own Date#getDay() convention (0 = Sunday
// ... 6 = Saturday) — see migration 0006's comment for why, and note this
// is UNRELATED to src/week/weekModel.js's Monday-first week-grid ordering,
// which is a display choice, not a recurrence rule.

import { timeToMinutes } from './scheduler.js';

export const VALID_DAYS_OF_WEEK = [0, 1, 2, 3, 4, 5, 6];
const MAX_SERIES_NAME_LENGTH = 100;

// ---------------------------------------------------------------------------
// Validation / normalization
// ---------------------------------------------------------------------------

// Sorted, deduplicated, out-of-range values dropped — never throws on bad
// input (a stray string, a float, null), same defensive style as
// tagsModel.js's normalizeTagList.
export function normalizeDaysOfWeek(days) {
  if (!Array.isArray(days)) return [];
  const set = new Set();
  for (const raw of days) {
    const n = typeof raw === 'string' ? parseInt(raw, 10) : raw;
    if (Number.isInteger(n) && VALID_DAYS_OF_WEEK.includes(n)) set.add(n);
  }
  return Array.from(set).sort((a, b) => a - b);
}

export function isValidDaysOfWeek(days) {
  return normalizeDaysOfWeek(days).length > 0;
}

export function isValidTimeRange(startTime, endTime) {
  const start = timeToMinutes(startTime);
  const end = timeToMinutes(endTime);
  return start !== null && end !== null && end > start;
}

// Date range check is a plain string comparison — "YYYY-MM-DD" strings sort
// correctly lexicographically, same trick analyticsModel.js's
// computeUpcomingDeadlines already relies on.
export function isValidDateRange(startDate, endDate) {
  return Boolean(startDate) && Boolean(endDate) && startDate <= endDate;
}

function normalizeSeriesName(name) {
  const str = typeof name === 'string' ? name.trim() : '';
  return str.slice(0, MAX_SERIES_NAME_LENGTH);
}

// Maps raw form input onto the exact shape data.js's createClassSeries/
// updateClassSeries expect. Always returns a fully-shaped object (never
// partial) so the caller can validate the RESULT with
// validateSeriesFields rather than the raw, possibly-messy input.
export function buildSeriesFields({ name, daysOfWeek, startTime, endTime, startDate, endDate } = {}) {
  return {
    name: normalizeSeriesName(name),
    days_of_week: normalizeDaysOfWeek(daysOfWeek),
    start_time: typeof startTime === 'string' ? startTime : '',
    end_time: typeof endTime === 'string' ? endTime : '',
    start_date: typeof startDate === 'string' ? startDate : '',
    end_date: typeof endDate === 'string' ? endDate : '',
  };
}

// One validation pass covering every constraint the 0006 migration also
// enforces at the database level (non-empty days, end > start time,
// end >= start date) plus the one it can't (a non-empty name) — so the UI
// can reject an invalid series before ever calling Supabase, same pattern
// boardModel.js's validateNewEdge already established for the Board.
export function validateSeriesFields(fields) {
  if (!fields || !fields.name) {
    return { valid: false, error: 'Please enter a class name.' };
  }
  if (!isValidDaysOfWeek(fields.days_of_week)) {
    return { valid: false, error: 'Choose at least one day of the week.' };
  }
  if (!isValidTimeRange(fields.start_time, fields.end_time)) {
    return { valid: false, error: 'End time must be after start time.' };
  }
  if (!isValidDateRange(fields.start_date, fields.end_date)) {
    return { valid: false, error: 'End date must be on or after the start date.' };
  }
  return { valid: true, error: null };
}

// ---------------------------------------------------------------------------
// Occurrence resolution (read-only — never writes anything)
// ---------------------------------------------------------------------------

function dayOfWeekFor(dateStr) {
  return new Date(`${dateStr}T00:00:00`).getDay();
}

// Whether `series` is active (date range + day-of-week match) on `dateStr`
// — WITHOUT consulting exceptions. Callers that also need to honor a
// skip/modify exception should use resolveOccurrenceForDate instead; this
// is exported on its own because buildCandidateDates-style callers (a
// future "which dates does this series touch in range X" helper) only
// need the raw recurrence rule, not any one date's override.
export function occursOnDate(series, dateStr) {
  if (!series || !dateStr) return false;
  if (dateStr < series.start_date || dateStr > series.end_date) return false;
  const days = normalizeDaysOfWeek(series.days_of_week);
  return days.includes(dayOfWeekFor(dateStr));
}

// The one exception row (if any) for this series on this exact date, from
// a flat list of class_series_exceptions rows (already scoped to the
// user — no filtering by series_id/date happens anywhere else).
export function findException(exceptions, seriesId, dateStr) {
  return (exceptions || []).find((e) => e.series_id === seriesId && e.exception_date === dateStr) || null;
}

// The single source of truth for "what does THIS series look like on THIS
// date" — null means "doesn't occur at all" (outside its date range, wrong
// day of week, or explicitly skipped that day). Never mutates `series` or
// `exceptions`.
export function resolveOccurrenceForDate(series, dateStr, exceptions) {
  if (!occursOnDate(series, dateStr)) return null;
  const exception = findException(exceptions, series.id, dateStr);
  if (exception && exception.action === 'skip') return null;

  if (exception && exception.action === 'modify') {
    return {
      seriesId: series.id,
      name: exception.override_name || series.name,
      start_time: exception.override_start_time || series.start_time,
      end_time: exception.override_end_time || series.end_time,
      isModified: true,
    };
  }
  return { seriesId: series.id, name: series.name, start_time: series.start_time, end_time: series.end_time, isModified: false };
}

// ---------------------------------------------------------------------------
// The merged view a single date's Planner actually needs
// ---------------------------------------------------------------------------

// Combines this date's AD-HOC classes rows (as-is, untouched, `source`
// already whatever data.js read back — 'manual' or 'imported') with every
// active, non-skipped recurring occurrence for the same date, sorted by
// start time. Each recurring entry is tagged `source: 'recurring'` plus
// `seriesId`/`isModified` so the UI can render a distinct badge/action
// (e.g. "edit this occurrence" vs. a plain delete) without re-deriving
// which rows are which.
//
// PURE: calling this 1 or 100 times with the same arguments returns
// equal results every time and writes nothing — see the module doc
// comment above for why that property is the entire point of this file.
//
// @param {object} input
// @param {{id:string,name:string,start_time:string,end_time:string,source?:string}[]} input.adHocClasses
// @param {{id:string,name:string,days_of_week:number[],start_time:string,end_time:string,start_date:string,end_date:string}[]} input.seriesList
// @param {{series_id:string,exception_date:string,action:'skip'|'modify',override_name?:string,override_start_time?:string,override_end_time?:string}[]} input.exceptions
// @param {string} input.dateStr
export function buildEffectiveClassesForDate({ adHocClasses, seriesList, exceptions, dateStr }) {
  const manual = (adHocClasses || []).map((c) => ({ ...c, source: c.source || 'manual' }));

  const recurring = [];
  (seriesList || []).forEach((series) => {
    const occurrence = resolveOccurrenceForDate(series, dateStr, exceptions);
    if (occurrence) {
      recurring.push({
        id: null,
        name: occurrence.name,
        start_time: occurrence.start_time,
        end_time: occurrence.end_time,
        source: 'recurring',
        seriesId: occurrence.seriesId,
        isModified: occurrence.isModified,
      });
    }
  });

  return [...manual, ...recurring].sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
}

// ---------------------------------------------------------------------------
// Building an exception row (edit/delete ONE occurrence)
// ---------------------------------------------------------------------------

// Fields for a "delete just this occurrence" exception — never touches the
// series itself or any other date.
export function buildSkipExceptionFields(seriesId, dateStr) {
  return { series_id: seriesId, exception_date: dateStr, action: 'skip', override_name: null, override_start_time: null, override_end_time: null };
}

// Fields for an "edit just this occurrence" exception. Only the fields the
// caller actually overrides are stored non-null — a field left the same as
// the series default is stored as null, so a later change to the SERIES'
// own default time doesn't get masked by a stale identical-looking
// override (null means "use the series default," not "frozen at the time
// this exception was created").
export function buildModifyExceptionFields(series, dateStr, { name, startTime, endTime } = {}) {
  return {
    series_id: series.id,
    exception_date: dateStr,
    action: 'modify',
    override_name: name && name !== series.name ? name : null,
    override_start_time: startTime && startTime !== series.start_time ? startTime : null,
    override_end_time: endTime && endTime !== series.end_time ? endTime : null,
  };
}
