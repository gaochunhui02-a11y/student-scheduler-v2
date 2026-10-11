// Notes I/O (V4-H). Thin Supabase calls; rules in noteModel.js. Scoped by
// user_id and protected by RLS (migration 0025).

import { supabase } from '../lib/supabaseClient.js';
import { cached, invalidate } from '../app/store.js';
import { emitChange } from '../app/context.js';
import { has } from '../shared/capabilities.js';

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

function changed() {
  invalidate('notes');
  emitChange('notes');
}

export function listNotes(userId) {
  if (!has('notes')) return Promise.resolve([]);
  return cached('notes', async () => unwrap(await supabase.from('notes').select('*').eq('user_id', userId).order('updated_at', { ascending: false })));
}

export async function createNote(userId, fields) {
  const row = unwrap(await supabase.from('notes').insert({ user_id: userId, ...fields }).select().single());
  changed();
  return row;
}

/** Saves edits. `quiet` skips the change event (autosave while typing). */
export async function updateNote(id, fields, { quiet = false } = {}) {
  const row = unwrap(await supabase.from('notes').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', id).select().single());
  invalidate('notes');
  if (!quiet) emitChange('notes');
  return row;
}

export async function deleteNote(id) {
  unwrap(await supabase.from('notes').delete().eq('id', id));
  changed();
}
