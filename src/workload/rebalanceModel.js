// Smart Rebalance (V3-F), pure and deterministic. Given an overloaded day,
// propose moving some of its study blocks to other days — and never touch
// anything that must stay put:
//   * classes, meals and other fixed events are never candidates
//   * locked (pinned) blocks, completed / partly-done blocks and missed
//     blocks stay where they are
//   * a block never moves past its task's due date, or into the past
// A move needs BOTH spare study capacity on the target day (its daily
// limit minus what's already there) AND a real free time slot that
// doesn't overlap classes, meals or other study (10-minute buffer).
// The result is only a PROPOSAL — nothing is written until the student
// reviews the preview and presses Apply.

import { addDays, diffDays, clockToMinutes } from '../shared/dates.js';

const BUFFER = 10;
const DEFAULT_WINDOW = { start: 7 * 60, end: 22 * 60 + 30 };

// Study window for a day from its schedule settings (or defaults).
export function dayWindow(schedule) {
  if (!schedule) return { ...DEFAULT_WINDOW };
  const wake = clockToMinutes(String(schedule.wake_time || '07:00')) ?? DEFAULT_WINDOW.start;
  let sleep = clockToMinutes(String(schedule.sleep_time || '22:30')) ?? DEFAULT_WINDOW.end;
  if (sleep <= wake) sleep += 1440;
  const earliest = schedule.earliest_study_time ? clockToMinutes(String(schedule.earliest_study_time)) : null;
  const latest = schedule.latest_study_time ? clockToMinutes(String(schedule.latest_study_time)) : null;
  const start = Math.max(wake, earliest ?? wake);
  // Blocks stay on their own calendar day: never schedule past midnight.
  const end = Math.min(sleep, latest !== null && latest > start ? latest : sleep, 1440);
  return { start, end: Math.max(start, end) };
}

// Meal intervals a day will have (from generated meal blocks, else from the
// day's meal settings, else the schema defaults).
export function mealIntervals(schedule, mealItems = []) {
  if (mealItems.length) return mealItems.map((m) => ({ start: m.start_minutes, end: m.end_minutes }));
  const s = schedule || { breakfast_on: true, breakfast_time: '08:00', lunch_on: true, lunch_time: '12:30', dinner_on: true, dinner_time: '19:00' };
  const out = [];
  [['breakfast', 30], ['lunch', 45], ['dinner', 45]].forEach(([meal, len]) => {
    if (!s[`${meal}_on`]) return;
    const start = clockToMinutes(String(s[`${meal}_time`] || ''));
    if (start !== null) out.push({ start, end: start + len });
  });
  return out;
}

export function freeSlots(window, busy, buffer = BUFFER) {
  const sorted = busy.filter((b) => b.end > window.start && b.start < window.end).sort((a, b) => a.start - b.start);
  const slots = [];
  let cursor = window.start;
  sorted.forEach((b) => {
    const until = b.start - buffer;
    if (until > cursor) slots.push({ start: cursor, end: until });
    cursor = Math.max(cursor, b.end + buffer);
  });
  if (window.end > cursor) slots.push({ start: cursor, end: window.end });
  return slots;
}

// Start time for a block of `duration` closest to `preferred`, or null.
export function findSlot(slots, duration, preferred) {
  let best = null;
  slots.forEach((s) => {
    if (s.end - s.start < duration) return;
    const start = Math.min(Math.max(preferred, s.start), s.end - duration);
    const rounded = Math.ceil(start / 5) * 5;
    const candidate = rounded + duration <= s.end ? rounded : start;
    const dist = Math.abs(candidate - preferred);
    if (!best || dist < best.dist) best = { start: candidate, dist };
  });
  return best ? best.start : null;
}

/**
 * @param {object} p
 * @param {string} p.date            the overloaded day
 * @param {string} p.today
 * @param {Array}  p.days            forecast days (workloadModel) covering candidate dates
 * @param {Object} p.contextByDate   { [date]: { window:{start,end}, busy:[{start,end}] } }
 * @param {Object} p.dueBySubject    { [subjectId]: 'YYYY-MM-DD' | null }
 * @param {number} [p.maxShiftDays=7] how far a block without a due date may move
 * @param {number} [p.targetReduction] minutes to remove (defaults to the day's overBy; for a blocked day, all study)
 */
export function proposeRebalance({ date, today, days, contextByDate, dueBySubject = {}, maxShiftDays = 7, targetReduction = null }) {
  const source = days.find((d) => d.date === date);
  if (!source) return { moves: [], remainingOver: 0, kept: [] };
  let need = targetReduction !== null ? targetReduction : source.overBy;
  const spare = new Map(days.map((d) => [d.date, d.spare]));
  const busy = new Map(Object.entries(contextByDate).map(([d, c]) => [d, c.busy.slice()]));
  const moves = [];
  const kept = [];

  const blocks = source.studyBlocks.map((b) => {
    let reason = null;
    if (b.completed) reason = 'completed';
    else if (b.completedMinutes > 0) reason = 'started';
    else if (b.missed) reason = 'missed';
    else if (b.locked) reason = 'locked';
    return { ...b, duration: b.end - b.start, due: b.sourceSubjectId ? dueBySubject[b.sourceSubjectId] ?? null : null, reason };
  });
  blocks.filter((b) => b.reason).forEach((b) => kept.push({ id: b.id, name: b.name, reason: b.reason }));

  const movable = blocks
    .filter((b) => !b.reason && b.duration > 0)
    // Most flexible first: latest (or no) due date, then the longest block.
    .sort((a, b) => (b.due || '9999-12-31').localeCompare(a.due || '9999-12-31') || b.duration - a.duration || String(a.id).localeCompare(String(b.id)));

  for (const b of movable) {
    if (need <= 0) break;
    const limit = b.due ? b.due : addDays(date, maxShiftDays);
    const candidates = days
      .filter((d) => d.date !== date && d.date >= today && d.date <= limit && !d.blocked)
      .filter((d) => (spare.get(d.date) || 0) >= b.duration)
      .map((d) => {
        const ctx = contextByDate[d.date];
        if (!ctx) return null;
        const start = findSlot(freeSlots(ctx.window, busy.get(d.date) || []), b.duration, b.start);
        return start === null ? null : { date: d.date, start, spare: spare.get(d.date), dist: Math.abs(diffDays(date, d.date)) };
      })
      .filter(Boolean)
      // Most room first, then nearest to the original day, then earlier.
      .sort((x, y) => y.spare - x.spare || x.dist - y.dist || x.date.localeCompare(y.date));
    const target = candidates[0];
    if (!target) {
      kept.push({ id: b.id, name: b.name, reason: b.due && b.due <= date ? 'due_soon' : 'no_room' });
      continue;
    }
    moves.push({ itemId: b.id, name: b.name, sourceSubjectId: b.sourceSubjectId, fromDate: date, fromStart: b.start, fromEnd: b.end, toDate: target.date, toStart: target.start, toEnd: target.start + b.duration, minutes: b.duration });
    spare.set(target.date, target.spare - b.duration);
    busy.get(target.date).push({ start: target.start, end: target.start + b.duration });
    need -= b.duration;
  }
  // Blocks never considered because the overload was already cleared.
  movable.filter((b) => !moves.some((m) => m.itemId === b.id) && !kept.some((k) => k.id === b.id)).forEach((b) => kept.push({ id: b.id, name: b.name, reason: 'not_needed' }));
  return { moves, remainingOver: Math.max(0, Math.round(need)), kept };
}
