// Standalone focus timer (V4-I), pure. Works for any task (or none),
// independent of the Planner's study blocks. Time is computed from
// timestamps, never from counting ticks, so a sleeping tab or a throttled
// timer can't make it drift.
//
// state: { status: 'running'|'paused'|'done', plannedMinutes, startedAt,
//          pausedAt|null, pausedMs }

export const PRESETS = [15, 25, 50];
export const MAX_MINUTES = 180;

export function clampMinutes(n) {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.max(1, Math.min(MAX_MINUTES, v)) : 25;
}

export function startTimer(plannedMinutes, now) {
  return { status: 'running', plannedMinutes: clampMinutes(plannedMinutes), startedAt: now, pausedAt: null, pausedMs: 0 };
}

export function pauseTimer(s, now) {
  if (!s || s.status !== 'running') return s;
  return { ...s, status: 'paused', pausedAt: now };
}

export function resumeTimer(s, now) {
  if (!s || s.status !== 'paused') return s;
  return { ...s, status: 'running', pausedMs: s.pausedMs + (now - s.pausedAt), pausedAt: null };
}

/** Milliseconds actually focused so far (pauses excluded). */
export function focusedMs(s, now) {
  if (!s) return 0;
  const end = s.status === 'paused' ? s.pausedAt : now;
  return Math.max(0, end - s.startedAt - s.pausedMs);
}

/** Remaining ms (never negative) and whether the planned time is up. */
export function remaining(s, now) {
  const total = (s ? s.plannedMinutes : 0) * 60000;
  const left = Math.max(0, total - focusedMs(s, now));
  return { ms: left, done: Boolean(s) && left === 0 };
}

/** "24:59" (or "1:05:00" past an hour). */
export function formatClock(ms) {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

/**
 * Summary when the session ends: whole focused minutes and the outcome
 * used by focus history ('completed' | 'finished_early' | 'stopped').
 */
export function finishTimer(s, now, { early = false } = {}) {
  const minutes = Math.floor(focusedMs(s, now) / 60000);
  const { done } = remaining(s, now);
  let outcome = 'stopped';
  if (done) outcome = 'completed';
  else if (early) outcome = 'finished_early';
  return { minutes, outcome, plannedMinutes: s ? s.plannedMinutes : 0 };
}

/** Announce milestones to screen readers only at these remaining minutes. */
export function shouldAnnounce(prevMs, nextMs) {
  const marks = [10, 5, 1].map((m) => m * 60000);
  return marks.find((mark) => prevMs > mark && nextMs <= mark) || null;
}
