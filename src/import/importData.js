// Saves a reviewed import (V5-C). Only called after the student pressed
// Import on the review table (importModel.buildImportPlan). Uses the same
// data functions as the Courses, Tasks and Exams pages; nothing here is a
// second way of saving. Each row is saved on its own — a failure is
// reported and the rest still save.

import { has } from '../shared/capabilities.js';
import { todayStr, addDays } from '../shared/dates.js';
import { createCourse, listCourses, createCourseMeeting, listTaskRowsForCourse, listSemesters, invalidateTasks } from '../academics/academicsData.js';
import { pickCourseColor } from '../academics/courseModel.js';
import { listExams, createExam } from '../exams/examsData.js';
import { createTask, canLeaveUnscheduled } from '../tasks/tasksData.js';
import { emitChange } from '../app/context.js';

/** Saved work of a course, for duplicate detection. */
export async function existingForCourse(userId, courseId) {
  if (!courseId) return [];
  const [rows, exams] = await Promise.all([
    has('courses') ? listTaskRowsForCourse(userId, courseId).catch(() => []) : [],
    has('exams') ? listExams(userId).catch(() => []) : [],
  ]);
  return [
    ...rows.filter((r) => !r.origin_subject_id).map((r) => ({ kind: 'task', title: r.name, date: r.due_date })),
    ...exams.filter((e) => e.course_id === courseId).map((e) => ({ kind: 'exam', title: e.name, date: e.exam_date })),
  ];
}

/** The current (or most recent) semester's dates, to prefill meeting ranges. */
export async function currentTerm(userId) {
  if (!has('semesters')) return null;
  const list = await listSemesters(userId).catch(() => []);
  const sem = list.find((s) => s.is_current) || list[0];
  return sem ? { id: sem.id, start: sem.start_date, end: sem.end_date, name: sem.name } : null;
}

/**
 * @param {string} userId
 * @param {{ courseId?: string|null, newCourse?: {name, code}|null, plan: ReturnType<import('./importModel.js').buildImportPlan>, meetingRange?: {start, end}|null, semesterId?: string|null }} p
 * @returns {Promise<{ courseId, tasks: number, exams: number, meetings: number, failed: string[] }>}
 */
export async function applyImport(userId, { courseId = null, newCourse = null, plan, meetingRange = null, semesterId = null }) {
  const failed = [];
  let cid = courseId;
  let courseLabel = '';
  if (!cid && newCourse && newCourse.name && has('courses')) {
    const existing = await listCourses(userId).catch(() => []);
    const row = await createCourse(userId, {
      name: newCourse.name.trim().slice(0, 120),
      code: (newCourse.code || '').trim().slice(0, 32) || null,
      color: pickCourseColor(existing),
      ...(semesterId ? { semester_id: semesterId } : {}),
    });
    cid = row.id;
    courseLabel = row.code || row.name;
  } else if (cid) {
    const c = (await listCourses(userId).catch(() => [])).find((x) => x.id === cid);
    courseLabel = c ? c.code || c.name : '';
  }
  const today = todayStr();
  let tasks = 0;
  for (const t of plan.tasks) {
    try {
      // Imported work has no day yet — "Plan my deadlines" gives it days.
      // Before migration 0021 a day is required: the day before it's due.
      const planDate = canLeaveUnscheduled() ? null : (addDays(t.due_date, -1) > today ? addDays(t.due_date, -1) : today);
      // eslint-disable-next-line no-await-in-loop
      await createTask(userId, { planDate, fields: { ...t, notes: t.notes || '', ...(cid ? { course_id: cid } : {}) } });
      tasks += 1;
    } catch (err) {
      console.error('Import: task failed', t.name, err);
      failed.push(t.name);
    }
  }
  let exams = 0;
  for (const e of plan.exams) {
    try {
      if (has('exams')) {
        // eslint-disable-next-line no-await-in-loop
        await createExam(userId, { ...e, ...(cid ? { course_id: cid } : {}) });
      } else {
        // eslint-disable-next-line no-await-in-loop
        await createTask(userId, { planDate: canLeaveUnscheduled() ? null : today, fields: { name: e.name, due_date: e.exam_date, minutes_requested: 60, ...(cid ? { course_id: cid } : {}) } });
      }
      exams += 1;
    } catch (err) {
      console.error('Import: exam failed', e.name, err);
      failed.push(e.name);
    }
  }
  let meetings = 0;
  if (meetingRange && meetingRange.start && meetingRange.end && meetingRange.end >= meetingRange.start) {
    for (const m of plan.meetings) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await createCourseMeeting(userId, {
          name: m.name.slice(0, 100),
          days_of_week: m.days,
          start_time: m.start,
          end_time: m.end,
          start_date: meetingRange.start,
          end_date: meetingRange.end,
          ...(cid && has('classCourseLinks') ? { course_id: cid } : {}),
        });
        meetings += 1;
      } catch (err) {
        console.error('Import: meeting failed', m.name, err);
        failed.push(m.name);
      }
    }
  }
  invalidateTasks();
  emitChange('tasks');
  emitChange('exams');
  emitChange('courses');
  return { courseId: cid, courseLabel, tasks, exams, meetings, failed };
}
