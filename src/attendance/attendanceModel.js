// Attendance (V4-G), pure — no DOM, no Supabase.
//
// A class SESSION is one meeting of a course: (course, day, start minute).
// Sessions come from the course's recurring classes (minus skipped days,
// with moved times) and its one-off classes. A RECORD marks a session
// present / late / absent / excused (migration 0024, one per session).
//
// Rate = (present + late) / (marked − excused). Unmarked sessions are not
// counted as absences — they're listed so the student can fill them in.

import { dateRange, dayOfWeek, clockToMinutes } from '../shared/dates.js';

export const ATTENDANCE_STATUSES = ['present', 'late', 'absent', 'excused'];
export const MIN_RATE = 0.8; // common course requirement; shown as a hint, never enforced

export function sessionKey(courseId, date, start) {
  return `${courseId}|${date}|${start}`;
}

function seriesOccurrence(series, date, exceptions) {
  if (!series || date < series.start_date || date > series.end_date) return null;
  if (!(series.days_of_week || []).map(Number).includes(dayOfWeek(date))) return null;
  const ex = exceptions.find((e) => e.series_id === series.id && e.exception_date === date);
  if (ex && ex.action === 'skip') return null;
  const start = clockToMinutes(String((ex && ex.override_start_time) || series.start_time));
  const end = clockToMinutes(String((ex && ex.override_end_time) || series.end_time));
  if (start === null || end === null || end <= start) return null;
  return { name: (ex && ex.override_name) || series.name, start, end };
}

/**
 * Sessions of one course in [from, to], oldest first, one per (day, start).
 * @param {object} p
 * @param {Array} p.series     class_series rows (any course; filtered here)
 * @param {Array} p.exceptions class_series_exceptions rows
 * @param {Array} p.oneOffs    one-off classes: [{ date, start_time, end_time, name, course_id }]
 */
export function sessionsForCourse({ courseId, series = [], exceptions = [], oneOffs = [], from, to }) {
  const out = new Map();
  const mine = series.filter((s) => s.course_id === courseId);
  dateRange(from, to).forEach((date) => {
    mine.forEach((s) => {
      const occ = seriesOccurrence(s, date, exceptions);
      if (!occ) return;
      const key = `${date}|${occ.start}`;
      if (!out.has(key)) out.set(key, { date, start: occ.start, end: occ.end, name: occ.name, seriesId: s.id });
    });
  });
  oneOffs.filter((c) => c.course_id === courseId && c.date >= from && c.date <= to).forEach((c) => {
    const start = clockToMinutes(String(c.start_time));
    const end = clockToMinutes(String(c.end_time));
    if (start === null || end === null || end <= start) return;
    const key = `${c.date}|${start}`;
    if (!out.has(key)) out.set(key, { date: c.date, start, end, name: c.name, seriesId: null });
  });
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start);
}

/**
 * @param {Array} sessions   from sessionsForCourse
 * @param {Array} records    attendance_records of that course
 * @param {string} today
 * @param {number} nowMinutes  a session counts as held once it has started
 */
export function summarizeAttendance(sessions = [], records = [], today, nowMinutes = 24 * 60) {
  const byKey = new Map(records.map((r) => [`${r.attended_on}|${r.start_minutes}`, r]));
  const held = sessions.filter((s) => s.date < today || (s.date === today && s.start <= nowMinutes));
  const list = held.map((s) => {
    const r = byKey.get(`${s.date}|${s.start}`);
    return { ...s, status: r ? r.status : null, recordId: r ? r.id : null };
  });
  const count = (st) => list.filter((x) => x.status === st).length;
  const present = count('present');
  const late = count('late');
  const absent = count('absent');
  const excused = count('excused');
  const marked = present + late + absent + excused;
  const counted = marked - excused;
  const rate = counted > 0 ? (present + late) / counted : null;
  return {
    held: held.length, marked, present, late, absent, excused, unmarked: held.length - marked,
    rate, list,
    state: rate === null ? null : rate < MIN_RATE ? 'risk' : rate < 0.9 ? 'warning' : 'good',
  };
}

/** Next status when a status button is pressed again: the same one clears it. */
export function toggleStatus(current, pressed) {
  return current === pressed ? null : pressed;
}

export function validateAttendance(input = {}) {
  const status = ATTENDANCE_STATUSES.includes(input.status) ? input.status : null;
  const start = Math.round(Number(input.start_minutes));
  const ok = Boolean(status) && /^\d{4}-\d{2}-\d{2}$/.test(input.attended_on || '') && Number.isFinite(start) && start >= 0 && start <= 1439 && Boolean(input.course_id);
  return { ok, fields: ok ? { course_id: input.course_id, attended_on: input.attended_on, start_minutes: start, status, class_series_id: input.class_series_id || null, note: typeof input.note === 'string' ? input.note.slice(0, 500) : '' } : null };
}

/**
 * How many more absences keep the rate at or above `min` (null when nothing
 * is marked yet). 0 = the next absence drops below it; negative = below already.
 */
export function absencesAllowed(summary, min = MIN_RATE) {
  if (!summary || summary.rate === null) return null;
  const attended = summary.present + summary.late;
  const counted = summary.marked - summary.excused;
  return Math.floor(attended / min - counted + 1e-9);
}
