// Workload forecast (V3-E), pure. For each day in the window it answers
// "how much academic work lands here, and why?" from real data only:
//
//   class minutes   generated class blocks, or (for days not generated yet)
//                   one-off classes + recurring class occurrences
//   study minutes   study already planned that day: the larger of its timed
//                   study blocks and the study tasks placed on it
//   backlog spread  work that is due but NOT placed on any upcoming day
//                   (e.g. missed blocks, tasks only in the past) — spread
//                   evenly from today until the due date, so it shows up as
//                   pressure instead of disappearing
//   exam prep       revision minutes still needed for an upcoming exam and
//                   not yet added to the Planner, spread until the exam
//
// A day's STUDY LOAD (study + backlog + exam prep) is compared with the
// student's own daily study limit for that day:
//   light       ≤ 35% of the limit
//   balanced    ≤ 80%
//   busy        ≤ 100% (or more than 10 h of class + study in total)
//   overloaded  > 100% — and "overloaded by X" is exactly load − limit
// Every number on a day comes with structured reasons ({key, params}) the
// UI translates, so "why is Thursday busy?" always has an answer.

import { dateRange, addDays, diffDays, dayOfWeek, clockToMinutes } from '../shared/dates.js';

export const LEVELS = ['light', 'balanced', 'busy', 'overloaded'];
const LONG_DAY_MINUTES = 600;

export function classifyDay(studyLoad, capacity, totalCommitted = 0) {
  if (capacity <= 0) return studyLoad > 0 ? 'overloaded' : 'light';
  if (studyLoad > capacity) return 'overloaded';
  if (studyLoad > capacity * 0.8 || totalCommitted > LONG_DAY_MINUTES) return 'busy';
  if (studyLoad > capacity * 0.35) return 'balanced';
  return 'light';
}

function seriesOccurs(series, date, exceptions) {
  if (!series || date < series.start_date || date > series.end_date) return null;
  if (!(series.days_of_week || []).map(Number).includes(dayOfWeek(date))) return null;
  const ex = exceptions.find((e) => e.series_id === series.id && e.exception_date === date);
  if (ex && ex.action === 'skip') return null;
  const start = clockToMinutes(String((ex && ex.override_start_time) || series.start_time));
  const end = clockToMinutes(String((ex && ex.override_end_time) || series.end_time));
  if (start === null || end === null || end <= start) return null;
  return { name: (ex && ex.override_name) || series.name, start, end, courseId: series.course_id || null };
}

function spread(minutes, fromDate, toDate, dates) {
  const span = dateRange(fromDate, toDate).filter((d) => dates.includes(d));
  if (!span.length || minutes <= 0) return {};
  const per = minutes / span.length;
  return Object.fromEntries(span.map((d) => [d, per]));
}

/**
 * @param {object} p
 * @param {string} p.today
 * @param {number} p.days                 7 / 14 / 30
 * @param {number} p.dailyMax             default daily study limit
 * @param {Array}  p.schedules            schedules rows in range (for_date, max_daily_study_minutes)
 * @param {Array}  p.items                schedule_items for those schedules
 * @param {Array}  p.subjects             study_subjects on those schedules
 * @param {Array}  [p.classes]            classes rows (one-off) for those schedules
 * @param {Array}  [p.series]             class_series
 * @param {Array}  [p.exceptions]         class_series_exceptions
 * @param {Array}  [p.groups]             task groups (taskModel) for deadlines/backlog
 * @param {Array}  [p.exams]              exams
 * @param {Object} [p.examPrepByExam]     uncovered revision minutes per exam id
 * @param {string[]} [p.blockedDates]     scenario: days with no study possible
 * @param {number|null} [p.dailyMaxOverride] scenario: one limit for every day
 */
export function buildWorkloadForecast({
  today, days = 7, dailyMax = 240, schedules = [], items = [], subjects = [], classes = [], series = [], exceptions = [],
  groups = [], exams = [], examPrepByExam = {}, blockedDates = [], dailyMaxOverride = null,
}) {
  const dates = dateRange(today, addDays(today, days - 1));
  const scheduleByDate = new Map(schedules.map((s) => [s.for_date, s]));
  const dateBySchedule = new Map(schedules.map((s) => [s.id, s.for_date]));
  const blocked = new Set(blockedDates);
  const out = new Map(dates.map((d) => [d, {
    date: d, classMinutes: 0, studyBlocksMinutes: 0, askedMinutes: 0, backlogMinutes: 0, examPrepMinutes: 0,
    classes: [], studyBlocks: [], plannedTasks: [], deadlines: [], exams: [], backlogTasks: [], prepExams: [],
  }]));

  // Classes + study blocks from generated schedules.
  items.forEach((it) => {
    const d = dateBySchedule.get(it.schedule_id);
    const day = out.get(d);
    if (!day) return;
    const mins = Math.max(0, it.end_minutes - it.start_minutes);
    if (it.item_type === 'class') {
      day.classMinutes += mins;
      day.classes.push({ name: it.name, start: it.start_minutes, end: it.end_minutes, generated: true });
    } else if (it.item_type === 'study') {
      day.studyBlocksMinutes += mins;
      day.studyBlocks.push({ id: it.id, name: it.name, start: it.start_minutes, end: it.end_minutes, locked: Boolean(it.locked), completed: Boolean(it.completed), completedMinutes: it.completed_minutes || 0, missed: Boolean(it.missed), sourceSubjectId: it.source_subject_id || null });
    }
  });
  // Days whose class blocks haven't been generated: project classes.
  dates.forEach((d) => {
    const day = out.get(d);
    if (day.classes.length) return;
    const sched = scheduleByDate.get(d);
    if (sched) {
      classes.filter((c) => c.schedule_id === sched.id).forEach((c) => {
        const s = clockToMinutes(String(c.start_time));
        const e = clockToMinutes(String(c.end_time));
        if (s !== null && e !== null && e > s) {
          day.classMinutes += e - s;
          day.classes.push({ name: c.name, start: s, end: e, generated: false });
        }
      });
    }
    series.forEach((se) => {
      const occ = seriesOccurs(se, d, exceptions);
      if (occ) {
        day.classMinutes += occ.end - occ.start;
        day.classes.push({ name: occ.name, start: occ.start, end: occ.end, generated: false, courseId: occ.courseId });
      }
    });
  });
  // Study tasks placed on each day (counts even before they're timed).
  subjects.forEach((s) => {
    const day = out.get(dateBySchedule.get(s.schedule_id));
    if (!day || s.completed_at) return;
    day.askedMinutes += Number(s.minutes_requested) || 0;
    day.plannedTasks.push({ id: s.id, name: s.name, minutes: Number(s.minutes_requested) || 0, dueDate: s.due_date || null, rootId: s.origin_subject_id || s.id });
  });

  // Deadlines + backlog of work not placed on any upcoming day.
  groups.filter((g) => !g.done).forEach((g) => {
    if (g.dueDate && out.has(g.dueDate)) out.get(g.dueDate).deadlines.push({ id: g.id, name: g.name, remainingMinutes: g.remainingMinutes, courseId: g.courseId });
    if (!g.dueDate) return;
    const futureAsked = g.rows.filter((r) => r.for_date && r.for_date >= today && !r.completed_at).reduce((s, r) => s + (Number(r.minutes_requested) || 0), 0);
    const backlog = Math.max(0, g.remainingMinutes - futureAsked);
    if (backlog <= 0) return;
    const until = g.dueDate < today ? today : g.dueDate;
    const share = spread(backlog, today, until, dates);
    Object.entries(share).forEach(([d, m]) => {
      const day = out.get(d);
      day.backlogMinutes += m;
      day.backlogTasks.push({ id: g.id, name: g.name, minutes: m, dueDate: g.dueDate });
    });
  });

  // Exams on each day + uncovered revision spread before them.
  exams.filter((e) => e.exam_date >= today).forEach((e) => {
    if (out.has(e.exam_date)) out.get(e.exam_date).exams.push({ id: e.id, name: e.name, courseId: e.course_id || null });
    const prep = Math.max(0, examPrepByExam[e.id] || 0);
    if (prep <= 0 || e.exam_date <= today) return;
    const share = spread(prep, today, addDays(e.exam_date, -1), dates);
    Object.entries(share).forEach(([d, m]) => {
      const day = out.get(d);
      day.examPrepMinutes += m;
      day.prepExams.push({ id: e.id, name: e.name, minutes: m });
    });
  });

  return dates.map((d) => {
    const day = out.get(d);
    const sched = scheduleByDate.get(d);
    const baseCap = dailyMaxOverride || (sched && sched.max_daily_study_minutes) || dailyMax;
    const capacity = blocked.has(d) ? 0 : baseCap;
    const studyMinutes = Math.max(day.studyBlocksMinutes, day.askedMinutes);
    const studyLoad = Math.round(studyMinutes + day.backlogMinutes + day.examPrepMinutes);
    const total = studyLoad + day.classMinutes;
    const level = classifyDay(studyLoad, capacity, total);
    const reasons = [];
    if (blocked.has(d)) reasons.push({ key: 'workload.reasonBlocked' });
    if (studyMinutes) reasons.push({ key: 'workload.reasonStudy', params: { time: Math.round(studyMinutes) } });
    if (day.classMinutes) reasons.push({ key: 'workload.reasonClasses', params: { time: day.classMinutes, n: day.classes.length } });
    if (day.backlogMinutes >= 1) reasons.push({ key: 'workload.reasonBacklog', params: { time: Math.round(day.backlogMinutes), n: day.backlogTasks.length } });
    if (day.examPrepMinutes >= 1) reasons.push({ key: 'workload.reasonExamPrep', params: { time: Math.round(day.examPrepMinutes), names: day.prepExams.map((x) => x.name).join(', ') } });
    day.deadlines.forEach((dl) => reasons.push({ key: 'workload.reasonDeadline', params: { name: dl.name } }));
    day.exams.forEach((ex) => reasons.push({ key: 'workload.reasonExam', params: { name: ex.name } }));
    if (level === 'overloaded') reasons.unshift({ key: 'workload.reasonOver', params: { time: studyLoad - capacity, cap: capacity } });
    return {
      ...day,
      backlogMinutes: Math.round(day.backlogMinutes),
      examPrepMinutes: Math.round(day.examPrepMinutes),
      studyMinutes: Math.round(studyMinutes),
      studyLoad,
      totalMinutes: total,
      capacity,
      level,
      overBy: Math.max(0, studyLoad - capacity),
      spare: Math.max(0, capacity - studyLoad),
      blocked: blocked.has(d),
      isToday: d === today,
      reasons,
    };
  });
}

export function summarizeForecast(days) {
  const overloaded = days.filter((d) => d.level === 'overloaded');
  return {
    overloadedDays: overloaded.length,
    busyDays: days.filter((d) => d.level === 'busy').length,
    totalOver: overloaded.reduce((s, d) => s + d.overBy, 0),
    totalStudy: days.reduce((s, d) => s + d.studyLoad, 0),
    totalClass: days.reduce((s, d) => s + d.classMinutes, 0),
    peak: days.reduce((best, d) => (!best || d.studyLoad > best.studyLoad ? d : best), null),
    exams: days.reduce((s, d) => s + d.exams.length, 0),
    deadlines: days.reduce((s, d) => s + d.deadlines.length, 0),
  };
}

/**
 * Tasks that can't be finished before their due date with the spare study
 * time left in the window (after everything else already planned).
 * Uses the earliest-deadline-first rule over each day's spare capacity.
 */
export function deadlineRisks(days, groups, today) {
  const spare = new Map(days.map((d) => [d.date, d.spare]));
  const risks = [];
  groups
    .filter((g) => !g.done && g.dueDate && g.dueDate >= today)
    .map((g) => {
      const futureAsked = g.rows.filter((r) => r.for_date && r.for_date >= today && !r.completed_at).reduce((s, r) => s + (Number(r.minutes_requested) || 0), 0);
      return { g, unplaced: Math.max(0, g.remainingMinutes - futureAsked) };
    })
    .filter((x) => x.unplaced > 0)
    .sort((a, b) => a.g.dueDate.localeCompare(b.g.dueDate) || String(a.g.id).localeCompare(String(b.g.id)))
    .forEach(({ g, unplaced }) => {
      let need = unplaced;
      days.filter((d) => d.date <= g.dueDate).forEach((d) => {
        const free = spare.get(d.date) || 0;
        const take = Math.min(free, need);
        spare.set(d.date, free - take);
        need -= take;
      });
      if (need > 0.5 && days.some((d) => d.date >= g.dueDate)) risks.push({ id: g.id, name: g.name, dueDate: g.dueDate, shortBy: Math.round(need), daysLeft: diffDays(today, g.dueDate) });
    });
  return risks;
}
