// Assembles the inputs for the workload forecast / rebalance / what-if from
// existing tables (read-only), and applies an approved rebalance.

import { supabase } from '../lib/supabaseClient.js';
import { has } from '../shared/capabilities.js';
import { addDays } from '../shared/dates.js';
import { invalidate } from '../app/store.js';
import { emitChange, app } from '../app/context.js';
import { getOrCreateScheduleForDate, listClassesForScheduleIds } from '../dashboard/data.js';
import { listTaskRowsInWindow, listBlocksForSubjectIds, listAllClassSeries, listAllClassSeriesExceptions } from '../academics/academicsData.js';
import { listExams, listExamTopics } from '../exams/examsData.js';
import { topicRemainingMinutes } from '../exams/revisionPlanner.js';
import { buildTaskGroups } from '../tasks/taskModel.js';
import { capabilityFilter } from '../tasks/tasksData.js';
import { getDailyMaxStudyMinutes, loadPlannedRange } from './loadData.js';
import { dayWindow, mealIntervals, freeSlots, findSlot } from './rebalanceModel.js';
import { buildWorkloadForecast } from './workloadModel.js';
import { todayStr, dateRange } from '../shared/dates.js';
import { loadEnergy } from '../planner/energyData.js';
import { listRoutines, listRecentCompletions } from '../routines/routinesData.js';
import { routineMinutesOn } from '../routines/routineModel.js';

async function routineMinutesInRange(userId, today, end) {
  if (!has('routines')) return {};
  const [routines, completions] = await Promise.all([listRoutines(userId), listRecentCompletions(userId, today)]);
  const out = {};
  dateRange(today, end).forEach((d) => {
    const m = routineMinutesOn(routines, completions, d);
    if (m > 0) out[d] = m;
  });
  return out;
}

export async function loadForecastInput(userId, today, days) {
  const end = addDays(today, days - 1);
  // V4-E: energy preferences + routine time (never block the forecast).
  const [energy, routineMinutesByDate] = await Promise.all([
    loadEnergy(userId).catch(() => null),
    routineMinutesInRange(userId, today, end).catch(() => ({})),
  ]);
  const [dailyMax, range, series, exceptions, rows, exams, topics] = await Promise.all([
    getDailyMaxStudyMinutes(userId).catch(() => 240),
    loadPlannedRange(userId, today, end),
    listAllClassSeries(userId).catch(() => []),
    listAllClassSeriesExceptions(userId).catch(() => []),
    listTaskRowsInWindow(userId, addDays(today, -60), addDays(end, 60)).catch(() => []),
    has('exams') ? listExams(userId).catch(() => []) : [],
    has('exams') ? listExamTopics(userId).catch(() => []) : [],
  ]);
  const [classes, blocks] = await Promise.all([
    listClassesForScheduleIds(range.schedules.map((s) => s.id)).catch(() => []),
    listBlocksForSubjectIds(rows.map((r) => r.id)).catch(() => []),
  ]);
  const groups = buildTaskGroups(rows, blocks, { today });
  // Revision still needed per exam, minus what's already in the Planner.
  const coveredByTopic = {};
  rows.filter((r) => r.exam_topic_id).forEach((r) => {
    coveredByTopic[r.exam_topic_id] = (coveredByTopic[r.exam_topic_id] || 0) + (Number(r.minutes_requested) || 0);
  });
  const examPrepByExam = {};
  topics.forEach((tp) => {
    examPrepByExam[tp.exam_id] = (examPrepByExam[tp.exam_id] || 0) + topicRemainingMinutes(tp, coveredByTopic[tp.id] || 0);
  });
  const dueBySubject = Object.fromEntries(rows.map((r) => {
    const root = r.origin_subject_id ? rows.find((x) => x.id === r.origin_subject_id) : r;
    return [r.id, (root && root.due_date) || r.due_date || null];
  }));
  return {
    input: { today, days, dailyMax, schedules: range.schedules, items: range.items, subjects: range.subjects, classes, series, exceptions, groups, exams, examPrepByExam, energy, routineMinutesByDate },
    dueBySubject,
  };
}

// Window + busy intervals per forecast day, for Smart Rebalance.
export function buildContextByDate(forecastDays, input) {
  const scheduleByDate = new Map(input.schedules.map((s) => [s.for_date, s]));
  const out = {};
  forecastDays.forEach((d) => {
    const sched = scheduleByDate.get(d.date) || null;
    const meals = sched ? input.items.filter((i) => i.schedule_id === sched.id && i.item_type === 'meal') : [];
    out[d.date] = {
      window: dayWindow(sched),
      busy: [
        ...d.classes.map((c) => ({ start: c.start, end: c.end })),
        ...d.studyBlocks.map((b) => ({ start: b.start, end: b.end })),
        ...mealIntervals(sched, meals),
      ],
    };
  });
  return out;
}

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

/**
 * Applies approved moves one by one. Each move:
 *   1. re-reads the block and refuses if it changed since the preview
 *   2. moves the study task row to the target day — or, if the task has
 *      more time than this block, splits the block's minutes into a chunk
 *      on the target day (exactly like Multi-Day Planning does)
 *   3. moves the block, pinned (locked) so Regenerate keeps it there
 * If any step fails, every change already made is undone in reverse.
 */
export async function applyRebalanceMoves(userId, moves, { allowLocked = false } = {}) {
  const undo = [];
  const run = async (fn, inverse) => {
    await fn();
    if (inverse) undo.push(inverse);
  };
  try {
    for (const m of moves) {
      // eslint-disable-next-line no-await-in-loop
      const item = unwrap(await supabase.from('schedule_items').select('*, schedules(for_date)').eq('id', m.itemId).maybeSingle());
      if (!item || !item.schedules || item.schedules.for_date !== m.fromDate || item.start_minutes !== m.fromStart || item.end_minutes !== m.fromEnd || (item.locked && !allowLocked) || item.completed) {
        throw Object.assign(new Error('stale'), { code: 'stale' });
      }
      // eslint-disable-next-line no-await-in-loop
      const target = await getOrCreateScheduleForDate(userId, m.toDate);
      let newSourceId = item.source_subject_id;
      if (item.source_subject_id) {
        // eslint-disable-next-line no-await-in-loop
        const subject = unwrap(await supabase.from('study_subjects').select('*').eq('id', item.source_subject_id).maybeSingle());
        if (subject) {
          // eslint-disable-next-line no-await-in-loop
          const siblings = unwrap(await supabase.from('schedule_items').select('id').eq('source_subject_id', subject.id).eq('schedule_id', item.schedule_id).neq('id', item.id));
          const minutes = m.toEnd - m.toStart;
          if (siblings.length === 0 || subject.minutes_requested - minutes < 5) {
            const oldSchedule = subject.schedule_id;
            // eslint-disable-next-line no-await-in-loop
            await run(
              async () => unwrap(await supabase.from('study_subjects').update({ schedule_id: target.id }).eq('id', subject.id)),
              async () => supabase.from('study_subjects').update({ schedule_id: oldSchedule }).eq('id', subject.id),
            );
          } else {
            const before = subject.minutes_requested;
            // eslint-disable-next-line no-await-in-loop
            await run(
              async () => unwrap(await supabase.from('study_subjects').update({ minutes_requested: before - minutes }).eq('id', subject.id)),
              async () => supabase.from('study_subjects').update({ minutes_requested: before }).eq('id', subject.id),
            );
            // eslint-disable-next-line no-await-in-loop
            const chunk = unwrap(await supabase.from('study_subjects').insert(capabilityFilter({
              schedule_id: target.id, user_id: userId, sort_order: 0, name: subject.name, minutes_requested: minutes, priority: subject.priority,
              due_date: subject.due_date, notes: subject.notes || '', tags: subject.tags || [], course_id: subject.course_id || null,
              origin_subject_id: subject.origin_subject_id || subject.id,
            })).select().single());
            undo.push(async () => supabase.from('study_subjects').delete().eq('id', chunk.id));
            newSourceId = chunk.id;
          }
        }
      }
      const prev = { schedule_id: item.schedule_id, start_minutes: item.start_minutes, end_minutes: item.end_minutes, locked: item.locked, source_subject_id: item.source_subject_id };
      // eslint-disable-next-line no-await-in-loop
      await run(
        async () => unwrap(await supabase.from('schedule_items').update({ schedule_id: target.id, start_minutes: m.toStart, end_minutes: m.toEnd, locked: true, source_subject_id: newSourceId }).eq('id', item.id)),
        async () => supabase.from('schedule_items').update(prev).eq('id', item.id),
      );
    }
  } catch (err) {
    for (const inverse of undo.reverse()) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await inverse();
      } catch (rollbackErr) {
        console.error('Rollback step failed', rollbackErr);
      }
    }
    invalidate('tasks');
    invalidate('schedules');
    throw err;
  }
  invalidate('tasks');
  invalidate('schedules');
  emitChange('tasks');
  app().refreshPlanner();
  return moves.length;
}

// Applies the parts of a what-if scenario that map to real settings.
export async function applyScenarioChanges(userId, scenario, { today, horizonEnd }) {
  const done = [];
  if (scenario.dailyMax) {
    const cap = Math.round(Number(scenario.dailyMax));
    if (has('preferences')) {
      const { data } = await supabase.from('profiles').select('preferences').eq('id', userId).maybeSingle();
      unwrap(await supabase.from('profiles').update({ preferences: { ...((data && data.preferences) || {}), maxDailyStudyMinutes: cap } }).eq('id', userId));
    }
    // Days already planned in the window get the new limit too.
    unwrap(await supabase.from('schedules').update({ max_daily_study_minutes: cap }).eq('user_id', userId).gte('for_date', today).lte('for_date', horizonEnd));
    invalidate('prefs');
    done.push('dailyMax');
  }
  for (const x of scenario.taskExtra || []) {
    // eslint-disable-next-line no-await-in-loop
    const row = unwrap(await supabase.from('study_subjects').select('id, minutes_requested').eq('id', x.taskId).maybeSingle());
    if (row) {
      // eslint-disable-next-line no-await-in-loop
      unwrap(await supabase.from('study_subjects').update({ minutes_requested: Math.max(5, Math.min(1440, row.minutes_requested + Number(x.minutes))) }).eq('id', row.id));
      done.push('taskExtra');
    }
  }
  for (const x of scenario.examMoves || []) {
    // eslint-disable-next-line no-await-in-loop
    unwrap(await supabase.from('exams').update({ exam_date: x.newDate, updated_at: new Date().toISOString() }).eq('id', x.examId));
    invalidate('exams');
    done.push('examMove');
  }
  invalidate('tasks');
  invalidate('schedules');
  emitChange('tasks');
  emitChange('exams');
  app().refreshPlanner();
  return done;
}

/**
 * Plans moving one Planner block to another day (explicit student action):
 * same start time if that's free, else the nearest free slot that avoids
 * classes, meals and other study. Refuses past days and days after the
 * task's due date. Returns { move } or { error: 'past'|'same_day'|'past_due'|'no_slot', due? }.
 */
export async function planSingleMove(userId, item, fromDate, toDate) {
  const today = todayStr();
  if (toDate < today) return { error: 'past' };
  if (toDate === fromDate) return { error: 'same_day' };
  const { input, dueBySubject } = await loadForecastInput(userId, toDate, 1);
  const due = item.sourceSubjectId ? dueBySubject[item.sourceSubjectId] || null : null;
  if (due && toDate > due) return { error: 'past_due', due };
  const days = buildWorkloadForecast(input);
  const ctx = buildContextByDate(days, input)[toDate];
  const duration = item.end - item.start;
  const start = findSlot(freeSlots(ctx.window, ctx.busy), duration, item.start);
  if (start === null) return { error: 'no_slot' };
  return {
    move: { itemId: item.id, name: item.name, sourceSubjectId: item.sourceSubjectId || null, fromDate, fromStart: item.start, fromEnd: item.end, toDate, toStart: start, toEnd: start + duration, minutes: duration },
  };
}
