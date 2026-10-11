// Weekly review I/O (V4-F). Reads only existing data; the only write is the
// student's reflection, stored in profiles.preferences.reviews (0017; a
// per-device copy without it).

import { supabase } from '../lib/supabaseClient.js';
import { app, emitChange } from '../app/context.js';
import { has } from '../shared/capabilities.js';
import { addDays, todayStr, minutesOfDay } from '../shared/dates.js';
import { loadPlannedRange } from '../workload/loadData.js';
import { listFocusSessions } from '../focus/focusHistory.js';
import { listCourses, listTaskRowsInWindow, listBlocksForSubjectIds } from '../academics/academicsData.js';
import { buildTaskGroups } from '../tasks/taskModel.js';
import { listExams } from '../exams/examsData.js';
import { listProjects, listMilestones } from '../projects/projectsData.js';
import { listGoals, listGoalMilestones, listGoalLogs } from '../goals/goalsData.js';
import { listRoutines, listRecentCompletions } from '../routines/routinesData.js';
import { loadForecastInput } from '../workload/workloadData.js';
import { buildWorkloadForecast } from '../workload/workloadModel.js';
import { normalizeReviews, withReview } from './reviewModel.js';

const LOCAL = 'student-scheduler-reviews:';

function readLocal(userId) {
  try { return normalizeReviews(JSON.parse(localStorage.getItem(LOCAL + userId))); } catch { return {}; }
}
function writeLocal(userId, value) {
  try { localStorage.setItem(LOCAL + userId, JSON.stringify(value)); } catch { /* per-device */ }
}

export async function loadReviews(userId) {
  if (!has('preferences')) return readLocal(userId);
  const { data, error } = await supabase.from('profiles').select('preferences').eq('id', userId).maybeSingle();
  if (error) return readLocal(userId);
  const value = normalizeReviews(data && data.preferences ? data.preferences.reviews : null);
  writeLocal(userId, value);
  return value;
}

export async function saveReview(userId, week, fields, { done = false } = {}) {
  const current = await loadReviews(userId);
  const next = withReview(current, week, fields, done ? new Date().toISOString() : null);
  writeLocal(userId, next);
  if (has('preferences')) {
    const { data } = await supabase.from('profiles').select('preferences').eq('id', userId).maybeSingle();
    const prefs = { ...((data && data.preferences) || {}), reviews: next };
    const { error } = await supabase.from('profiles').update({ preferences: prefs }).eq('id', userId);
    if (error) throw error;
  }
  emitChange('reviews');
  return next;
}

/** Everything the review of the week starting `start` needs. */
export async function loadReviewData(start) {
  const ctx = app();
  const today = todayStr();
  const end = addDays(start, 6);
  const isCurrent = start <= today && today <= end;
  const [range, sessions, courses, rows, exams, projects, projMs, goals, goalMs, logs, routines, completions, reviews, forecast] = await Promise.all([
    loadPlannedRange(ctx.userId, start, end),
    has('focusSessions') ? listFocusSessions(ctx.userId, { sinceIso: new Date(`${addDays(start, -1)}T00:00:00`).toISOString() }).catch(() => []) : [],
    has('courses') ? listCourses(ctx.userId).catch(() => []) : [],
    listTaskRowsInWindow(ctx.userId, addDays(start, -30), addDays(end, 30)).catch(() => []),
    has('exams') ? listExams(ctx.userId).catch(() => []) : [],
    has('projects') ? listProjects(ctx.userId).catch(() => []) : [],
    has('projects') ? listMilestones(ctx.userId).catch(() => []) : [],
    has('goals') ? listGoals(ctx.userId).catch(() => []) : [],
    has('goals') ? listGoalMilestones(ctx.userId).catch(() => []) : [],
    has('goals') ? listGoalLogs(ctx.userId).catch(() => []) : [],
    has('routines') ? listRoutines(ctx.userId).catch(() => []) : [],
    has('routines') ? listRecentCompletions(ctx.userId, today).catch(() => []) : [],
    loadReviews(ctx.userId).catch(() => ({})),
    isCurrent ? loadForecastInput(ctx.userId, addDays(end, 1), 7).catch(() => null) : null,
  ]);
  const blocks = await listBlocksForSubjectIds(rows.map((r) => r.id)).catch(() => []);
  const groups = buildTaskGroups(rows, blocks, { today, nowMinutes: minutesOfDay() });
  // Block → task's course / project, for "where did the time go".
  const rowById = new Map([...rows, ...range.subjects].map((r) => [r.id, r]));
  const rootOf = (id) => {
    const r = rowById.get(id);
    if (!r) return null;
    return r.origin_subject_id && rowById.get(r.origin_subject_id) ? rowById.get(r.origin_subject_id) : r;
  };
  return {
    today, start, end, isCurrent, range, sessions: sessions.filter((s) => s.started_at), courses, groups, exams, projects, projMs, goals, goalMs, logs, routines, completions, reviews,
    nextDays: forecast ? buildWorkloadForecast(forecast.input) : [],
    rootOf,
  };
}
