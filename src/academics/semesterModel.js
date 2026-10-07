// Pure semester logic (V3-B): validation, picking the current term, week
// structure with breaks, progress, and the per-week timeline the Semester
// page draws. All dates are "YYYY-MM-DD" local calendar dates handled via
// src/shared/dates.js (UTC-safe).

import { addDays, diffDays, startOfWeek, isValidDateStr, dateRange, dayOfWeek } from '../shared/dates.js';

export const MAX_SEMESTER_DAYS = 400;

export function validateSemesterFields(input = {}) {
  const errors = {};
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : '';
  if (!name) errors.name = 'semester.errNameRequired';
  const start = input.start_date;
  const end = input.end_date;
  if (!isValidDateStr(start)) errors.start_date = 'semester.errStartRequired';
  if (!isValidDateStr(end)) errors.end_date = 'semester.errEndRequired';
  if (!errors.start_date && !errors.end_date) {
    if (end < start) errors.end_date = 'semester.errEndBeforeStart';
    else if (diffDays(start, end) > MAX_SEMESTER_DAYS) errors.end_date = 'semester.errTooLong';
  }
  const breaks = normalizeBreaks(input.breaks, start, end);
  if (Array.isArray(input.breaks) && breaks.length !== input.breaks.filter((b) => b && (b.name || b.start_date || b.end_date)).length) {
    errors.breaks = 'semester.errBreakInvalid';
  }
  return {
    ok: Object.keys(errors).length === 0,
    errors,
    fields: { name, start_date: start, end_date: end, breaks },
  };
}

// Keeps only well-formed breaks inside the semester, sorted by start.
export function normalizeBreaks(breaks, semesterStart, semesterEnd) {
  if (!Array.isArray(breaks)) return [];
  return breaks
    .filter((b) => b && isValidDateStr(b.start_date) && isValidDateStr(b.end_date) && b.end_date >= b.start_date)
    .filter((b) => !semesterStart || !semesterEnd || (b.start_date >= semesterStart && b.end_date <= semesterEnd))
    .map((b) => ({ name: String(b.name || '').trim().slice(0, 80), start_date: b.start_date, end_date: b.end_date }))
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
}

/**
 * The semester to treat as "current": the one flagged is_current, else
 * the one containing today, else the next one to start, else the most
 * recently ended. null when there are none.
 */
export function pickCurrentSemester(semesters = [], today) {
  if (!semesters.length) return null;
  const flagged = semesters.find((s) => s.is_current);
  if (flagged) return flagged;
  const containing = semesters.find((s) => s.start_date <= today && today <= s.end_date);
  if (containing) return containing;
  const upcoming = semesters.filter((s) => s.start_date > today).sort((a, b) => a.start_date.localeCompare(b.start_date));
  if (upcoming.length) return upcoming[0];
  return semesters.slice().sort((a, b) => b.end_date.localeCompare(a.end_date))[0];
}

export function breakForDate(semester, date) {
  return (semester && Array.isArray(semester.breaks) ? semester.breaks : []).find((b) => b.start_date <= date && date <= b.end_date) || null;
}

/**
 * Monday-start weeks covering the semester. A week counts as a break week
 * when a break covers at least 3 of its weekdays (Mon–Fri).
 */
export function semesterWeeks(semester, today = null) {
  if (!semester || !isValidDateStr(semester.start_date) || !isValidDateStr(semester.end_date)) return [];
  const weeks = [];
  let weekStart = startOfWeek(semester.start_date);
  let index = 0;
  while (weekStart <= semester.end_date && index < 60) {
    index += 1;
    const weekEnd = addDays(weekStart, 6);
    const weekdays = dateRange(weekStart, addDays(weekStart, 4));
    const breakDays = weekdays.map((d) => breakForDate(semester, d)).filter(Boolean);
    const isBreak = breakDays.length >= 3;
    weeks.push({
      index,
      start: weekStart,
      end: weekEnd,
      isBreak,
      breakName: isBreak ? breakDays[0].name : null,
      isCurrent: Boolean(today) && today >= weekStart && today <= weekEnd,
      isPast: Boolean(today) && weekEnd < today,
    });
    weekStart = addDays(weekStart, 7);
  }
  return weeks;
}

export function semesterProgress(semester, today) {
  if (!semester) return null;
  const total = diffDays(semester.start_date, semester.end_date) + 1;
  const elapsed = Math.min(total, Math.max(0, diffDays(semester.start_date, today) + 1));
  const weeks = semesterWeeks(semester, today);
  const current = weeks.find((w) => w.isCurrent);
  return {
    fraction: total > 0 ? elapsed / total : 0,
    totalWeeks: weeks.length,
    weekIndex: current ? current.index : today < semester.start_date ? 0 : weeks.length,
    daysLeft: Math.max(0, diffDays(today, semester.end_date)),
    notStarted: today < semester.start_date,
    finished: today > semester.end_date,
  };
}

// Weekly load thresholds in minutes of academic work (study planned + work
// still due that week). Absolute, so a label means the same thing every
// week: under 5h light, under 12h balanced, under 20h busy, else intense.
export const WEEK_LOAD_THRESHOLDS = { light: 300, balanced: 720, busy: 1200 };

export function classifyWeekLoad(minutes) {
  if (!minutes) return 'none';
  if (minutes < WEEK_LOAD_THRESHOLDS.light) return 'light';
  if (minutes < WEEK_LOAD_THRESHOLDS.balanced) return 'balanced';
  if (minutes < WEEK_LOAD_THRESHOLDS.busy) return 'busy';
  return 'intense';
}

/**
 * Per-week timeline for the Semester page.
 * @param {object} p
 * @param {object} p.semester
 * @param {string} p.today
 * @param {Array<{id,name,dueDate,remainingMinutes,courseId,done,major?}>} p.tasks  task groups
 * @param {Array<{id,name,exam_date,course_id}>} p.exams
 * @param {Object<string,number>} p.studyMinutesByDate  planned study minutes per date
 * @param {number} [p.examPrepMinutes] load attributed to the week of each exam
 */
export function buildSemesterTimeline({ semester, today, tasks = [], exams = [], studyMinutesByDate = {}, examPrepMinutes = 180 }) {
  const weeks = semesterWeeks(semester, today);
  return weeks.map((w) => {
    const inWeek = (d) => d && d >= w.start && d <= w.end;
    const deadlines = tasks.filter((t) => inWeek(t.dueDate)).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const weekExams = exams.filter((e) => inWeek(e.exam_date)).sort((a, b) => a.exam_date.localeCompare(b.exam_date));
    const studyMinutes = dateRange(w.start, w.end).reduce((sum, d) => sum + (studyMinutesByDate[d] || 0), 0);
    const dueMinutes = deadlines.filter((t) => !t.done).reduce((sum, t) => sum + (t.remainingMinutes || 0), 0);
    const load = studyMinutes + dueMinutes + weekExams.length * examPrepMinutes;
    return {
      ...w,
      deadlines,
      exams: weekExams,
      studyMinutes,
      dueMinutes,
      load,
      level: w.isBreak && load === 0 ? 'break' : classifyWeekLoad(load),
      majorCount: deadlines.filter((t) => t.major).length + weekExams.length,
    };
  });
}

// Weekday dates (Mon–Fri) inside a semester that aren't in a break —
// "teaching days", used for "N teaching days left".
export function teachingDaysLeft(semester, today) {
  if (!semester || today > semester.end_date) return 0;
  const from = today < semester.start_date ? semester.start_date : today;
  return dateRange(from, semester.end_date).filter((d) => {
    const dow = dayOfWeek(d);
    return dow >= 1 && dow <= 5 && !breakForDate(semester, d);
  }).length;
}
