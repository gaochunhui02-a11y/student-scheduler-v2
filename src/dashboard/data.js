import { supabase } from '../lib/supabaseClient.js';
import { tomorrowDateStr, addDaysToDateStr } from './dateUtils.js';
import { aggregateScheduleHistory } from './history.js';
import { extractPlanningFields, buildCopiedClassRows, buildCopiedSubjectRows } from './copySchedule.js';

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

// Like getOrCreateScheduleForDate, but never creates one — null means the
// user has never touched that date. Used by "Copy to another day" to decide
// whether the destination needs an overwrite confirmation without the side
// effect of creating an empty row just to check.
export async function getScheduleForDateIfExists(userId, forDate) {
  const { data, error } = await supabase
    .from('schedules')
    .select('*')
    .eq('user_id', userId)
    .eq('for_date', forDate)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Whether a schedule already has planning input worth warning about before
// overwriting — classes or study subjects. (Every schedule row always has
// *some* wake/sleep/meal/preference values, defaulted or not, so those alone
// don't distinguish "untouched" from "touched.")
export async function scheduleHasPlanningData(scheduleId) {
  const [classesRes, subjectsRes] = await Promise.all([
    supabase.from('classes').select('id', { count: 'exact', head: true }).eq('schedule_id', scheduleId),
    supabase.from('study_subjects').select('id', { count: 'exact', head: true }).eq('schedule_id', scheduleId),
  ]);
  if (classesRes.error) throw classesRes.error;
  if (subjectsRes.error) throw subjectsRes.error;
  return (classesRes.count || 0) > 0 || (subjectsRes.count || 0) > 0;
}

// Copies planning inputs only — day settings, meals, study preferences,
// classes, and study subjects — from one date to another. Never touches the
// generated schedule (schedule_items), lock state, or completion state on
// either date. The destination keeps its own schedule row (created if it
// doesn't exist yet, via getOrCreateScheduleForDate — never a duplicate row
// for the same user+date) and gets entirely new class/subject rows with
// fresh ids; nothing is copied by id, and due dates are copied exactly as
// entered, never shifted. Caller is responsible for confirming an overwrite
// first if the destination already has data (see scheduleHasPlanningData).
export async function copyScheduleToDate(userId, sourceScheduleId, destForDate) {
  const { data: source, error: sourceError } = await supabase
    .from('schedules')
    .select('*')
    .eq('id', sourceScheduleId)
    .single();
  if (sourceError) throw sourceError;

  const [sourceClassesRes, sourceSubjectsRes] = await Promise.all([
    supabase.from('classes').select('*').eq('schedule_id', sourceScheduleId).order('sort_order', { ascending: true }),
    supabase.from('study_subjects').select('*').eq('schedule_id', sourceScheduleId).order('sort_order', { ascending: true }),
  ]);
  if (sourceClassesRes.error) throw sourceClassesRes.error;
  if (sourceSubjectsRes.error) throw sourceSubjectsRes.error;

  const dest = await getOrCreateScheduleForDate(userId, destForDate);
  const updatedDest = await updateSchedule(dest.id, extractPlanningFields(source));

  const { error: deleteClassesError } = await supabase.from('classes').delete().eq('schedule_id', dest.id);
  if (deleteClassesError) throw deleteClassesError;
  const classRows = buildCopiedClassRows(sourceClassesRes.data, dest.id, userId);
  if (classRows.length > 0) {
    const { error } = await supabase.from('classes').insert(classRows);
    if (error) throw error;
  }

  const { error: deleteSubjectsError } = await supabase.from('study_subjects').delete().eq('schedule_id', dest.id);
  if (deleteSubjectsError) throw deleteSubjectsError;
  const subjectRows = buildCopiedSubjectRows(sourceSubjectsRes.data, dest.id, userId);
  if (subjectRows.length > 0) {
    const { error } = await supabase.from('study_subjects').insert(subjectRows);
    if (error) throw error;
  }

  return updatedDest;
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

// ---------------- subtasks (V2-A) ----------------

export async function listSubtasks(subjectId) {
  const { data, error } = await supabase
    .from('study_subject_subtasks')
    .select('*')
    .eq('subject_id', subjectId)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return data;
}

// Bulk read for a whole day's study list at once (one round trip instead of
// one per task), same shape as listScheduleItemsForScheduleIds below.
export async function listSubtasksForSubjectIds(subjectIds) {
  if (!subjectIds || subjectIds.length === 0) return [];
  const { data, error } = await supabase
    .from('study_subject_subtasks')
    .select('*')
    .in('subject_id', subjectIds)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return data;
}

export async function insertSubtask(subjectId, userId, fields, sortOrder) {
  const { data, error } = await supabase
    .from('study_subject_subtasks')
    .insert({ subject_id: subjectId, user_id: userId, sort_order: sortOrder, ...fields })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateSubtask(id, fields) {
  const { error } = await supabase
    .from('study_subject_subtasks')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteSubtask(id) {
  const { error } = await supabase.from('study_subject_subtasks').delete().eq('id', id);
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

// Manual edit (Phase 9): a targeted update of just the time columns, so
// nothing else on the row — locked, completed, source_subject_id, name —
// is ever touched by moving a block. That's what makes a completed and/or
// locked block's other state automatically survive a manual edit: this
// never replaces the row, only two of its columns.
export async function updateScheduleItemTime(id, startMinutes, endMinutes) {
  const { error } = await supabase.from('schedule_items').update({ start_minutes: startMinutes, end_minutes: endMinutes }).eq('id', id);
  if (error) throw error;
}

// ---------------- Dashboard analytics (Phase 10) ----------------
// Read-only queries reusing the exact same tables/RLS every other feature
// already uses — no new table, no new column. Each is a small, differently
// shaped SELECT on data this file already knows how to read one row/date at
// a time; these just do it for several dates or subjects at once so the
// analytics view isn't making 10+ round trips.

// All of this user's schedule rows whose for_date falls within
// [startDate, endDate] inclusive — the "This Week" window. Ordered oldest
// first so callers can zip it directly against a list of date strings.
export async function listSchedulesInRange(userId, startDate, endDate) {
  const { data, error } = await supabase
    .from('schedules')
    .select('*')
    .eq('user_id', userId)
    .gte('for_date', startDate)
    .lte('for_date', endDate)
    .order('for_date', { ascending: true });
  if (error) throw error;
  return data;
}

export async function listScheduleItemsForScheduleIds(scheduleIds) {
  if (!scheduleIds || scheduleIds.length === 0) return [];
  const { data, error } = await supabase.from('schedule_items').select('*').in('schedule_id', scheduleIds);
  if (error) throw error;
  return data;
}

export async function listStudySubjectsForScheduleIds(scheduleIds) {
  if (!scheduleIds || scheduleIds.length === 0) return [];
  const { data, error } = await supabase.from('study_subjects').select('*').in('schedule_id', scheduleIds);
  if (error) throw error;
  return data;
}

export async function listClassesForScheduleIds(scheduleIds) {
  if (!scheduleIds || scheduleIds.length === 0) return [];
  const { data, error } = await supabase.from('classes').select('*').in('schedule_id', scheduleIds);
  if (error) throw error;
  return data;
}

// Every one of this user's study subjects with a due date on or after
// `fromDate`, across every schedule/date they were created under — not
// just the current week — for the Upcoming Deadlines list. Capped and
// ordered soonest-first.
export async function listUpcomingStudySubjects(userId, fromDate, limit = 25) {
  const { data, error } = await supabase
    .from('study_subjects')
    .select('*')
    .eq('user_id', userId)
    .not('due_date', 'is', null)
    .gte('due_date', fromDate)
    .order('due_date', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data;
}

// Every one of this user's study subjects with a due date inside
// [startDate, endDate] inclusive, REGARDLESS of which schedule/date they
// were created under — a task's due date is independent of the day it was
// typed in. Used by the Week View (V2-A) to show a deadline on the day it's
// actually due, which listUpcomingStudySubjects' open-ended "due date >=
// fromDate" + fixed limit isn't a good fit for (a week needs an upper bound,
// not a cap on row count).
export async function listStudySubjectsDueInRange(userId, startDate, endDate) {
  const { data, error } = await supabase
    .from('study_subjects')
    .select('*')
    .eq('user_id', userId)
    .not('due_date', 'is', null)
    .gte('due_date', startDate)
    .lte('due_date', endDate)
    .order('due_date', { ascending: true });
  if (error) throw error;
  return data;
}

// ---------------- Smart Multi-Day Planning (Phase 13) ----------------
// Thin reads/writes only — the actual availability/allocation logic lives
// in scheduler.js (computeDayCapacity) and multiDayPlanner.js (pure), with
// multiDayPlan.js stitching the two together. Nothing here decides anything
// on its own.

// Every study_subjects row belonging to one multi-day task's group: the
// root itself (id === rootId) plus every chunk previously split off it
// (origin_subject_id === rootId), each annotated with the calendar date it
// lives on via the schedule_id -> schedules foreign key every other
// embedded select in this file already relies on.
export async function listGroupSubjectRows(userId, rootId) {
  const { data, error } = await supabase
    .from('study_subjects')
    .select('*, schedules(for_date)')
    .eq('user_id', userId)
    .or(`id.eq.${rootId},origin_subject_id.eq.${rootId}`);
  if (error) throw error;
  return (data || []).map((r) => {
    const { schedules: sched, ...rest } = r;
    return { ...rest, for_date: sched ? sched.for_date : null };
  });
}

export async function listScheduleItemsBySourceSubjectIds(subjectIds) {
  if (!subjectIds || subjectIds.length === 0) return [];
  const { data, error } = await supabase.from('schedule_items').select('*').in('source_subject_id', subjectIds);
  if (error) throw error;
  return data;
}

export async function deleteStudySubjects(ids) {
  if (!ids || ids.length === 0) return;
  const { error } = await supabase.from('study_subjects').delete().in('id', ids);
  if (error) throw error;
}

// ---------------- Missed Task + Auto Carry Over (Phase 14) ----------------
// Thin reads/writes only, same split as Phase 13 above — the actual
// remaining-minutes math lives in carryOverModel.js and the actual
// scheduling reuses scheduler.js/multiDayPlanner.js exactly as Phase 13
// already does (see multiDayPlan.js's buildCarryOverPreview/acceptCarryOver).

export async function setScheduleItemMissed(id, missed) {
  const { error } = await supabase.from('schedule_items').update({ missed }).eq('id', id);
  if (error) throw error;
}

// Records completed minutes separately from the block's full planned
// duration and keeps the existing `completed` boolean in sync in the same
// write (caller decides `completed` via carryOverModel.js's
// isFullyCompletedByMinutes) — so a block logged as fully done through this
// path reads identically to one marked done via the plain Done button, and
// a partially-done block correctly reads as NOT completed everywhere
// (Done/Undo button state, analytics, Phase 13 carry-over eligibility).
export async function setScheduleItemPartialCompletion(id, completedMinutes, completed) {
  const { error } = await supabase.from('schedule_items').update({ completed_minutes: completedMinutes, completed }).eq('id', id);
  if (error) throw error;
}

export async function getStudySubjectById(id) {
  if (!id) return null;
  const { data, error } = await supabase.from('study_subjects').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

// Accumulates rather than overwrites — re-running Carry Over on the same
// block (e.g. its first attempt only partially fit before the due date)
// must never re-carry minutes already successfully moved forward. See
// carryOverModel.js's computeRemainingMinutes, which subtracts this same
// running total before offering any more of the block to carry.
export async function incrementScheduleItemCarriedOver(id, addMinutes) {
  if (!addMinutes) return 0;
  const { data: row, error: fetchError } = await supabase.from('schedule_items').select('carried_over_minutes').eq('id', id).single();
  if (fetchError) throw fetchError;
  const next = (row?.carried_over_minutes || 0) + addMinutes;
  const { error } = await supabase.from('schedule_items').update({ carried_over_minutes: next }).eq('id', id);
  if (error) throw error;
  return next;
}
