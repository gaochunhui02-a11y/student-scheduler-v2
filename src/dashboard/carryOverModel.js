// Pure logic for Phase 14 — Missed Task + Auto Carry Over. No DOM, no
// Supabase. Decides how much of an already-generated study block's planned
// time is still "remaining" (unfinished and not yet carried forward), and
// whether a block is even eligible for the Missed/Carry Over/Partial
// Completion actions. Feeding that remaining number into the Phase 13
// planner (buildCandidateDates / allocateAcrossDays / computeDayCapacity)
// happens in multiDayPlan.js's buildCarryOverPreview/acceptCarryOver — this
// file never schedules anything itself, it only does the arithmetic.

// A block's remaining (unfinished, not-yet-carried) minutes:
//   - 0 once `completed` is true, regardless of anything else — a fully
//     completed block is NEVER re-planned, full stop.
//   - otherwise, its planned duration minus whatever's already recorded as
//     completed minus whatever's already been carried forward before (so
//     re-running Carry Over after a prior partial success never re-carries
//     — i.e. duplicates — the same minutes twice).
//
// @param {{start:number, end:number, completed?:boolean, completedMinutes?:number, carriedOverMinutes?:number}} item
export function computeRemainingMinutes(item) {
  const duration = Math.max(0, (item?.end ?? 0) - (item?.start ?? 0));
  if (!item || item.completed) return 0;
  const completedMinutes = clamp(item.completedMinutes, duration);
  const carriedOverMinutes = clamp(item.carriedOverMinutes, duration - completedMinutes);
  return Math.max(0, duration - completedMinutes - carriedOverMinutes);
}

function clamp(value, max) {
  const n = Number.isFinite(value) ? value : 0;
  return Math.min(Math.max(0, n), Math.max(0, max));
}

// Reaching (or somehow exceeding) the block's full planned duration counts
// as fully done — same threshold the plain Done button itself represents —
// so logging a Partial Completion of e.g. 90/90 minutes flips `completed`
// to true exactly like clicking "Mark Done" would.
export function isFullyCompletedByMinutes(completedMinutes, duration) {
  return Number.isFinite(completedMinutes) && Number.isFinite(duration) && duration > 0 && completedMinutes >= duration;
}

// Validates a student-entered "completed minutes" value against the
// block's own planned duration before it's saved. Returns the value
// rounded to a whole minute so a stray "40.7" from a number input never
// hits the database.
export function validateCompletedMinutesInput(rawValue, duration) {
  const value = typeof rawValue === 'string' ? Number(rawValue) : rawValue;
  if (!Number.isFinite(value) || value < 0) return { ok: false, error: 'Enter 0 or more minutes.' };
  if (!Number.isFinite(duration) || duration <= 0) return { ok: false, error: 'Invalid block duration.' };
  if (value > duration) return { ok: false, error: `Completed minutes can't exceed the planned ${duration} minutes.` };
  return { ok: true, value: Math.round(value) };
}

// A locked block can never be silently touched by Missed/Carry Over — the
// student must unlock it first, the exact same rule manual Edit already
// follows (see scheduler.js's validateManualStudyEdit / dashboard.js's
// edit-btn gating). Nothing left to carry once the block has no remaining
// minutes either, and a block with no source_subject_id has no task to
// link a carried-forward chunk back to.
export function canCarryOverBlock(item) {
  return Boolean(item) && item.type === 'study' && !item.locked && Boolean(item.sourceSubjectId) && computeRemainingMinutes(item) > 0;
}

// Marking Missed is just a stricter Carry-Over-eligible check: also refuses
// a block that's already flagged missed (toggle it off instead).
export function canMarkMissed(item) {
  return canCarryOverBlock(item) && !item?.missed;
}
