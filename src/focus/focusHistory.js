// Focus session history (V3-K, migration 0016). Recording is best-effort:
// the study block's completion is the source of truth and is saved first;
// if the history row can't be written the student still keeps their
// progress (the failure is logged, never shown as lost work).

import { supabase } from '../lib/supabaseClient.js';
import { has } from '../shared/capabilities.js';
import { cached, invalidate } from '../app/store.js';
import { emitChange } from '../app/context.js';

export { focusOutcome } from './focusOutcome.js';

export async function recordFocusSession(userId, { item, plannedMinutes, actualMinutes, outcome, notes, startedAt, endedAt }) {
  if (!has('focusSessions')) return null;
  // Under a minute of focus isn't a session worth keeping in history.
  if (!(actualMinutes >= 1)) return null;
  let taskId = item.sourceSubjectId || null;
  let courseId = null;
  if (taskId) {
    const { data } = await supabase.from('study_subjects').select('id, course_id, origin_subject_id').eq('id', taskId).maybeSingle();
    if (data) {
      courseId = data.course_id || null;
      if (!courseId && data.origin_subject_id) {
        const { data: root } = await supabase.from('study_subjects').select('course_id').eq('id', data.origin_subject_id).maybeSingle();
        courseId = root ? root.course_id || null : null;
      }
    } else taskId = null;
  }
  const row = {
    user_id: userId,
    schedule_item_id: item.id || null,
    task_id: taskId,
    course_id: has('courseLinks') ? courseId : null,
    started_at: new Date(startedAt).toISOString(),
    ended_at: new Date(endedAt).toISOString(),
    planned_minutes: Math.max(0, Math.min(1440, Math.round(plannedMinutes))),
    actual_minutes: Math.max(0, Math.min(1440, Math.round(actualMinutes))),
    outcome,
    notes: (notes || '').slice(0, 2000),
  };
  const { data, error } = await supabase.from('focus_sessions').insert(row).select().single();
  if (error) throw error;
  invalidate('focus');
  emitChange('focus');
  return data;
}

export function listFocusSessions(userId, { sinceIso = null } = {}) {
  if (!has('focusSessions')) return Promise.resolve([]);
  return cached(`focus:${sinceIso || 'all'}`, async () => {
    let q = supabase.from('focus_sessions').select('*').eq('user_id', userId);
    if (sinceIso) q = q.gte('started_at', sinceIso);
    const { data, error } = await q.order('started_at', { ascending: false }).limit(1000);
    if (error) throw error;
    return data || [];
  }, { ttl: 30000 });
}

// Estimate vs focused time for one task group (root + chunks).
export async function taskTimeSummary(userId, subjectId) {
  if (!has('focusSessions') || !subjectId) return null;
  const { data: row } = await supabase.from('study_subjects').select('id, origin_subject_id, minutes_requested').eq('id', subjectId).maybeSingle();
  if (!row) return null;
  const rootId = row.origin_subject_id || row.id;
  const { data: rows } = await supabase.from('study_subjects').select('id, minutes_requested').or(`id.eq.${rootId},origin_subject_id.eq.${rootId}`);
  const ids = (rows || []).map((r) => r.id);
  const { data: sessions } = ids.length ? await supabase.from('focus_sessions').select('actual_minutes').in('task_id', ids) : { data: [] };
  return {
    estimate: (rows || []).reduce((s, r) => s + (Number(r.minutes_requested) || 0), 0),
    focused: (sessions || []).reduce((s, r) => s + (Number(r.actual_minutes) || 0), 0),
    sessions: (sessions || []).length,
  };
}
