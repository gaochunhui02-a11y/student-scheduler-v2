// "Usual day" (V5-B): the wake/sleep times and daily study limit a NEW day
// starts with, so a plan made for next week uses the student's real day
// instead of the generic 07:00–22:30 defaults. Set by onboarding and by
// "Use these times for new days" in the Planner; never copied silently
// from whatever day was edited last. Stored in profiles.preferences.usualDay
// (0017) with a per-user local mirror for synchronous reads; the daily
// limit is also written to preferences.maxDailyStudyMinutes, which the
// workload forecast already reads.

import { supabase } from '../lib/supabaseClient.js';
import { has } from '../shared/capabilities.js';
import { invalidate } from '../app/store.js';
import { normalizeUsualDay } from './usualDayModel.js';

export { normalizeUsualDay };

const LOCAL = 'student-scheduler-usual-day:';
export function peekUsualDay(userId) {
  try {
    return normalizeUsualDay(JSON.parse(localStorage.getItem(LOCAL + userId)));
  } catch {
    return {};
  }
}

export async function loadUsualDay(userId) {
  const local = peekUsualDay(userId);
  if (!has('preferences')) return local;
  try {
    const { data } = await supabase.from('profiles').select('preferences').eq('id', userId).maybeSingle();
    const server = normalizeUsualDay(data && data.preferences ? data.preferences.usualDay : null);
    const merged = { ...local, ...server };
    try { localStorage.setItem(LOCAL + userId, JSON.stringify(merged)); } catch { /* mirror only */ }
    return merged;
  } catch {
    return local;
  }
}

export async function saveUsualDay(userId, values) {
  const clean = normalizeUsualDay(values);
  try { localStorage.setItem(LOCAL + userId, JSON.stringify(clean)); } catch { /* mirror only */ }
  if (has('preferences')) {
    const { data } = await supabase.from('profiles').select('preferences').eq('id', userId).maybeSingle();
    const prefs = { ...((data && data.preferences) || {}), usualDay: clean };
    if (clean.max_daily_study_minutes) prefs.maxDailyStudyMinutes = clean.max_daily_study_minutes;
    const { error } = await supabase.from('profiles').update({ preferences: prefs }).eq('id', userId);
    if (error) throw error;
  }
  invalidate('prefs');
  return clean;
}
