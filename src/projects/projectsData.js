// Projects + milestones I/O (V4-B). Thin Supabase calls; rules live in
// projectModel.js. Every query is scoped by user_id and protected by RLS
// (migration 0019). Project tasks are ordinary study_subjects rows with a
// project_id — read here, written through tasks/tasksData.js.

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
  invalidate('projects');
  emitChange('projects');
}

// ---------------- projects ----------------

export function listProjects(userId) {
  if (!has('projects')) return Promise.resolve([]);
  return cached('projects', async () => unwrap(await supabase.from('projects').select('*').eq('user_id', userId).order('sort_order', { ascending: true })));
}

// V4-C: projects.goal_id exists only with 0022.
function projectFields(fields) {
  const out = { ...fields };
  if (!has('goalLinks')) delete out.goal_id;
  return out;
}

export async function createProject(userId, fields) {
  fields = projectFields(fields);
  const existing = await listProjects(userId).catch(() => []);
  const row = unwrap(await supabase.from('projects').insert({ user_id: userId, sort_order: existing.length, ...fields }).select().single());
  changed();
  return row;
}

export async function updateProject(id, fields) {
  fields = projectFields(fields);
  const patch = { ...fields, updated_at: nowIso() };
  if (fields.status === 'completed') patch.completed_at = nowIso();
  else if (fields.status) patch.completed_at = null;
  const row = unwrap(await supabase.from('projects').update(patch).eq('id', id).select().single());
  changed();
  return row;
}

/** Deletes the project and its milestones; its tasks stay (project_id -> null). */
export async function deleteProject(id) {
  unwrap(await supabase.from('projects').delete().eq('id', id));
  changed();
  invalidateTasks();
  emitChange('tasks');
}

// ---------------- milestones ----------------

export function listMilestones(userId) {
  if (!has('projects')) return Promise.resolve([]);
  return cached('projects:milestones', async () => unwrap(await supabase.from('project_milestones').select('*').eq('user_id', userId).order('sort_order', { ascending: true })));
}

export async function createMilestone(userId, projectId, fields) {
  const all = await listMilestones(userId).catch(() => []);
  const row = unwrap(await supabase.from('project_milestones').insert({ user_id: userId, project_id: projectId, sort_order: all.filter((m) => m.project_id === projectId).length, ...fields }).select().single());
  changed();
  return row;
}

export async function updateMilestone(id, fields) {
  const patch = { ...fields, updated_at: nowIso() };
  if (fields.status === 'done') patch.completed_at = nowIso();
  else if (fields.status === 'open') patch.completed_at = null;
  const row = unwrap(await supabase.from('project_milestones').update(patch).eq('id', id).select().single());
  changed();
  return row;
}

export async function deleteMilestone(id) {
  unwrap(await supabase.from('project_milestones').delete().eq('id', id));
  changed();
  invalidateTasks();
}

// ---------------- project tasks (study_subjects with a project_id) ----------------

/** Roots linked to any project plus every chunk split off them. */
export async function listProjectTaskRows(userId, projectId = null) {
  if (!has('projectLinks')) return [];
  return cached(`tasks:project:${projectId || 'all'}`, async () => {
    let q = supabase.from('study_subjects').select('*, schedules(for_date)').eq('user_id', userId);
    q = projectId ? q.eq('project_id', projectId) : q.not('project_id', 'is', null);
    const roots = withDate(unwrap(await q));
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

/** Saves new in-project order ([{ id, project_sort }]). */
export async function saveProjectTaskOrder(updates) {
  for (const u of updates) {
    // eslint-disable-next-line no-await-in-loop
    unwrap(await supabase.from('study_subjects').update({ project_sort: u.project_sort }).eq('id', u.id));
  }
  invalidateTasks();
  emitChange('tasks');
}
