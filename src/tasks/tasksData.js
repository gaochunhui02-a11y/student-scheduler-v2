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
import { cached, invalidate } from '../app/store.js';
import { planGeneration, DEFAULT_HORIZON_DAYS } from './recurringModel.js';
import { addDays } from '../shared/dates.js';

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

// Drops V3-only columns the connected database doesn't have yet, so a
// pre-migration database still accepts the write.
export function capabilityFilter(fields) {
  const out = { ...fields };
  if (!has('courseLinks')) delete out.course_id;
  if (!has('spaceLinks')) delete out.space_id; // V4 (0018)
  if (!has('projectLinks')) { delete out.project_id; delete out.project_milestone_id; } // V4 (0019)
  if (!has('taskFieldsV4')) ['due_time', 'start_time', 'status_override', 'project_sort'].forEach((k) => delete out[k]); // V4 (0020)
  if (!has('unscheduledTasks')) delete out.planned_by; // V4 (0021)
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

/** Can a task be left without a planned day on this database (0021)? */
export function canLeaveUnscheduled() {
  return has('unscheduledTasks');
}

/**
 * Creates a task. planDate = the day to work on it; null/empty = unscheduled
 * (backlog) when the database supports it (0021). Without 0021 a day is
 * required, exactly as in V3 — callers check canLeaveUnscheduled() first.
 * Creating a task never creates a study block.
 */
export async function createTask(userId, { planDate, fields, plannedBy = 'user' }) {
  if (!planDate) {
    if (!has('unscheduledTasks')) throw Object.assign(new Error('a planned day is required before migration 0021'), { code: 'needs_migration' });
    const row = unwrap(await supabase.from('study_subjects').insert(capabilityFilter({
      schedule_id: null,
      user_id: userId,
      sort_order: 0,
      tags: [],
      planned_by: null,
      ...fields,
    })).select().single());
    afterTaskWrite(null);
    return { ...row, for_date: null };
  }
  const schedule = await getOrCreateScheduleForDate(userId, planDate);
  const countRes = await supabase.from('study_subjects').select('id', { count: 'exact', head: true }).eq('schedule_id', schedule.id);
  const sortOrder = countRes.count || 0;
  const row = unwrap(await supabase.from('study_subjects').insert(capabilityFilter({
    schedule_id: schedule.id,
    user_id: userId,
    sort_order: sortOrder,
    tags: [],
    planned_by: plannedBy,
    ...fields,
  })).select().single());
  afterTaskWrite(planDate);
  return { ...row, for_date: planDate };
}

/** Takes a task off its day and back to the backlog (its existing blocks stay on that day, as with a move). */
export async function unscheduleTask(id, oldPlanDate) {
  if (!has('unscheduledTasks')) throw Object.assign(new Error('needs migration 0021'), { code: 'needs_migration' });
  unwrap(await supabase.from('study_subjects').update({ schedule_id: null, planned_by: null }).eq('id', id));
  afterTaskWrite(null);
  if (oldPlanDate) afterTaskWrite(oldPlanDate);
}

export async function updateTask(id, fields, { planDate = null, refresh = true } = {}) {
  unwrap(await supabase.from('study_subjects').update(capabilityFilter(fields)).eq('id', id));
  if (refresh) afterTaskWrite(planDate);
  else {
    invalidateTasks();
    emitChange('tasks');
  }
}

// Moves the root row to another day's schedule (the "work on it on" date).
// Its generated study blocks stay where they were; the student regenerates
// the new day when ready, same as editing a task in the Planner.
export async function moveTaskToDate(userId, id, newPlanDate, oldPlanDate, { plannedBy = 'user' } = {}) {
  const schedule = await getOrCreateScheduleForDate(userId, newPlanDate);
  unwrap(await supabase.from('study_subjects').update(capabilityFilter({ schedule_id: schedule.id, planned_by: plannedBy })).eq('id', id));
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

// ---------------- dependencies (V3-H, migration 0014) ----------------

export function listDependencies(userId) {
  if (!has('dependencies')) return Promise.resolve([]);
  return cached('tasks:deps', async () => unwrap(await supabase.from('task_dependencies').select('*').eq('user_id', userId)));
}

export async function addDependency(userId, taskId, prereqId) {
  unwrap(await supabase.from('task_dependencies').insert({ user_id: userId, task_id: taskId, depends_on_id: prereqId }));
  invalidate('tasks');
  emitChange('tasks');
}

export async function removeDependency(id) {
  unwrap(await supabase.from('task_dependencies').delete().eq('id', id));
  invalidate('tasks');
  emitChange('tasks');
}

// ---------------- recurring rules (V3-H, migration 0014) ----------------
export function listRecurrenceRules(userId) {
  if (!has('recurringTasks')) return Promise.resolve([]);
  return cached('tasks:rules', async () => unwrap(await supabase.from('task_recurrence_rules').select('*').eq('user_id', userId).order('created_at', { ascending: true })));
}

export async function saveRecurrenceRule(userId, id, fields) {
  const row = id
    ? unwrap(await supabase.from('task_recurrence_rules').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', id).select().single())
    : unwrap(await supabase.from('task_recurrence_rules').insert({ user_id: userId, ...fields }).select().single());
  invalidate('tasks');
  emitChange('tasks');
  return row;
}

// Deleting a rule keeps every task it already created (their
// recurrence_rule_id becomes null); it only stops future occurrences.
export async function deleteRecurrenceRule(id) {
  unwrap(await supabase.from('task_recurrence_rules').delete().eq('id', id));
  invalidate('tasks');
  emitChange('tasks');
}

/**
 * Creates any missing tasks for active rules in [today, today + horizon].
 * Idempotent: occurrences that already exist are skipped, and the
 * database's unique (rule, date) index rejects a duplicate created by a
 * second tab at the same moment (that error is treated as "already done").
 */
export async function generateRecurringTasks(userId, today, horizon = DEFAULT_HORIZON_DAYS) {
  if (!has('recurringTasks') || !has('taskExtensions')) return 0;
  const rules = (await listRecurrenceRules(userId)).filter((r) => r.active);
  if (!rules.length) return 0;
  const { data: existing, error } = await supabase
    .from('study_subjects')
    .select('recurrence_rule_id, recurrence_date')
    .eq('user_id', userId)
    .in('recurrence_rule_id', rules.map((r) => r.id))
    .gte('recurrence_date', today)
    .lte('recurrence_date', addDays(today, horizon));
  if (error) throw error;
  const plan = planGeneration(rules, existing || [], today, horizon);
  let created = 0;
  for (const p of plan) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await createTask(userId, { planDate: p.planDate, fields: p.fields });
      created += 1;
    } catch (err) {
      if (!(err && err.code === '23505')) throw err;
    }
  }
  return created;
}

// ---------------- subtasks (V2 table, used by the V3 task editor) ----------------
export async function listSubtasksFor(subjectId) {
  const res = await supabase.from('study_subject_subtasks').select('*').eq('subject_id', subjectId).order('sort_order', { ascending: true });
  if (res.error) return [];
  return res.data || [];
}

/** V4-B.1: open tasks with no planned day (the backlog). */
export async function listBacklogRows(userId) {
  if (!has('unscheduledTasks')) return [];
  return unwrap(await supabase.from('study_subjects').select('*').eq('user_id', userId).is('schedule_id', null).is('completed_at', null));
}
