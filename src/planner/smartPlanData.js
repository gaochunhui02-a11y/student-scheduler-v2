// Applies a confirmed smart plan (V5-B). Only called after the student saw
// the preview and pressed Apply. Per task, in this order:
//   1. row operations from smartPlanModel.distributePieces —
//        'move'   an existing part gets its new day and its share of minutes
//        'insert' a new part on a day, linked to the task (origin_subject_id)
//   2. for carried-over work (catch-up): past blocks record their
//      carried_over_minutes and are marked missed; over-asking past parts are
//      trimmed to what they were blocked — same bookkeeping as V4 catch-up.
// No row is ever deleted and locked blocks are never touched. Each task is
// applied on its own; a failure is reported and doesn't undo the others.

import { supabase } from '../lib/supabaseClient.js';
import { getOrCreateScheduleForDate, incrementScheduleItemCarriedOver, setScheduleItemMissed } from '../dashboard/data.js';
import { capabilityFilter } from '../tasks/tasksData.js';
import { invalidateTasks } from '../academics/academicsData.js';
import { invalidate } from '../app/store.js';
import { emitChange, app } from '../app/context.js';
import { has } from '../shared/capabilities.js';
import { piecesFor, distributePieces } from './smartPlanModel.js';

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

async function applyOne(userId, proposal, scheduleFor) {
  const { item, parts } = proposal;
  const { group, portion } = item;
  const root = group.root;
  const plannedBy = has('unscheduledTasks') ? { planned_by: 'planner' } : {};
  const ops = distributePieces(piecesFor(item), parts);
  for (const op of ops) {
    // eslint-disable-next-line no-await-in-loop
    const schedule = await scheduleFor(op.date);
    if (op.op === 'move') {
      // eslint-disable-next-line no-await-in-loop
      unwrap(await supabase.from('study_subjects').update(capabilityFilter({ schedule_id: schedule.id, minutes_requested: Math.max(1, Math.min(1440, op.minutes)), ...plannedBy })).eq('id', op.rowId));
    } else {
      // eslint-disable-next-line no-await-in-loop
      unwrap(await supabase.from('study_subjects').insert(capabilityFilter({
        user_id: userId,
        schedule_id: schedule.id,
        name: root.name,
        minutes_requested: Math.max(1, Math.min(1440, op.minutes)),
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
    }
  }
  if (portion.kind === 'carry') {
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
 * @param {Array} proposals  from proposeSmartPlan (only the confirmed ones)
 * @returns {Promise<{ moved: number, failed: Array<{name}> }>}
 */
export async function applySmartPlan(userId, proposals) {
  let moved = 0;
  const failed = [];
  const schedules = new Map();
  const scheduleFor = async (date) => {
    if (!schedules.has(date)) schedules.set(date, await getOrCreateScheduleForDate(userId, date));
    return schedules.get(date);
  };
  for (const p of proposals) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await applyOne(userId, p, scheduleFor);
      moved += 1;
    } catch (err) {
      console.error('Smart plan failed for', p.item.group.name, err);
      failed.push({ name: p.item.group.name });
    }
  }
  invalidateTasks();
  invalidate('schedules');
  emitChange('tasks');
  app().refreshPlanner();
  return { moved, failed };
}
