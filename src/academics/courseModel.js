// Pure course logic (V3-A): colour palette, validation, meeting-schedule
// summaries, next class. No DOM, no Supabase — unit tested in
// tests/courses-semesters.test.js.

import { addDays, dayOfWeek, isValidDateStr, clockToMinutes } from '../shared/dates.js';

// Ten distinguishable course colours that read well on light and dark
// surfaces (the UI derives tints with color-mix, never raw fills).
export const COURSE_COLORS = [
  '#3b6fe0', // cobalt
  '#0f9488', // teal
  '#d48a0c', // amber
  '#d9466b', // rose
  '#7c5ce0', // violet
  '#2f9e57', // green
  '#e06a2c', // orange
  '#0e93b8', // cyan
  '#5b6b82', // slate
  '#c94fa8', // magenta
];

export const COURSE_LIMITS = { name: 120, code: 32, instructor: 120, location: 120, notes: 5000 };

export function pickCourseColor(existingCourses = []) {
  const used = new Set(existingCourses.map((c) => (c.color || '').toLowerCase()));
  const free = COURSE_COLORS.find((c) => !used.has(c));
  return free || COURSE_COLORS[existingCourses.length % COURSE_COLORS.length];
}

function cleanText(value, max) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s ? s.slice(0, max) : null;
}

function parseOptionalNumber(value, min, max) {
  if (value === null || value === undefined || value === '') return { value: null };
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n) || n < min || n > max) return { error: true };
  return { value: Math.round(n * 100) / 100 };
}

/**
 * Validates and normalises a course form. Returns
 * { ok, fields, errors } where errors maps field -> i18n key.
 */
export function validateCourseFields(input = {}) {
  const errors = {};
  const name = cleanText(input.name, COURSE_LIMITS.name);
  if (!name) errors.name = 'courses.errNameRequired';
  const color = /^#[0-9a-fA-F]{6}$/.test(input.color || '') ? input.color.toLowerCase() : null;
  const target = parseOptionalNumber(input.target_grade, 0, 100);
  if (target.error) errors.target_grade = 'courses.errTargetRange';
  const credits = parseOptionalNumber(input.credits, 0, 50);
  if (credits.error) errors.credits = 'courses.errCreditsRange';
  const fields = {
    name,
    code: cleanText(input.code, COURSE_LIMITS.code),
    instructor: cleanText(input.instructor, COURSE_LIMITS.instructor),
    location: cleanText(input.location, COURSE_LIMITS.location),
    notes: (typeof input.notes === 'string' ? input.notes : '').slice(0, COURSE_LIMITS.notes),
    color,
    target_grade: target.value ?? null,
    credits: credits.value ?? null,
    semester_id: input.semester_id || null,
  };
  return { ok: Object.keys(errors).length === 0, fields, errors };
}

export function courseLabel(course) {
  if (!course) return '';
  return course.code ? `${course.code} · ${course.name}` : course.name;
}

export function sortCourses(courses = []) {
  return courses.slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.name).localeCompare(String(b.name)));
}

// Courses shown for a semester filter: 'all', 'none' (no semester) or an id.
export function filterCoursesBySemester(courses, semesterFilter) {
  if (!semesterFilter || semesterFilter === 'all') return courses;
  if (semesterFilter === 'none') return courses.filter((c) => !c.semester_id);
  return courses.filter((c) => c.semester_id === semesterFilter);
}

// ---------------------------------------------------------------------------
// Meeting schedule (class_series rows linked to a course)
// ---------------------------------------------------------------------------

// One line per series: { seriesId, name, days:[1,3,5], start, end } with
// days in Monday-first order for display.
export function summarizeMeetings(seriesList = []) {
  const order = [1, 2, 3, 4, 5, 6, 0];
  return seriesList
    .map((s) => ({
      seriesId: s.id,
      name: s.name,
      days: order.filter((d) => (s.days_of_week || []).includes(d)),
      start: String(s.start_time || '').slice(0, 5),
      end: String(s.end_time || '').slice(0, 5),
      startDate: s.start_date,
      endDate: s.end_date,
    }))
    .sort((a, b) => (a.days[0] ?? 9) - (b.days[0] ?? 9) || a.start.localeCompare(b.start));
}

export function weeklyMeetingMinutes(seriesList = []) {
  return seriesList.reduce((sum, s) => {
    const start = clockToMinutes(String(s.start_time || ''));
    const end = clockToMinutes(String(s.end_time || ''));
    if (start === null || end === null || end <= start) return sum;
    return sum + (end - start) * (s.days_of_week || []).length;
  }, 0);
}

function occursOn(series, date, exceptionsBySeries) {
  if (!isValidDateStr(date)) return null;
  if (date < series.start_date || date > series.end_date) return null;
  if (!(series.days_of_week || []).includes(dayOfWeek(date))) return null;
  const ex = (exceptionsBySeries[series.id] || []).find((e) => e.exception_date === date);
  if (ex && ex.action === 'skip') return null;
  const start = String((ex && ex.override_start_time) || series.start_time).slice(0, 5);
  const end = String((ex && ex.override_end_time) || series.end_time).slice(0, 5);
  return { seriesId: series.id, date, name: (ex && ex.override_name) || series.name, start, end };
}

/**
 * The next class meeting at or after (fromDate, nowMinutes) across the
 * given series, honouring skip/modify exceptions. Looks ahead `horizon`
 * days. Returns null when nothing is scheduled.
 */
export function nextMeeting(seriesList = [], exceptions = [], fromDate, nowMinutes = 0, horizon = 21) {
  const exceptionsBySeries = {};
  exceptions.forEach((e) => { (exceptionsBySeries[e.series_id] ||= []).push(e); });
  for (let i = 0; i <= horizon; i += 1) {
    const date = addDays(fromDate, i);
    const todays = seriesList
      .map((s) => occursOn(s, date, exceptionsBySeries))
      .filter(Boolean)
      .filter((m) => i > 0 || (clockToMinutes(m.end) ?? 0) > nowMinutes)
      .sort((a, b) => a.start.localeCompare(b.start));
    if (todays.length) return todays[0];
  }
  return null;
}

export function meetingsOnDate(seriesList = [], exceptions = [], date) {
  const exceptionsBySeries = {};
  exceptions.forEach((e) => { (exceptionsBySeries[e.series_id] ||= []).push(e); });
  return seriesList.map((s) => occursOn(s, date, exceptionsBySeries)).filter(Boolean).sort((a, b) => a.start.localeCompare(b.start));
}
