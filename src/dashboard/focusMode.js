// Pure logic for Focus Mode (V2-C). No DOM, no Supabase, no timers.
//
// The countdown is computed from wall-clock timestamps, never by
// decrementing a counter on every tick: dashboard.js's setInterval only
// asks "what does the session look like at `now`?", so a tab the browser
// throttled or backgrounded for ten minutes shows the correct remaining
// time the instant it's visible again instead of having drifted.
//
// Focus Mode adds no new completion path. buildFocusCompletionWrite only
// computes the (completedMinutes, completed) pair; dashboard.js passes it
// straight to the existing setScheduleItemPartialCompletion — the same
// write the Planner's own Partial Completion panel makes — so a block
// finished in Focus Mode is indistinguishable from one logged by hand.

import { isFullyCompletedByMinutes } from './carryOverModel.js';

const MS_PER_MINUTE = 60000;

// A session timed against the block's still-unfinished minutes (so
// re-focusing a block already logged as 30/90 counts down from 60, not 90).
//
// @param {{itemId:string, plannedMinutes:number, baseCompletedMinutes?:number, now:number}} args
export function createFocusSession({ itemId, plannedMinutes, baseCompletedMinutes = 0, now }) {
  return {
    itemId,
    plannedMs: Math.max(0, Math.round(plannedMinutes)) * MS_PER_MINUTE,
    baseCompletedMinutes: Math.max(0, Math.round(baseCompletedMinutes) || 0),
    accumulatedMs: 0,
    runningSince: now,
  };
}

export function isPaused(session) {
  return session.runningSince === null;
}

// Elapsed focused time at `now`. A clock that jumped backwards (now earlier
// than runningSince) contributes 0 rather than a negative amount.
export function getElapsedMs(session, now) {
  const running = session.runningSince === null ? 0 : Math.max(0, now - session.runningSince);
  return session.accumulatedMs + running;
}

export function getRemainingMs(session, now) {
  return Math.max(0, session.plannedMs - getElapsedMs(session, now));
}

export function isTimeUp(session, now) {
  return session.plannedMs > 0 && getRemainingMs(session, now) === 0;
}

// Pausing an already-paused session (or resuming a running one) is a no-op
// so a double-click can never double-count or lose time.
export function pauseSession(session, now) {
  if (isPaused(session)) return session;
  return { ...session, accumulatedMs: getElapsedMs(session, now), runningSince: null };
}

export function resumeSession(session, now) {
  if (!isPaused(session)) return session;
  return { ...session, runningSince: now };
}

// Whole minutes focused in this session, capped at the session's own
// planned length — the timer stops at 0:00, so overtime spent on the
// focus screen isn't counted as study the block never had room for.
export function getFocusedMinutes(session, now) {
  const elapsed = Math.min(getElapsedMs(session, now), session.plannedMs);
  return Math.floor(elapsed / MS_PER_MINUTE);
}

// "32:18", or "1:02:05" once an hour or more remains. Rounds UP to the
// next second so the display never shows 0:00 while time is still left.
export function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// What to write when a focus session ends:
//   - 'complete': the student says the block is done. completed = true,
//     and completed_minutes records the time actually spent (prior logged
//     minutes + this session) so Insights can show Planned vs Actual. If
//     no measurable time was spent (opened and immediately completed),
//     the full duration is recorded — the same reading a plain Done gives.
//   - 'stop': finish early without completing. Saves the time spent as a
//     partial completion; reaching the full duration still flips
//     `completed`, exactly like the Partial Completion panel does.
//
// @param {{kind:'complete'|'stop', session:object, now:number, duration:number}} args
// @returns {{completedMinutes:number, completed:boolean}}
export function buildFocusCompletionWrite({ kind, session, now, duration }) {
  const safeDuration = Math.max(0, duration);
  const focused = getFocusedMinutes(session, now);
  const total = Math.min(session.baseCompletedMinutes + focused, safeDuration);
  if (kind === 'complete') {
    return { completedMinutes: total > 0 ? total : safeDuration, completed: true };
  }
  return { completedMinutes: total, completed: isFullyCompletedByMinutes(total, safeDuration) };
}

// "2 / 4 sessions" for the focus screen: today's study blocks done vs total.
//
// @param {Array<{type:string, completed?:boolean}>} items
export function computeTodaySessionProgress(items) {
  const study = (items || []).filter((i) => i && i.type === 'study');
  return { done: study.filter((i) => i.completed).length, total: study.length };
}

// Focus sessions survive a page reload via localStorage (a per-viewer
// convenience; nothing is lost if storage is unavailable — the block just
// isn't resumed). Anything malformed is rejected rather than half-trusted.
export function serializeSession(session) {
  return JSON.stringify(session);
}

export function parseStoredSession(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let s;
  try {
    s = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!s || typeof s !== 'object') return null;
  if (typeof s.itemId !== 'string' || !s.itemId) return null;
  if (!Number.isFinite(s.plannedMs) || s.plannedMs < 0) return null;
  if (!Number.isFinite(s.accumulatedMs) || s.accumulatedMs < 0) return null;
  if (!Number.isFinite(s.baseCompletedMinutes) || s.baseCompletedMinutes < 0) return null;
  if (s.runningSince !== null && !Number.isFinite(s.runningSince)) return null;
  return {
    itemId: s.itemId,
    plannedMs: s.plannedMs,
    baseCompletedMinutes: s.baseCompletedMinutes,
    accumulatedMs: s.accumulatedMs,
    runningSince: s.runningSince,
  };
}

// A block can be focused if it's a saved study block that isn't done and
// still has unfinished minutes. Locked blocks are excluded for the same
// reason the Partial Completion panel hides on them (see dashboard.js's
// Phase 14 note): a focus session's "stop" writes a partial completion,
// and a locked block is never touched by that path without an unlock.
export function canStartFocus(item) {
  if (!item || item.type !== 'study' || !item.id || item.completed || item.locked) return false;
  const duration = (item.end ?? 0) - (item.start ?? 0);
  const done = Number.isFinite(item.completedMinutes) ? item.completedMinutes : 0;
  return duration - done > 0;
}
