// Data access for course/task links (V3-N, migration 0015).

import { supabase } from '../lib/supabaseClient.js';
import { cached, invalidate } from '../app/store.js';
import { emitChange } from '../app/context.js';
import { has } from '../shared/capabilities.js';

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

export function listResources(userId) {
  if (!has('resources')) return Promise.resolve([]);
  return cached('resources', async () => unwrap(await supabase.from('resources').select('*').eq('user_id', userId).order('created_at', { ascending: true })));
}

// V4-H columns exist only with 0026; older databases keep V3 kinds.
const V4_COLUMNS = ['project_id', 'goal_id', 'exam_id', 'space_id', 'in_library', 'favorite', 'tags'];
const V3_KINDS = ['link', 'document', 'lecture', 'syllabus', 'reference'];
function resourceFields(fields) {
  const out = { ...fields };
  if (!has('resourcesV4')) {
    V4_COLUMNS.forEach((k) => delete out[k]);
    if (out.kind && !V3_KINDS.includes(out.kind)) out.kind = 'link';
  }
  return out;
}

export async function createResource(userId, fields) {
  const row = unwrap(await supabase.from('resources').insert({ user_id: userId, ...resourceFields(fields) }).select().single());
  invalidate('resources');
  emitChange('resources');
  return row;
}

export async function updateResource(id, fields) {
  unwrap(await supabase.from('resources').update({ ...resourceFields(fields), updated_at: new Date().toISOString() }).eq('id', id));
  invalidate('resources');
  emitChange('resources');
}

export async function deleteResource(id) {
  unwrap(await supabase.from('resources').delete().eq('id', id));
  invalidate('resources');
  emitChange('resources');
}
