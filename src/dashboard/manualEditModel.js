// Pure helpers for the Planner's manual block edit (V2 item 10). No DOM, no
// Supabase. The actual placement check (wake/sleep window, study window,
// overlaps) stays in scheduler.js's validateManualStudyEdit — this only
// validates the new duration and does the clock arithmetic for the
// "−15 / +15 min" nudge buttons, so the edit panel has no logic of its own.

export const MIN_BLOCK_DURATION = 5;
export const MAX_BLOCK_DURATION = 600;
export const NUDGE_MINUTES = 15;

// The new duration for a block, in whole minutes. It can't go below the
// minutes already logged on the block (that would make completed time
// larger than the block itself), nor outside 5–600.
// Returns { ok, value } or { ok:false, error, errorKey, errorParams }.
export function validateBlockDuration(rawValue, { completedMinutes = 0 } = {}) {
  const value = typeof rawValue === 'string' ? Number(rawValue.trim() || NaN) : rawValue;
  if (!Number.isFinite(value)) {
    return { ok: false, error: 'Enter a duration in minutes.', errorKey: 'manualEdit.errDuration' };
  }
  const minutes = Math.round(value);
  if (minutes < MIN_BLOCK_DURATION || minutes > MAX_BLOCK_DURATION) {
    return {
      ok: false,
      error: `Duration must be between ${MIN_BLOCK_DURATION} and ${MAX_BLOCK_DURATION} minutes.`,
      errorKey: 'manualEdit.errDurationRange',
      errorParams: { min: MIN_BLOCK_DURATION, max: MAX_BLOCK_DURATION },
    };
  }
  const logged = Number.isFinite(completedMinutes) ? Math.max(0, completedMinutes) : 0;
  if (minutes < logged) {
    return {
      ok: false,
      error: `This block already has ${logged} minutes logged — it can't be shorter than that.`,
      errorKey: 'manualEdit.errBelowLogged',
      errorParams: { minutes: logged },
    };
  }
  return { ok: true, value: minutes };
}

// "HH:MM" shifted by `delta` minutes, wrapping around midnight (the time
// input itself has no date; the edit save resolves it into the day).
// Returns null for an invalid input value.
export function nudgeClock(hhmm, delta) {
  if (typeof hhmm !== 'string' || !/^\d{2}:\d{2}$/.test(hhmm)) return null;
  const [h, m] = hhmm.split(':').map(Number);
  if (h > 23 || m > 59) return null;
  const total = ((h * 60 + m + delta) % 1440 + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
