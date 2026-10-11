// Applies a confirmed catch-up plan (V4-E). Only called after the student
// confirmed the preview. For each task, in this order:
//   1. parts without blocks move to the new day (planned_by = planner)
//   2. a carry-forward part is created on the new day for the remaining
//      minutes of past blocks + never-blocked minutes (origin = the task)
//   3. those past blocks record carried_over_minutes and are marked missed;
//      over-asking past parts are trimmed to what they were blocked
// Totals stay exact (see catchUpModel.js). Each task is applied on its own;
// one failure doesn't undo the tasks already moved, and it's reported.

import { supabase } from '../lib/supabaseClient.js';
import { getOrCreateScheduleForDate, incrementScheduleItemCarriedOver, setScheduleItemMissed } from '../dashboard/data.js';
import { capabilityFilter } from '../tasks/tasksData.js';
import { invalidateTasks } from '../academics/academicsData.js';
import { invalidate } from '../app/store.js';
import { emitChange, app } from '../app/context.js';
import { has } from '../shared/capabilities.js';

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

async function applyOne(userId, a) {
  const { portion, group, date } = a;
  const schedule = await getOrCreateScheduleForDate(userId, date);
  const plannedBy = has('unscheduledTasks') ? { planned_by: 'planner' } : {};
  if (portion.moveRowIds.length) {
    unwrap(await supabase.from('study_subjects').update(capabilityFilter({ schedule_id: schedule.id, ...plannedBy })).in('id', portion.moveRowIds));
  }
  if (portion.kind === 'carry' && portion.carryMinutes > 0) {
    const root = group.root;
    unwrap(await supabase.from('study_subjects').insert(capabilityFilter({
      user_id: userId,
      schedule_id: schedule.id,
      name: root.name,
      minutes_requested: Math.min(1440, portion.carryMinutes),
      priority: root.priority || 'medium',
      due_date: root.due_date || null,
      notes: '',
      tags: Array.isArray(root.tags) ? root.tags : [],
      origin_subject_id: root.id,
      sort_order: 0,
      course_id: root.course_id || null,
      space_id: root.space_id || null,
      project_id: root.project_id || null,
      project_milestone_id: root.project_milestone_id || null,
      goal_id: root.goal_id || null,
      ...plannedBy,
    })));
    for (const c of portion.blockCarries) {
      // eslint-disable-next-line no-await-in-loop
      await incrementScheduleItemCarriedOver(c.blockId, c.minutes);
      // eslint-disable-next-line no-await-in-loop
      await setScheduleItemMissed(c.blockId, true);
    }
    for (const tr of portion.rowTrims) {
      // eslint-disable-next-line no-await-in-loop
      unwrap(await supabase.from('study_subjects').update({ minutes_requested: Math.max(1, tr.minutes) }).eq('id', tr.rowId));
    }
  }
}

/**
 * @param {string} userId
 * @param {Array} assignments  from proposeCatchUp (only the confirmed ones)
 * @returns {Promise<{ moved: number, failed: Array<{name}> }>}
 */
export async function applyCatchUp(userId, assignments) {
  let moved = 0;
  const failed = [];
  for (const a of assignments) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await applyOne(userId, a);
      moved += 1;
    } catch (err) {
      console.error('Catch up failed for', a.name, err);
      failed.push({ name: a.name });
    }
  }
  invalidateTasks();
  invalidate('schedules');
  emitChange('tasks');
  app().refreshPlanner();
  return { moved, failed };
}
