// Today page data (V4-D). Reads only — the same task rows, blocks, classes
// and routines every other page uses; no new tables.

import { app } from '../app/context.js';
import { has } from '../shared/capabilities.js';
import { todayStr, addDays, minutesOfDay } from '../shared/dates.js';
import { listCourses, listTaskRowsInWindow, listBlocksForSubjectIds, listAllClassSeries, listAllClassSeriesExceptions } from '../academics/academicsData.js';
import { buildTaskGroups } from '../tasks/taskModel.js';
import { listDependencies } from '../tasks/tasksData.js';
import { computeBlockedState } from '../tasks/dependencyModel.js';
import { listExams } from '../exams/examsData.js';
import { loadForecastInput } from '../workload/workloadData.js';
import { buildCalendarEvents } from '../calendar/calendarEvents.js';
import { listClassesForScheduleIds } from '../dashboard/data.js';
import { listRoutines, listRecentCompletions } from '../routines/routinesData.js';
import { loadReviews } from '../review/reviewData.js';
import { todayAttendance } from '../attendance/attendanceUI.js';

export async function loadToday() {
  const ctx = app();
  const today = todayStr();
  const [rows, courses, exams, forecast, deps, routines, completions, reviews] = await Promise.all([
    listTaskRowsInWindow(ctx.userId, addDays(today, -60), addDays(today, 45)),
    has('courses') ? listCourses(ctx.userId).catch(() => []) : [],
    has('exams') ? listExams(ctx.userId).catch(() => []) : [],
    loadForecastInput(ctx.userId, today, 1).catch(() => null),
    listDependencies(ctx.userId).catch(() => []),
    has('routines') ? listRoutines(ctx.userId).catch(() => []) : [],
    has('routines') ? listRecentCompletions(ctx.userId, today).catch(() => []) : [],
    loadReviews(ctx.userId).catch(() => ({})),
  ]);
  const blocks = await listBlocksForSubjectIds(rows.map((r) => r.id)).catch(() => []);
  const todayScheduleIds = new Set(rows.filter((r) => r.for_date === today).map((r) => r.schedule_id));
  const groups = buildTaskGroups(rows, blocks, { today, nowMinutes: minutesOfDay(), todayScheduleIds });
  const blocked = computeBlockedState(groups, deps);
  let events = [];
  if (forecast) {
    const todaySched = forecast.input.schedules.filter((s) => s.for_date === today);
    const [classes, series, exceptions] = await Promise.all([
      listClassesForScheduleIds(todaySched.map((s) => s.id)).catch(() => []),
      listAllClassSeries(ctx.userId).catch(() => []),
      listAllClassSeriesExceptions(ctx.userId).catch(() => []),
    ]);
    events = buildCalendarEvents({
      from: today, to: today, schedules: todaySched, items: forecast.input.items.filter((i) => todaySched.some((s) => s.id === i.schedule_id)),
      classes, series, exceptions, subjects: forecast.input.subjects, groups, exams, courses,
    }).filter((e) => !e.allDay && ['class', 'study', 'external', 'exam'].includes(e.kind));
  }
  const attendance = await todayAttendance(ctx.userId, today).catch(() => new Map());
  return { today, groups, blocked, courses, exams, events, routines, completions, reviews, attendance };
}
