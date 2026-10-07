// Shared reads for "how busy is each day" — used by the revision planner
// (V3-D), the workload forecast (V3-E), Smart Rebalance and What-if.
// Pure aggregation lives in workloadModel.js; this file only fetches.

import { supabase } from '../lib/supabaseClient.js';
import { cached } from '../app/store.js';
import { has } from '../shared/capabilities.js';
import { listSchedulesInWindow, listItemsForSchedules } from '../academics/academicsData.js';

export const DEFAULT_DAILY_MAX = 240;

// The student's daily study ceiling: saved V3 preference, else the most
// recent day's "Max daily study" Planner setting, else 4 hours.
export async function getDailyMaxStudyMinutes(userId) {
  return cached('prefs:dailyMax', async () => {
    if (has('preferences')) {
      const { data } = await supabase.from('profiles').select('preferences').eq('id', userId).maybeSingle();
      const pref = data && data.preferences && Number(data.preferences.maxDailyStudyMinutes);
      if (Number.isFinite(pref) && pref > 0) return pref;
    }
    const { data: recent } = await supabase
      .from('schedules')
      .select('max_daily_study_minutes')
      .eq('user_id', userId)
      .not('max_daily_study_minutes', 'is', null)
      .order('for_date', { ascending: false })
      .limit(1);
    const fromDay = recent && recent[0] ? Number(recent[0].max_daily_study_minutes) : NaN;
    return Number.isFinite(fromDay) && fromDay > 0 ? fromDay : DEFAULT_DAILY_MAX;
  }, { ttl: 60000 });
}

/**
 * Everything planned in [from, to]: schedules, their items, and the study
 * tasks placed on those days.
 */
export async function loadPlannedRange(userId, from, to) {
  const schedules = await listSchedulesInWindow(userId, from, to);
  const ids = schedules.map((s) => s.id);
  const [items, subjects] = await Promise.all([
    listItemsForSchedules(ids),
    ids.length ? fetchSubjectsForSchedules(ids) : Promise.resolve([]),
  ]);
  return { schedules, items, subjects };
}

async function fetchSubjectsForSchedules(ids) {
  return cached(`schedules:subjects:${ids.length}:${ids[0]}:${ids[ids.length - 1]}`, async () => {
    const out = [];
    for (let i = 0; i < ids.length; i += 150) {
      // eslint-disable-next-line no-await-in-loop
      const { data, error } = await supabase.from('study_subjects').select('*').in('schedule_id', ids.slice(i, i + 150));
      if (error) throw error;
      out.push(...(data || []));
    }
    return out;
  }, { ttl: 15000 });
}

// Study minutes already committed per date: the larger of the generated
// study blocks and the study tasks placed on that day (a day whose tasks
// haven't been generated into blocks yet still counts as busy).
export function studyLoadByDate({ schedules, items, subjects }) {
  const dateById = new Map(schedules.map((s) => [s.id, s.for_date]));
  const blocks = {};
  const asked = {};
  items.filter((i) => i.item_type === 'study').forEach((i) => {
    const d = dateById.get(i.schedule_id);
    if (d) blocks[d] = (blocks[d] || 0) + Math.max(0, i.end_minutes - i.start_minutes);
  });
  subjects.forEach((s) => {
    const d = dateById.get(s.schedule_id);
    if (d && !s.completed_at) asked[d] = (asked[d] || 0) + (Number(s.minutes_requested) || 0);
  });
  const out = {};
  new Set([...Object.keys(blocks), ...Object.keys(asked)]).forEach((d) => {
    out[d] = Math.max(blocks[d] || 0, asked[d] || 0);
  });
  return out;
}
