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

export async function createResource(userId, fields) {
  const row = unwrap(await supabase.from('resources').insert({ user_id: userId, ...fields }).select().single());
  invalidate('resources');
  emitChange('resources');
  return row;
}

export async function updateResource(id, fields) {
  unwrap(await supabase.from('resources').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', id));
  invalidate('resources');
  emitChange('resources');
}

export async function deleteResource(id) {
  unwrap(await supabase.from('resources').delete().eq('id', id));
  invalidate('resources');
  emitChange('resources');
}
