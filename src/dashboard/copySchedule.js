// Pure logic for "Copy to another day" — decides exactly which fields get
// copied from a source schedule (+ its classes/study_subjects) onto a
// destination, and builds the exact rows to write. No Supabase, no DOM —
// data.js's copyScheduleToDate() calls this and then performs the actual
// reads/writes/deletes.
//
// Deliberately excluded from everything here: row ids (the destination
// always gets brand new ones), schedule_items (the generated schedule),
// locked, completed — none of those are planning inputs.

// Every "planning input" column on the schedules row — day settings, meals,
// and study preferences. Kept as an explicit list (rather than "copy
// everything except id/for_date/user_id/timestamps") so adding some future
// non-planning column to the table can't silently start getting copied too.
export const PLANNING_SCHEDULE_FIELDS = [
  'wake_time',
  'sleep_time',
  'breakfast_on',
  'breakfast_time',
  'lunch_on',
  'lunch_time',
  'dinner_on',
  'dinner_time',
  'session_cap_minutes',
  'stamina_break_minutes',
  'switch_break_minutes',
  'min_block_minutes',
  'preferred_study_period',
  'earliest_study_time',
  'latest_study_time',
];

export function extractPlanningFields(sourceSchedule) {
  const fields = {};
  for (const key of PLANNING_SCHEDULE_FIELDS) fields[key] = sourceSchedule[key];
  return fields;
}

// No `id` field on the output — these are meant to be INSERTed as brand new
// rows against the destination schedule_id, never reusing the source's ids.
export function buildCopiedClassRows(sourceClasses, destScheduleId, destUserId) {
  return (sourceClasses || []).map((c, i) => ({
    schedule_id: destScheduleId,
    user_id: destUserId,
    name: c.name,
    start_time: c.start_time,
    end_time: c.end_time,
    sort_order: i,
  }));
}

// due_date is passed through completely unchanged — copying to a different
// date never shifts a subject's deadline.
export function buildCopiedSubjectRows(sourceSubjects, destScheduleId, destUserId) {
  return (sourceSubjects || []).map((s, i) => ({
    schedule_id: destScheduleId,
    user_id: destUserId,
    name: s.name,
    minutes_requested: s.minutes_requested,
    priority: s.priority,
    due_date: s.due_date,
    notes: s.notes,
    sort_order: i,
  }));
}

// Returns a user-facing error message if the chosen destination is invalid,
// or null if it's fine to proceed. Kept separate from the DOM/event-handler
// code so the two edge cases the UI needs to reject are actually unit tested.
export function validateCopyDestination(sourceDateStr, destDateStr) {
  if (!destDateStr) return 'Choose a destination date first.';
  if (destDateStr === sourceDateStr) return 'Choose a date different from the one you are copying from.';
  return null;
}
