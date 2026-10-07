// Spaces + workspace preferences I/O (V4-A). Thin Supabase calls; the rules
// live in modules.js / spacesModel.js. Every query is scoped by user_id and
// protected by RLS (migration 0018).
//
// Workspace preferences live in profiles.preferences.workspace (0017). A
// per-user copy in localStorage lets the sidebar render the right modules on
// first paint; the server copy wins once loaded. Without 0017 the local copy
// is the only store (per device).

import { supabase } from '../lib/supabaseClient.js';
import { cached, invalidate } from '../app/store.js';
import { emitChange } from '../app/context.js';
import { has } from '../shared/capabilities.js';
import { normalizeWorkspace } from './modules.js';
import { NO_SPACE } from './spacesModel.js';

const LOCAL_WS = 'student-scheduler-workspace:';
const LOCAL_SPACE = 'student-scheduler-space:';

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

// ---------------- workspace preferences ----------------

export function readLocalWorkspace(userId) {
  try {
    return normalizeWorkspace(JSON.parse(localStorage.getItem(LOCAL_WS + userId)));
  } catch {
    return normalizeWorkspace(null);
  }
}

function writeLocalWorkspace(userId, ws) {
  try {
    localStorage.setItem(LOCAL_WS + userId, JSON.stringify(ws));
  } catch {
    // per-device cache only
  }
}

export async function loadWorkspace(userId) {
  if (!has('preferences')) return readLocalWorkspace(userId);
  const { data, error } = await supabase.from('profiles').select('preferences').eq('id', userId).maybeSingle();
  if (error) return readLocalWorkspace(userId);
  const ws = normalizeWorkspace(data && data.preferences ? data.preferences.workspace : null);
  writeLocalWorkspace(userId, ws);
  return ws;
}

/** Merges into profiles.preferences (other keys untouched). */
export async function saveWorkspace(userId, ws) {
  const clean = normalizeWorkspace(ws);
  writeLocalWorkspace(userId, clean);
  if (has('preferences')) {
    const { data } = await supabase.from('profiles').select('preferences').eq('id', userId).maybeSingle();
    const prefs = { ...((data && data.preferences) || {}), workspace: clean };
    unwrap(await supabase.from('profiles').update({ preferences: prefs }).eq('id', userId));
  }
  emitChange('workspace');
  return clean;
}

// ---------------- current space filter (per device) ----------------

export function readSpaceFilter(userId) {
  try {
    const v = localStorage.getItem(LOCAL_SPACE + userId);
    return v === NO_SPACE || /^[0-9a-f-]{36}$/i.test(v || '') ? v : null;
  } catch {
    return null;
  }
}

export function writeSpaceFilter(userId, value) {
  try {
    if (value) localStorage.setItem(LOCAL_SPACE + userId, value);
    else localStorage.removeItem(LOCAL_SPACE + userId);
  } catch {
    // per-device convenience
  }
}

// ---------------- spaces ----------------

export function listSpaces(userId) {
  if (!has('spaces')) return Promise.resolve([]);
  return cached('spaces', async () => unwrap(await supabase.from('spaces').select('*').eq('user_id', userId).order('sort_order', { ascending: true })));
}

function changed() {
  invalidate('spaces');
  emitChange('spaces');
}

export async function createSpace(userId, fields) {
  const existing = await listSpaces(userId).catch(() => []);
  const row = unwrap(await supabase.from('spaces').insert({ user_id: userId, sort_order: existing.length, ...fields }).select().single());
  changed();
  return row;
}

export async function updateSpace(id, fields) {
  const row = unwrap(await supabase.from('spaces').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', id).select().single());
  changed();
  return row;
}

/** Puts the given courses (ids) into a space. Only used for courses without one. */
export async function assignCoursesToSpace(courseIds, spaceId) {
  if (!courseIds.length) return 0;
  unwrap(await supabase.from('courses').update({ space_id: spaceId }).in('id', courseIds).is('space_id', null));
  invalidate('courses');
  emitChange('courses');
  return courseIds.length;
}
