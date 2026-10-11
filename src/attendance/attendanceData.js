// Attendance I/O (V4-G). Thin Supabase calls; rules in attendanceModel.js.
// Scoped by user_id and protected by RLS (migration 0024). One record per
// (course, day, start minute) — reads first so it behaves the same on
// Postgres and in Demo Mode (no upsert).

import { supabase } from '../lib/supabaseClient.js';
import { cached, invalidate } from '../app/store.js';
import { emitChange } from '../app/context.js';
import { has } from '../shared/capabilities.js';

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

function changed() {
  invalidate('attendance');
  emitChange('attendance');
}

export function listAttendance(userId) {
  if (!has('attendance')) return Promise.resolve([]);
  return cached('attendance', async () => unwrap(await supabase.from('attendance_records').select('*').eq('user_id', userId)));
}

/** One-off classes linked to a course, with their day: [{ date, start_time, end_time, name, course_id }]. */
export function listCourseOneOffClasses(userId) {
  if (!has('classCourseLinks')) return Promise.resolve([]);
  return cached('attendance:oneoffs', async () => {
    const rows = unwrap(await supabase.from('classes').select('*, schedules(for_date)').eq('user_id', userId).not('course_id', 'is', null));
    return (rows || []).filter((c) => c.source !== 'recurring' && c.source !== 'imported').map((c) => ({
      date: c.schedules ? c.schedules.for_date : null, start_time: c.start_time, end_time: c.end_time, name: c.name, course_id: c.course_id,
    })).filter((c) => c.date);
  }, { ttl: 30000 });
}

/**
 * Sets (status) or clears (null) the record of one session.
 * @param {{ course_id, attended_on, start_minutes, class_series_id? }} session
 */
export async function setAttendance(userId, session, status) {
  const existing = unwrap(await supabase.from('attendance_records').select('id, status').eq('user_id', userId)
    .eq('course_id', session.course_id).eq('attended_on', session.attended_on).eq('start_minutes', session.start_minutes));
  const row = existing && existing[0];
  if (!status) {
    if (row) unwrap(await supabase.from('attendance_records').delete().eq('id', row.id));
  } else if (row) {
    if (row.status !== status) unwrap(await supabase.from('attendance_records').update({ status, updated_at: new Date().toISOString() }).eq('id', row.id));
  } else {
    unwrap(await supabase.from('attendance_records').insert({
      user_id: userId, course_id: session.course_id, attended_on: session.attended_on, start_minutes: session.start_minutes,
      class_series_id: session.class_series_id || null, status,
    }));
  }
  changed();
}

/** Marks several unmarked sessions with one status (confirmed in the UI). */
export async function markSessions(userId, courseId, sessions, status) {
  if (!sessions.length) return 0;
  unwrap(await supabase.from('attendance_records').insert(sessions.map((s) => ({
    user_id: userId, course_id: courseId, attended_on: s.date, start_minutes: s.start, class_series_id: s.seriesId || null, status,
  }))));
  changed();
  return sessions.length;
}
