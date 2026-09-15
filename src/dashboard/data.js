import { supabase } from '../lib/supabaseClient.js';

function tomorrowDateStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// Each user works with one "current" plan at a time (kept simple, matching the
// original single-day planner). We reuse their most recently touched schedule
// row, or create a fresh one for tomorrow if they've never made one.
export async function getOrCreateCurrentSchedule(userId) {
  const { data: existing, error: fetchError } = await supabase
    .from('schedules')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (fetchError) throw fetchError;
  if (existing) return existing;

  const { data: created, error: insertError } = await supabase
    .from('schedules')
    .insert({ user_id: userId, for_date: tomorrowDateStr() })
    .select()
    .single();
  if (insertError) throw insertError;
  return created;
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
// Used once the generation algorithm is built; replaces the whole set each time.

export async function listScheduleItems(scheduleId) {
  const { data, error } = await supabase
    .from('schedule_items')
    .select('*')
    .eq('schedule_id', scheduleId)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return data;
}

export async function replaceScheduleItems(scheduleId, userId, items) {
  const { error: deleteError } = await supabase
    .from('schedule_items')
    .delete()
    .eq('schedule_id', scheduleId);
  if (deleteError) throw deleteError;

  if (items.length === 0) return [];

  const rows = items.map((item, i) => ({
    schedule_id: scheduleId,
    user_id: userId,
    item_type: item.type,
    name: item.name,
    start_minutes: item.start,
    end_minutes: item.end,
    sort_order: i,
  }));

  const { data, error: insertError } = await supabase.from('schedule_items').insert(rows).select();
  if (insertError) throw insertError;
  return data;
}
