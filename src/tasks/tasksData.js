// Task writes for V3 views (Tasks page, Course pages, Quick Add). A task
// is still an ordinary study_subjects row on the schedule of the day the
// student plans to work on it — exactly what the Planner creates — so the
// Planner, Generate, Multi-Day Planning and Carry Over all keep working
// on V3-created tasks unchanged.

import { supabase } from '../lib/supabaseClient.js';
import { getOrCreateScheduleForDate } from '../dashboard/data.js';
import { invalidateTasks } from '../academics/academicsData.js';
import { emitChange, app } from '../app/context.js';
import { has } from '../shared/capabilities.js';

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

// Drops V3-only columns the connected database doesn't have yet, so a
// pre-migration database still accepts the write.
export function capabilityFilter(fields) {
  const out = { ...fields };
  if (!has('courseLinks')) delete out.course_id;
  if (!has('taskExtensions')) {
    ['completed_at', 'actual_minutes', 'dependency_override', 'exam_topic_id', 'recurrence_rule_id', 'recurrence_date'].forEach((k) => delete out[k]);
  }
  return out;
}

function afterTaskWrite(planDate) {
  invalidateTasks();
  emitChange('tasks');
  // If the Planner is showing the affected day, reload it so the new row
  // appears there too (never a second copy — the Planner reads this row).
  const ctx = app();
  if (!planDate || ctx.plannerDate() === planDate) ctx.refreshPlanner();
}

export async function createTask(userId, { planDate, fields }) {
  const schedule = await getOrCreateScheduleForDate(userId, planDate);
  const countRes = await supabase.from('study_subjects').select('id', { count: 'exact', head: true }).eq('schedule_id', schedule.id);
  const sortOrder = countRes.count || 0;
  const row = unwrap(await supabase.from('study_subjects').insert(capabilityFilter({
    schedule_id: schedule.id,
    user_id: userId,
    sort_order: sortOrder,
    tags: [],
    ...fields,
  })).select().single());
  afterTaskWrite(planDate);
  return { ...row, for_date: planDate };
}

export async function updateTask(id, fields, { planDate = null } = {}) {
  unwrap(await supabase.from('study_subjects').update(capabilityFilter(fields)).eq('id', id));
  afterTaskWrite(planDate);
}

// Moves the root row to another day's schedule (the "work on it on" date).
// Its generated study blocks stay where they were; the student regenerates
// the new day when ready, same as editing a task in the Planner.
export async function moveTaskToDate(userId, id, newPlanDate, oldPlanDate) {
  const schedule = await getOrCreateScheduleForDate(userId, newPlanDate);
  unwrap(await supabase.from('study_subjects').update({ schedule_id: schedule.id }).eq('id', id));
  afterTaskWrite(null);
  if (oldPlanDate) afterTaskWrite(oldPlanDate);
}

export async function setTaskDone(id, done) {
  if (!has('taskExtensions')) throw Object.assign(new Error('needs migration 0014'), { code: 'needs_migration' });
  unwrap(await supabase.from('study_subjects').update({ completed_at: done ? new Date().toISOString() : null }).eq('id', id));
  afterTaskWrite(null);
}

// Deletes every row of a task group (root + chunks). Study blocks already
// generated from them stay in their day's schedule as plain blocks, the
// same as deleting a task in the Planner.
export async function deleteTaskGroup(rowIds) {
  if (!rowIds || rowIds.length === 0) return;
  unwrap(await supabase.from('study_subjects').delete().in('id', rowIds));
  afterTaskWrite(null);
}
