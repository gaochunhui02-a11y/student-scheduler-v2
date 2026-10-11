// Energy preferences I/O (V4-E): profiles.preferences.energy (0017), merged
// with the other preference keys. A per-user localStorage copy gives
// synchronous reads (peekEnergy) — used when a new day is created — and is
// the only store on a database without 0017.

import { supabase } from '../lib/supabaseClient.js';
import { cached, invalidate } from '../app/store.js';
import { emitChange, app } from '../app/context.js';
import { has } from '../shared/capabilities.js';
import { normalizeEnergy } from './energyModel.js';

const LOCAL = 'student-scheduler-energy:';

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

function writeLocal(userId, value) {
  try { localStorage.setItem(LOCAL + userId, JSON.stringify(value)); } catch { /* per-device cache */ }
}

/** Last known preferences, synchronously (defaults if never loaded). */
export function peekEnergy(userId = app().userId) {
  try {
    return normalizeEnergy(JSON.parse(localStorage.getItem(LOCAL + userId)));
  } catch {
    return normalizeEnergy(null);
  }
}

export function loadEnergy(userId) {
  if (!has('preferences')) return Promise.resolve(peekEnergy(userId));
  return cached('prefs:energy', async () => {
    const { data, error } = await supabase.from('profiles').select('preferences').eq('id', userId).maybeSingle();
    if (error) return peekEnergy(userId);
    const value = normalizeEnergy(data && data.preferences ? data.preferences.energy : null);
    writeLocal(userId, value);
    return value;
  }, { ttl: 60000 });
}

export async function saveEnergy(userId, energy) {
  const clean = normalizeEnergy(energy);
  writeLocal(userId, clean);
  if (has('preferences')) {
    const { data } = await supabase.from('profiles').select('preferences').eq('id', userId).maybeSingle();
    const prefs = { ...((data && data.preferences) || {}), energy: clean };
    unwrap(await supabase.from('profiles').update({ preferences: prefs }).eq('id', userId));
  }
  invalidate('prefs');
  emitChange('preferences');
  return clean;
}
