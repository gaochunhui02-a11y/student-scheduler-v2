// Orchestrates Phase 13 Smart Multi-Day Planning: combines the pure
// availability/allocation logic (scheduler.js's computeDayCapacity,
// multiDayPlanner.js's classify/allocate helpers) with the actual reads and
// writes a preview/accept cycle needs. No DOM here — dashboard.js drives the
// UI and calls buildMultiDayPreview / recomputeMultiDaySegments /
// acceptMultiDayPlan.
//
// The root study_subjects row (the one a student typed in originally) is
// NEVER deleted by this module — every sibling "chunk" row created by a
// plan points back to it via origin_subject_id, and study_subjects.
// minutes_requested has a `> 0` check, so accepting a plan only ever
// UPDATEs the root's own minutes (to whatever the student leaves in "keep
// on {rootDate}") and deletes/recreates its OPEN sibling chunks. A sibling
// becomes "frozen" — untouched by re-planning — the moment any schedule_item
// generated from it is locked or completed; only the still-open chunks are
// the "unfinished remaining minutes" a re-plan redistributes.

import {
  listGroupSubjectRows,
  listScheduleItemsBySourceSubjectIds,
  listClassesForScheduleIds,
  listSchedulesInRange,
  listScheduleItemsForScheduleIds,
  listStudySubjectsForScheduleIds,
  deleteStudySubjects,
  getOrCreateScheduleForDate,
  insertStudySubject,
  updateStudySubject,
} from './data.js';
import { computeDayCapacity } from './scheduler.js';
import { classifyGroupRows, buildCandidateDates, allocateAcrossDays } from './multiDayPlanner.js';

// Matches the `schedules` table's own column defaults (supabase/schema.sql)
// — used only for a date that has never been visited yet, so it has no
// schedule row of its own to read settings from.
const DEFAULT_DAY_SETTINGS = {
  wake_time: '07:00:00',
  sleep_time: '22:30:00',
  breakfast_on: true,
  breakfast_time: '08:00:00',
  lunch_on: true,
  lunch_time: '12:30:00',
  dinner_on: true,
  dinner_time: '19:00:00',
  session_cap_minutes: 60,
  stamina_break_minutes: 15,
  min_block_minutes: 30,
  earliest_study_time: null,
  latest_study_time: null,
};

function toHHMM(t) {
  return t ? String(t).slice(0, 5) : null;
}

function mealsInputFor(settings) {
  return [
    { name: 'Breakfast', duration: 30, on: settings.breakfast_on, time: toHHMM(settings.breakfast_time) },
    { name: 'Lunch', duration: 45, on: settings.lunch_on, time: toHHMM(settings.lunch_time) },
    { name: 'Dinner', duration: 45, on: settings.dinner_on, time: toHHMM(settings.dinner_time) },
  ];
}

// Date -> minutes of NEW study a date can still absorb: that date's own raw
// capacity (scheduler.js's computeDayCapacity, given its own classes/meals/
// study window/session settings — or the table defaults for a date never
// visited) minus its already-locked study minutes minus every OTHER (not
// this task's group) study subject's requested minutes that date — the same
// contention generateSchedule() itself resolves once the day is generated.
async function computeCapacityByDate(userId, dates, excludeSubjectIds) {
  if (dates.length === 0) return {};
  const startDate = dates[0];
  const endDate = dates[dates.length - 1];
  const schedules = await listSchedulesInRange(userId, startDate, endDate);
  const scheduleIds = schedules.map((s) => s.id);
  const [classes, items, subjects] = await Promise.all([
    listClassesForScheduleIds(scheduleIds),
    listScheduleItemsForScheduleIds(scheduleIds),
    listStudySubjectsForScheduleIds(scheduleIds),
  ]);
  const excludeSet = new Set(excludeSubjectIds);

  const capacityByDate = {};
  for (const date of dates) {
    const scheduleRow = schedules.find((s) => s.for_date === date) || null;
    const settings = scheduleRow || DEFAULT_DAY_SETTINGS;
    const classesForDate = scheduleRow
      ? classes.filter((c) => c.schedule_id === scheduleRow.id).map((c) => ({ name: c.name, start: toHHMM(c.start_time), end: toHHMM(c.end_time) }))
      : [];
    const lockedBlocks = scheduleRow
      ? items
          .filter((i) => i.schedule_id === scheduleRow.id && i.item_type === 'study' && i.locked)
          .map((i) => ({ name: i.name, start: i.start_minutes, end: i.end_minutes }))
      : [];
    const otherMinutes = scheduleRow
      ? subjects.filter((s) => s.schedule_id === scheduleRow.id && !excludeSet.has(s.id)).reduce((sum, s) => sum + s.minutes_requested, 0)
      : 0;

    const { capacityMinutes } = computeDayCapacity({
      wakeTime: toHHMM(settings.wake_time),
      sleepTime: toHHMM(settings.sleep_time),
      classes: classesForDate,
      meals: mealsInputFor(settings),
      prefs: {
        sessionCap: settings.session_cap_minutes,
        staminaBreak: settings.stamina_break_minutes,
        earliestStudyTime: toHHMM(settings.earliest_study_time),
        latestStudyTime: toHHMM(settings.latest_study_time),
      },
      lockedBlocks,
    });
    capacityByDate[date] = Math.max(0, capacityMinutes - otherMinutes);
  }
  return capacityByDate;
}

/**
 * Deterministic, read-only preview of how a study task's still-open minutes
 * could be spread from startDate to endDate (never past its due date).
 * Writes nothing. `subjectRow` is the study_subjects row the student
 * clicked "Plan Days" on — root or a previously-created chunk, both
 * resolve to the same group.
 */
export async function buildMultiDayPreview(userId, subjectRow, startDate, endDate) {
  const rootId = subjectRow.origin_subject_id || subjectRow.id;
  const groupRows = await listGroupSubjectRows(userId, rootId);
  const rootRow = groupRows.find((r) => r.id === rootId) || subjectRow;
  const siblings = groupRows.filter((r) => r.id !== rootId);
  const items = await listScheduleItemsBySourceSubjectIds(groupRows.map((r) => r.id));

  const { frozen, open } = classifyGroupRows(siblings, items);
  const openSiblingsMinutes = open.reduce((sum, r) => sum + r.minutes_requested, 0);
  const frozenDates = frozen.map((r) => r.for_date).filter(Boolean);

  const groupIds = groupRows.map((r) => r.id);
  const candidateDates = buildCandidateDates(startDate, endDate, rootRow.due_date, [rootRow.for_date, ...frozenDates]);
  const capacityByDate = await computeCapacityByDate(userId, candidateDates, groupIds);

  return {
    rootId,
    rootDate: rootRow.for_date,
    rootCurrentMinutes: rootRow.minutes_requested,
    name: rootRow.name,
    priority: rootRow.priority,
    dueDate: rootRow.due_date,
    notes: rootRow.notes,
    minBlockMinutes: 15,
    frozen: frozen.map((r) => ({ date: r.for_date, minutes: r.minutes_requested })),
    openSiblingIds: open.map((r) => r.id),
    planTotalMinutes: rootRow.minutes_requested + openSiblingsMinutes,
    candidateDates,
    capacityByDate,
  };
}

/**
 * Pure recompute the UI calls every time the student edits "keep on
 * {rootDate}" or the plan total in the preview panel — no fetch involved,
 * just re-runs the deterministic allocator over the already-fetched
 * capacity numbers from buildMultiDayPreview.
 */
export function recomputeMultiDaySegments(preview, keepOnRootDateMinutes, planTotalMinutes) {
  const remaining = Math.max(0, (planTotalMinutes || 0) - (keepOnRootDateMinutes || 0));
  return allocateAcrossDays({
    remainingMinutes: remaining,
    candidateDates: preview.candidateDates,
    capacityByDate: preview.capacityByDate,
    minBlockMinutes: preview.minBlockMinutes,
  });
}

/**
 * Applies an (optionally student-adjusted) preview: updates the root row's
 * own minutes, deletes the open sibling chunks being replaced, and inserts
 * fresh chunk rows for the accepted segments — creating that date's
 * schedule row first if it doesn't exist yet.
 */
export async function acceptMultiDayPlan(userId, preview, keepOnRootDateMinutes, segments) {
  if (keepOnRootDateMinutes !== preview.rootCurrentMinutes) {
    await updateStudySubject(preview.rootId, { minutes_requested: keepOnRootDateMinutes });
  }
  await deleteStudySubjects(preview.openSiblingIds);

  const created = [];
  for (const seg of (segments || []).filter((s) => s.minutes > 0)) {
    // eslint-disable-next-line no-await-in-loop
    const destSchedule = await getOrCreateScheduleForDate(userId, seg.date);
    // eslint-disable-next-line no-await-in-loop
    const row = await insertStudySubject(
      destSchedule.id,
      userId,
      {
        name: preview.name,
        minutes_requested: seg.minutes,
        priority: preview.priority,
        due_date: preview.dueDate,
        notes: preview.notes,
        origin_subject_id: preview.rootId,
      },
      0
    );
    created.push(row);
  }
  return created;
}
