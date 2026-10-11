// Goals, goal milestones and check-ins I/O (V4-C). Thin Supabase calls;
// rules live in goalModel.js. Every query is scoped by user_id and
// protected by RLS (migration 0022). Linked tasks and projects are ordinary
// study_subjects / projects rows with a goal_id.

import { supabase } from '../lib/supabaseClient.js';
import { cached, invalidate } from '../app/store.js';
import { emitChange } from '../app/context.js';
import { has } from '../shared/capabilities.js';
import { invalidateTasks } from '../academics/academicsData.js';

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}
const nowIso = () => new Date().toISOString();
const withDate = (rows) => (rows || []).map((r) => {
  const { schedules: sched, ...rest } = r;
  return { ...rest, for_date: sched ? sched.for_date : rest.for_date ?? null };
});

function changed() {
  invalidate('goals');
  emitChange('goals');
}

// ---------------- goals ----------------

export function listGoals(userId) {
  if (!has('goals')) return Promise.resolve([]);
  return cached('goals', async () => unwrap(await supabase.from('goals').select('*').eq('user_id', userId).order('sort_order', { ascending: true })));
}

export async function createGoal(userId, fields) {
  const existing = await listGoals(userId).catch(() => []);
  const row = unwrap(await supabase.from('goals').insert({ user_id: userId, sort_order: existing.length, ...fields }).select().single());
  changed();
  return row;
}

export async function updateGoal(id, fields) {
  const patch = { ...fields, updated_at: nowIso() };
  if (fields.status === 'achieved') patch.achieved_at = nowIso();
  else if (fields.status) patch.achieved_at = null;
  const row = unwrap(await supabase.from('goals').update(patch).eq('id', id).select().single());
  changed();
  return row;
}

/** Deletes the goal, its milestones and check-ins; linked tasks, projects and routines stay. */
export async function deleteGoal(id) {
  unwrap(await supabase.from('goals').delete().eq('id', id));
  changed();
  invalidate('projects');
  invalidate('routines');
  invalidateTasks();
  emitChange('tasks');
}

// ---------------- milestones ----------------

export function listGoalMilestones(userId) {
  if (!has('goals')) return Promise.resolve([]);
  return cached('goals:milestones', async () => unwrap(await supabase.from('goal_milestones').select('*').eq('user_id', userId).order('sort_order', { ascending: true })));
}

export async function createGoalMilestone(userId, goalId, fields) {
  const all = await listGoalMilestones(userId).catch(() => []);
  const row = unwrap(await supabase.from('goal_milestones').insert({ user_id: userId, goal_id: goalId, sort_order: all.filter((m) => m.goal_id === goalId).length, ...fields }).select().single());
  changed();
  return row;
}

export async function updateGoalMilestone(id, fields) {
  const patch = { ...fields, updated_at: nowIso() };
  if (fields.status === 'done') patch.completed_at = nowIso();
  else if (fields.status === 'open') patch.completed_at = null;
  const row = unwrap(await supabase.from('goal_milestones').update(patch).eq('id', id).select().single());
  changed();
  return row;
}

export async function deleteGoalMilestone(id) {
  unwrap(await supabase.from('goal_milestones').delete().eq('id', id));
  changed();
}

// ---------------- check-ins ----------------

export function listGoalLogs(userId) {
  if (!has('goals')) return Promise.resolve([]);
  return cached('goals:logs', async () => unwrap(await supabase.from('goal_progress_log').select('*').eq('user_id', userId).order('logged_on', { ascending: true })));
}

export async function addCheckIn(userId, goalId, fields) {
  const row = unwrap(await supabase.from('goal_progress_log').insert({ user_id: userId, goal_id: goalId, ...fields }).select().single());
  changed();
  return row;
}

export async function deleteCheckIn(id) {
  unwrap(await supabase.from('goal_progress_log').delete().eq('id', id));
  changed();
}

// ---------------- linked tasks ----------------

/** Task roots linked to any goal plus every chunk split off them. */
export async function listGoalTaskRows(userId) {
  if (!has('goalLinks')) return [];
  return cached('tasks:goal:all', async () => {
    const roots = withDate(unwrap(await supabase.from('study_subjects').select('*, schedules(for_date)').eq('user_id', userId).not('goal_id', 'is', null)));
    const rootIds = roots.filter((r) => !r.origin_subject_id).map((r) => r.id);
    const seen = new Set(roots.map((r) => r.id));
    const chunks = [];
    for (let i = 0; i < rootIds.length; i += 150) {
      // eslint-disable-next-line no-await-in-loop
      chunks.push(...withDate(unwrap(await supabase.from('study_subjects').select('*, schedules(for_date)').in('origin_subject_id', rootIds.slice(i, i + 150)))));
    }
    return [...roots, ...chunks.filter((c) => !seen.has(c.id))];
  }, { ttl: 15000 });
}
