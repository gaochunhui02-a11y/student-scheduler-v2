// Routines + completions I/O (V4-C). Thin Supabase calls; rules live in
// routineModel.js. Scoped by user_id and protected by RLS (migration 0023).
// One completion per routine per day (unique index): ticking writes it,
// un-ticking deletes it.

import { supabase } from '../lib/supabaseClient.js';
import { cached, invalidate } from '../app/store.js';
import { emitChange } from '../app/context.js';
import { has } from '../shared/capabilities.js';
import { addDays } from '../shared/dates.js';
import { pausedDaysToSkip } from './routineModel.js';

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}
const nowIso = () => new Date().toISOString();

function changed() {
  invalidate('routines');
  emitChange('routines');
}

export function listRoutines(userId) {
  if (!has('routines')) return Promise.resolve([]);
  return cached('routines', async () => unwrap(await supabase.from('routines').select('*').eq('user_id', userId).order('sort_order', { ascending: true })));
}

export async function createRoutine(userId, fields) {
  const existing = await listRoutines(userId).catch(() => []);
  const row = unwrap(await supabase.from('routines').insert({ user_id: userId, sort_order: existing.length, ...fields }).select().single());
  changed();
  return row;
}

export async function updateRoutine(id, fields) {
  const row = unwrap(await supabase.from('routines').update({ ...fields, updated_at: nowIso() }).eq('id', id).select().single());
  changed();
  return row;
}

/** Deletes the routine and its whole completion history (confirmed in the app). */
export async function deleteRoutine(id) {
  unwrap(await supabase.from('routines').delete().eq('id', id));
  changed();
}

/** Completions from `since` (inclusive) on — enough for streaks and strips. */
export function listCompletions(userId, since) {
  if (!has('routines')) return Promise.resolve([]);
  return cached(`routines:completions:${since}`, async () => unwrap(await supabase.from('routine_completions').select('*').eq('user_id', userId).gte('completed_on', since).order('completed_on', { ascending: true })));
}

/** Completions for streaks: the last ~400 days. */
export function listRecentCompletions(userId, today) {
  return listCompletions(userId, addDays(today, -400));
}

/**
 * Sets a routine's state for a day: 'done', 'skipped' or null (clear).
 * Reads first so it works the same on Postgres and in Demo Mode (no upsert).
 */
export async function setCompletion(userId, routineId, date, status) {
  const existing = unwrap(await supabase.from('routine_completions').select('id, status').eq('user_id', userId).eq('routine_id', routineId).eq('completed_on', date));
  const row = existing && existing[0];
  if (!status) {
    if (row) unwrap(await supabase.from('routine_completions').delete().eq('id', row.id));
  } else if (row) {
    if (row.status !== status) unwrap(await supabase.from('routine_completions').update({ status }).eq('id', row.id));
  } else {
    unwrap(await supabase.from('routine_completions').insert({ user_id: userId, routine_id: routineId, completed_on: date, status }));
  }
  changed();
}

export async function pauseRoutine(routine, today) {
  return updateRoutine(routine.id, { paused: true, paused_at: today });
}

/** Resumes; the routine days missed while paused are recorded as skipped. */
export async function resumeRoutine(userId, routine, completions, today) {
  const days = pausedDaysToSkip(routine, completions, today);
  if (days.length) {
    unwrap(await supabase.from('routine_completions').insert(days.map((d) => ({ user_id: userId, routine_id: routine.id, completed_on: d, status: 'skipped' }))));
  }
  return updateRoutine(routine.id, { paused: false, paused_at: null });
}
