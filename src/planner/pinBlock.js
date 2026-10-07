// Pins a study block at a fixed time on a day (locked, so Regenerate keeps
// it). Shared by Quick Add's "Study block" and the task editor's optional
// start time (V4-B). Refuses to overlap a class, meal or another block.

import { supabase } from '../lib/supabaseClient.js';
import { getOrCreateScheduleForDate } from '../dashboard/data.js';
import { app } from '../app/context.js';
import { invalidate } from '../app/store.js';

/**
 * @returns {Promise<{ ok: true } | { ok: false, clash: string }>}
 */
export async function pinStudyBlock({ userId, date, start, minutes, name, taskId = null }) {
  const sched = await getOrCreateScheduleForDate(userId, date);
  const { data: existing, error: readErr } = await supabase.from('schedule_items').select('name, start_minutes, end_minutes, item_type').eq('schedule_id', sched.id);
  if (readErr) throw readErr;
  const clash = (existing || []).find((i) => i.item_type !== 'free' && i.item_type !== 'break' && start < i.end_minutes && start + minutes > i.start_minutes);
  if (clash) return { ok: false, clash: clash.name };
  const { error } = await supabase.from('schedule_items').insert({
    schedule_id: sched.id, user_id: userId, item_type: 'study', name, start_minutes: start, end_minutes: start + minutes,
    sort_order: 999, locked: true, completed: false, source_subject_id: taskId,
  });
  if (error) throw error;
  invalidate('tasks');
  invalidate('schedules');
  const ctx = app();
  if (ctx.plannerDate() === date) ctx.refreshPlanner();
  return { ok: true };
}

/** Does this task already have a block on that day? (Then a start time isn't pinned again.) */
export async function taskHasBlockOn(taskId, date, userId) {
  const sched = await getOrCreateScheduleForDate(userId, date);
  const { data, error } = await supabase.from('schedule_items').select('id').eq('schedule_id', sched.id).eq('source_subject_id', taskId).limit(1);
  if (error) throw error;
  return (data || []).length > 0;
}
