// Planner integration for task dependencies (V3-H): before Generate /
// Regenerate, find which of the day's study tasks still wait on unfinished
// prerequisites so the scheduler can leave them out and say why. A task
// with "Schedule anyway" (dependency_override) is never held back.
// Any failure here falls back to "nothing blocked" — dependencies must
// never stop a student from generating their day.

import { supabase } from '../lib/supabaseClient.js';
import { has } from '../shared/capabilities.js';
import { todayStr } from '../shared/dates.js';
import { listDependencies } from './tasksData.js';
import { listBlocksForSubjectIds } from '../academics/academicsData.js';
import { buildTaskGroups } from './taskModel.js';
import { splitBlockedSubjects } from './dependencyModel.js';

async function rowsByIds(ids) {
  if (!ids.length) return [];
  const { data, error } = await supabase.from('study_subjects').select('*').in('id', ids);
  if (error) throw error;
  return data || [];
}

/**
 * @param {string} userId
 * @param {Array<{id:string, name:string}>} subjects Planner rows for the day
 * @returns {Promise<Array<{id, name, waitingOn:Array<{id,name}>}>>}
 */
export async function findBlockedSubjects(userId, subjects) {
  if (!has('dependencies')) return [];
  const ids = subjects.map((s) => s.id).filter(Boolean);
  if (!ids.length) return [];
  const deps = await listDependencies(userId);
  if (!deps.length) return [];
  const rows = await rowsByIds(ids);
  const rootIds = [...new Set(rows.map((r) => r.origin_subject_id || r.id))];
  const relevant = deps.filter((d) => rootIds.includes(d.task_id));
  if (!relevant.length) return [];
  const prereqIds = [...new Set(relevant.map((d) => d.depends_on_id))];
  // Roots (for override flags) + prerequisites + every chunk of a prerequisite.
  const roots = await rowsByIds(rootIds.filter((id) => !rows.some((r) => r.id === id)));
  const prereqRoots = await rowsByIds(prereqIds);
  const { data: prereqChunks, error } = await supabase.from('study_subjects').select('*').in('origin_subject_id', prereqIds);
  if (error) throw error;
  const all = new Map([...rows, ...roots, ...prereqRoots, ...(prereqChunks || [])].map((r) => [r.id, r]));
  const blocks = await listBlocksForSubjectIds([...all.keys()]);
  const groups = buildTaskGroups([...all.values()], blocks, { today: todayStr() });
  const withOrigin = subjects.map((s) => ({ ...s, origin_subject_id: (all.get(s.id) || {}).origin_subject_id || null }));
  const { skipped } = splitBlockedSubjects(withOrigin, groups, relevant);
  return skipped.map((x) => ({ id: x.subject.id, name: x.subject.name, waitingOn: x.waitingOn }));
}
