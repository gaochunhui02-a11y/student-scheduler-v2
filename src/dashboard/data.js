import { supabase } from '../lib/supabaseClient.js';
import { tomorrowDateStr, addDaysToDateStr } from './dateUtils.js';
import { aggregateScheduleHistory } from './history.js';

export { tomorrowDateStr, addDaysToDateStr };

// The date the user was last working on (by schedules.updated_at), so
// reopening the app resumes where they left off. Returns null for a
// brand-new user with no schedules at all yet.
export async function getMostRecentScheduleDate(userId) {
  const { data, error } = await supabase
    .from('schedules')
    .select('for_date')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? data.for_date : null;
}

// Every date is its own independent schedule row (schedules.for_date is
// unique per user — see supabase/schema.sql), fetched or created on demand.
// A freshly created row gets only the table's own defaults — never copies
// classes/subjects/settings from any other date.
export async function getOrCreateScheduleForDate(userId, forDate) {
  const { data: existing, error: fetchError } = await supabase
    .from('schedules')
    .select('*')
    .eq('user_id', userId)
    .eq('for_date', forDate)
    .maybeSingle();
  if (fetchError) throw fetchError;
  if (existing) return existing;

  const { data: created, error: insertError } = await supabase
    .from('schedules')
    .insert({ user_id: userId, for_date: forDate })
    .select()
    .single();
  if (insertError) throw insertError;
  return created;
}

// One row per date the user has touched, with lightweight counts for the
// History list. Three bulk queries (classes/study_subjects/schedule_items
// across the whole user) instead of one per schedule, to avoid N+1 round
// trips as the history grows. The actual per-date aggregation is the pure
// function in history.js, so it can be unit tested without a live database.
export async function listScheduleHistory(userId) {
  const [schedulesRes, classesRes, subjectsRes, itemsRes] = await Promise.all([
    supabase.from('schedules').select('id, for_date').eq('user_id', userId).order('for_date', { ascending: false }),
    supabase.from('classes').select('schedule_id').eq('user_id', userId),
    supabase.from('study_subjects').select('schedule_id').eq('user_id', userId),
    supabase.from('schedule_items').select('schedule_id, item_type, completed').eq('user_id', userId),
  ]);
  if (schedulesRes.error) throw schedulesRes.error;
  if (classesRes.error) throw classesRes.error;
  if (subjectsRes.error) throw subjectsRes.error;
  if (itemsRes.error) throw itemsRes.error;

  return aggregateScheduleHistory(schedulesRes.data, classesRes.data, subjectsRes.data, itemsRes.data);
}

export async function updateSchedule(scheduleId, fields) {
  const { data, error } = await supabase
    .from('schedules')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', scheduleId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ---------------- classes ----------------

export async function listClasses(scheduleId) {
  const { data, error } = await supabase
    .from('classes')
    .select('*')
    .eq('schedule_id', scheduleId)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return data;
}

export async function insertClass(scheduleId, userId, fields, sortOrder) {
  const { data, error } = await supabase
    .from('classes')
    .insert({ schedule_id: scheduleId, user_id: userId, sort_order: sortOrder, ...fields })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateClass(id, fields) {
  const { error } = await supabase.from('classes').update(fields).eq('id', id);
  if (error) throw error;
}

export async function deleteClass(id) {
  const { error } = await supabase.from('classes').delete().eq('id', id);
  if (error) throw error;
}

// ---------------- study subjects ----------------

export async function listStudySubjects(scheduleId) {
  const { data, error } = await supabase
    .from('study_subjects')
    .select('*')
    .eq('schedule_id', scheduleId)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return data;
}

export async function insertStudySubject(scheduleId, userId, fields, sortOrder) {
  const { data, error } = await supabase
    .from('study_subjects')
    .insert({ schedule_id: scheduleId, user_id: userId, sort_order: sortOrder, ...fields })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateStudySubject(id, fields) {
  const { error } = await supabase.from('study_subjects').update(fields).eq('id', id);
  if (error) throw error;
}

export async function deleteStudySubject(id) {
  const { error } = await supabase.from('study_subjects').delete().eq('id', id);
  if (error) throw error;
}

// ---------------- generated schedule (schedule_items) ----------------

export async function listScheduleItems(scheduleId) {
  const { data, error } = await supabase
    .from('schedule_items')
    .select('*')
    .eq('schedule_id', scheduleId)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return data;
}

// Saves a freshly generated/regenerated schedule. Only replaces UNLOCKED rows —
// locked rows are left completely untouched in the database (same id, same
// completed state, same everything), because a locked study block is never
// something generation produced this time around; it's already sitting there
// from before. `events` is the full timeline generateSchedule() returned,
// including the locked blocks it echoed back — those are skipped here since
// they don't need to be (re)written. Freshly (re)inserted rows always start
// completed = false — a brand new/replacement block was never marked done by
// the student, no matter what a same-named block used to say.
export async function saveGeneratedSchedule(scheduleId, userId, events) {
  const { error: deleteError } = await supabase
    .from('schedule_items')
    .delete()
    .eq('schedule_id', scheduleId)
    .eq('locked', false);
  if (deleteError) throw deleteError;

  const toInsert = (events || []).filter((e) => !e.locked);
  if (toInsert.length === 0) return [];

  const rows = toInsert.map((item, i) => ({
    schedule_id: scheduleId,
    user_id: userId,
    item_type: item.type,
    name: item.name,
    start_minutes: item.start,
    end_minutes: item.end,
    sort_order: i,
    locked: false,
    completed: false,
    source_subject_id: item.sourceSubjectId || null,
  }));

  const { data, error: insertError } = await supabase.from('schedule_items').insert(rows).select();
  if (insertError) throw insertError;
  return data;
}

export async function setScheduleItemCompleted(id, completed) {
  const { error } = await supabase.from('schedule_items').update({ completed }).eq('id', id);
  if (error) throw error;
}

export async function setScheduleItemLocked(id, locked) {
  const { error } = await supabase.from('schedule_items').update({ locked }).eq('id', id);
  if (error) throw error;
}
