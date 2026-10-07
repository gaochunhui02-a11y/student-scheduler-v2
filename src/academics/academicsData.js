// Data access for V3 academic records (semesters, courses, course-scoped
// tasks). Thin Supabase calls only — logic lives in the *Model.js files.
// Every query is scoped by user_id AND protected by RLS on the server.
// Reads go through the shared cache (src/app/store.js); writes invalidate.

import { supabase } from '../lib/supabaseClient.js';
import { cached, invalidate } from '../app/store.js';
import { emitChange } from '../app/context.js';
import { has } from '../shared/capabilities.js';

function nowIso() {
  return new Date().toISOString();
}

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

function withDate(rows) {
  return (rows || []).map((r) => {
    const { schedules: sched, ...rest } = r;
    return { ...rest, for_date: sched ? sched.for_date : rest.for_date ?? null };
  });
}

// ---------------- semesters ----------------

export function listSemesters(userId) {
  return cached('semesters', async () => unwrap(await supabase.from('semesters').select('*').eq('user_id', userId).order('start_date', { ascending: false })));
}

export async function createSemester(userId, fields) {
  const row = unwrap(await supabase.from('semesters').insert({ user_id: userId, ...fields }).select().single());
  invalidate('semesters');
  emitChange('semesters');
  return row;
}

export async function updateSemester(id, fields) {
  const row = unwrap(await supabase.from('semesters').update({ ...fields, updated_at: nowIso() }).eq('id', id).select().single());
  invalidate('semesters');
  emitChange('semesters');
  return row;
}

export async function deleteSemester(id) {
  unwrap(await supabase.from('semesters').delete().eq('id', id));
  invalidate('semesters');
  invalidate('courses'); // courses.semester_id becomes null
  emitChange('semesters');
}

// Two steps because a partial unique index allows only one current
// semester per user: clear the old flag first, then set the new one. If
// the second step fails the previous current semester is restored.
export async function setCurrentSemester(userId, id) {
  const previous = (await listSemesters(userId)).find((s) => s.is_current);
  if (previous && previous.id === id) return;
  unwrap(await supabase.from('semesters').update({ is_current: false, updated_at: nowIso() }).eq('user_id', userId).eq('is_current', true));
  try {
    unwrap(await supabase.from('semesters').update({ is_current: true, updated_at: nowIso() }).eq('id', id));
  } catch (err) {
    if (previous) await supabase.from('semesters').update({ is_current: true }).eq('id', previous.id);
    invalidate('semesters');
    throw err;
  }
  invalidate('semesters');
  emitChange('semesters');
}

// ---------------- courses ----------------

export function listCourses(userId) {
  return cached('courses', async () => unwrap(await supabase.from('courses').select('*').eq('user_id', userId).order('sort_order', { ascending: true })));
}

export async function getCourseById(userId, id) {
  const all = await listCourses(userId);
  return all.find((c) => c.id === id) || null;
}

export async function createCourse(userId, fields) {
  const existing = await listCourses(userId).catch(() => []);
  const row = unwrap(await supabase.from('courses').insert({ user_id: userId, sort_order: existing.length, ...fields }).select().single());
  invalidate('courses');
  emitChange('courses');
  return row;
}

export async function updateCourse(id, fields) {
  const row = unwrap(await supabase.from('courses').update({ ...fields, updated_at: nowIso() }).eq('id', id).select().single());
  invalidate('courses');
  emitChange('courses');
  return row;
}

// Deleting a course never deletes its tasks/classes/boards: the database
// sets their course_id to null (migration 0011, ON DELETE SET NULL).
// Grade categories/items and resources DO cascade (they only exist as
// part of a course).
export async function deleteCourse(id) {
  unwrap(await supabase.from('courses').delete().eq('id', id));
  invalidate('courses');
  invalidate('tasks');
  invalidate('series');
  emitChange('courses');
}

// ---------------- recurring class series (course meetings) ----------------

export function listAllClassSeries(userId) {
  return cached('series', async () => unwrap(await supabase.from('class_series').select('*').eq('user_id', userId).order('created_at', { ascending: true })));
}

export function listAllClassSeriesExceptions(userId) {
  return cached('series:exceptions', async () => {
    const res = await supabase.from('class_series_exceptions').select('*').eq('user_id', userId);
    if (res.error) return []; // 0006 not applied: no exceptions
    return res.data || [];
  });
}

export async function createCourseMeeting(userId, fields) {
  const row = unwrap(await supabase.from('class_series').insert({ user_id: userId, ...fields }).select().single());
  invalidate('series');
  emitChange('classes');
  return row;
}

export async function updateClassSeriesCourse(seriesId, courseId) {
  unwrap(await supabase.from('class_series').update({ course_id: courseId, updated_at: nowIso() }).eq('id', seriesId));
  invalidate('series');
  emitChange('classes');
}

// One-off class on a day (classes table) -> course. Used by onboarding.
export async function setClassCourse(classId, courseId) {
  unwrap(await supabase.from('classes').update({ course_id: courseId }).eq('id', classId));
  invalidate('series');
}

export async function deleteCourseMeeting(seriesId) {
  unwrap(await supabase.from('class_series').delete().eq('id', seriesId));
  invalidate('series');
  emitChange('classes');
}

// ---------------- tasks (study_subjects) scoped by course ----------------

// Root rows linked to the course plus every chunk split off them
// (chunks inherit the root's course even if their own course_id is null).
export async function listTaskRowsForCourse(userId, courseId) {
  return cached(`tasks:course:${courseId}`, async () => {
    const roots = withDate(unwrap(await supabase.from('study_subjects').select('*, schedules(for_date)').eq('user_id', userId).eq('course_id', courseId)));
    const rootIds = roots.filter((r) => !r.origin_subject_id).map((r) => r.id);
    if (rootIds.length === 0) return roots;
    const chunks = withDate(unwrap(await supabase.from('study_subjects').select('*, schedules(for_date)').in('origin_subject_id', rootIds)));
    const seen = new Set(roots.map((r) => r.id));
    return [...roots, ...chunks.filter((c) => !seen.has(c.id))];
  }, { ttl: 15000 });
}

// Every course-linked task (roots with a course + their chunks) — one
// query pair for the whole Courses page instead of one per course.
export async function listAllCourseTaskRows(userId) {
  return cached('tasks:courses', async () => {
    const roots = withDate(unwrap(await supabase.from('study_subjects').select('*, schedules(for_date)').eq('user_id', userId).not('course_id', 'is', null)));
    const rootIds = roots.filter((r) => !r.origin_subject_id).map((r) => r.id);
    if (rootIds.length === 0) return roots;
    const seen = new Set(roots.map((r) => r.id));
    const chunks = [];
    for (let i = 0; i < rootIds.length; i += 150) {
      // eslint-disable-next-line no-await-in-loop
      chunks.push(...withDate(unwrap(await supabase.from('study_subjects').select('*, schedules(for_date)').in('origin_subject_id', rootIds.slice(i, i + 150)))));
    }
    return [...roots, ...chunks.filter((c) => !seen.has(c.id))];
  }, { ttl: 15000 });
}

// Every task row for the user (bounded): due or scheduled within the
// window, plus anything undated that is still open. Used by the Tasks
// page, workload, semester and search.
export async function listTaskRowsInWindow(userId, fromDate, toDate) {
  return cached(`tasks:window:${fromDate}:${toDate}`, async () => {
    const [due, scheduled, backlog] = await Promise.all([
      supabase.from('study_subjects').select('*, schedules(for_date)').eq('user_id', userId).gte('due_date', fromDate).lte('due_date', toDate),
      supabase.from('schedules').select('id, for_date').eq('user_id', userId).gte('for_date', fromDate).lte('for_date', toDate),
      // V4-B.1: unscheduled (backlog) tasks have no day, so no window applies.
      has('unscheduledTasks') ? supabase.from('study_subjects').select('*, schedules(for_date)').eq('user_id', userId).is('schedule_id', null) : Promise.resolve({ data: [], error: null }),
    ]);
    const dueRows = [...withDate(unwrap(due)), ...withDate(unwrap(backlog))];
    const scheduleIds = (unwrap(scheduled) || []).map((s) => s.id);
    let scheduledRows = [];
    if (scheduleIds.length) {
      scheduledRows = withDate(unwrap(await supabase.from('study_subjects').select('*, schedules(for_date)').in('schedule_id', scheduleIds)));
    }
    const map = new Map();
    [...dueRows, ...scheduledRows].forEach((r) => map.set(r.id, r));
    // Pull in roots/chunks of anything found so groups are complete.
    const rows = [...map.values()];
    const missingRootIds = [...new Set(rows.map((r) => r.origin_subject_id).filter((id) => id && !map.has(id)))];
    if (missingRootIds.length) {
      withDate(unwrap(await supabase.from('study_subjects').select('*, schedules(for_date)').in('id', missingRootIds))).forEach((r) => map.set(r.id, r));
    }
    const rootIds = [...map.values()].filter((r) => !r.origin_subject_id).map((r) => r.id);
    if (rootIds.length) {
      withDate(unwrap(await supabase.from('study_subjects').select('*, schedules(for_date)').in('origin_subject_id', rootIds))).forEach((r) => map.set(r.id, r));
    }
    return [...map.values()];
  }, { ttl: 15000 });
}

export async function listBlocksForSubjectIds(subjectIds) {
  if (!subjectIds || subjectIds.length === 0) return [];
  const out = [];
  // Chunk the IN list so very large task sets don't build huge URLs.
  for (let i = 0; i < subjectIds.length; i += 150) {
    const part = subjectIds.slice(i, i + 150);
    // eslint-disable-next-line no-await-in-loop
    out.push(...(unwrap(await supabase.from('schedule_items').select('*').in('source_subject_id', part)) || []));
  }
  return out;
}

export async function listSchedulesInWindow(userId, fromDate, toDate) {
  return cached(`schedules:${fromDate}:${toDate}`, async () => unwrap(await supabase.from('schedules').select('*').eq('user_id', userId).gte('for_date', fromDate).lte('for_date', toDate)), { ttl: 15000 });
}

export async function listItemsForSchedules(scheduleIds) {
  if (!scheduleIds || scheduleIds.length === 0) return [];
  const out = [];
  for (let i = 0; i < scheduleIds.length; i += 150) {
    // eslint-disable-next-line no-await-in-loop
    out.push(...(unwrap(await supabase.from('schedule_items').select('*').in('schedule_id', scheduleIds.slice(i, i + 150))) || []));
  }
  return out;
}

export function invalidateTasks() {
  invalidate('tasks');
  invalidate('schedules');
}
