// Tour progress I/O (V5-A): profiles.preferences.tours (0017), merged with
// the other preference keys, mirrored per user in localStorage so it is
// read synchronously and still works on a database without 0017 (or in the
// demo, where the in-memory client resets with the tab).

import { supabase } from '../lib/supabaseClient.js';
import { has } from '../shared/capabilities.js';
import { normalizeTourState } from './tourModel.js';

const LOCAL = 'student-scheduler-tours:';

function readLocal(userId) {
  try {
    return normalizeTourState(JSON.parse(localStorage.getItem(LOCAL + userId)));
  } catch {
    return normalizeTourState(null);
  }
}
function writeLocal(userId, value) {
  try { localStorage.setItem(LOCAL + userId, JSON.stringify(value)); } catch { /* per-device copy only */ }
}

let current = null;

/** Last known state, synchronously. */
export function peekTours(userId) {
  if (!current) current = readLocal(userId);
  return current;
}

/** Loads the saved state (server wins over this device when both exist). */
export async function loadTours(userId) {
  const local = readLocal(userId);
  current = local;
  if (!has('preferences')) return local;
  try {
    const { data, error } = await supabase.from('profiles').select('preferences').eq('id', userId).maybeSingle();
    if (error || !data || !data.preferences || !data.preferences.tours) return local;
    const server = normalizeTourState(data.preferences.tours);
    // Union: a guide finished on any device counts as finished.
    current = normalizeTourState({
      seen: { ...server.seen, ...local.seen },
      offered: { ...server.offered, ...local.offered },
      tips: server.tips && local.tips,
    });
    writeLocal(userId, current);
  } catch {
    /* keep the local copy */
  }
  return current;
}

export async function saveTours(userId, state) {
  current = normalizeTourState(state);
  writeLocal(userId, current);
  if (!has('preferences')) return current;
  try {
    const { data } = await supabase.from('profiles').select('preferences').eq('id', userId).maybeSingle();
    const prefs = { ...((data && data.preferences) || {}), tours: current };
    const { error } = await supabase.from('profiles').update({ preferences: prefs }).eq('id', userId);
    if (error) throw error;
  } catch (err) {
    // Never block the UI on this — the local copy already has it.
    console.warn('Could not save guide progress', err);
  }
  return current;
}
