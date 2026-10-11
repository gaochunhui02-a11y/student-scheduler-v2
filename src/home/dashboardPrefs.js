// Dashboard layout I/O (V4-D). Stored in profiles.preferences.dashboard
// (0017), merged with the other preference keys; a per-user localStorage
// copy renders the right widgets on first paint and is the only store on a
// database without 0017.

import { supabase } from '../lib/supabaseClient.js';
import { emitChange } from '../app/context.js';
import { has } from '../shared/capabilities.js';
import { normalizeDashboard } from './dashboardLayout.js';

const LOCAL = 'student-scheduler-dashboard:';

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

export function readLocalDashboard(userId) {
  try {
    return normalizeDashboard(JSON.parse(localStorage.getItem(LOCAL + userId)));
  } catch {
    return null;
  }
}

function writeLocal(userId, value) {
  try {
    if (value) localStorage.setItem(LOCAL + userId, JSON.stringify(value));
    else localStorage.removeItem(LOCAL + userId);
  } catch {
    // per-device cache only
  }
}

export async function loadDashboardLayout(userId) {
  if (!has('preferences')) return readLocalDashboard(userId);
  const { data, error } = await supabase.from('profiles').select('preferences').eq('id', userId).maybeSingle();
  if (error) return readLocalDashboard(userId);
  const value = normalizeDashboard(data && data.preferences ? data.preferences.dashboard : null);
  writeLocal(userId, value);
  return value;
}

/** Saves a layout (null = back to the mode's default). Other preference keys are untouched. */
export async function saveDashboardLayout(userId, layout) {
  const clean = normalizeDashboard(layout);
  writeLocal(userId, clean);
  if (has('preferences')) {
    const { data } = await supabase.from('profiles').select('preferences').eq('id', userId).maybeSingle();
    const prefs = { ...((data && data.preferences) || {}) };
    if (clean) prefs.dashboard = clean;
    else delete prefs.dashboard;
    unwrap(await supabase.from('profiles').update({ preferences: prefs }).eq('id', userId));
  }
  emitChange('dashboard');
  return clean;
}
