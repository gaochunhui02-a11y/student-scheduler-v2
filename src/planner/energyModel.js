// Energy & capacity preferences (V4-E), pure. Stored in
// profiles.preferences.energy (no migration):
//   peak          'none' | 'morning' | 'afternoon' | 'evening' — the default
//                 "preferred study time" for days the student hasn't set up
//                 yet, so new plans put study where they focus best
//   lightDays     weekdays (0 = Sunday … 6) with less study capacity
//   lightPercent  how much of the daily limit a light day has (25–100)
//   countRoutines whether routine minutes (with a duration) come out of the
//                 daily study limit — off by default: a gym hour doesn't
//                 lower how much someone can study, but some prefer it to
// Everything is clamped; unknown keys are dropped.

import { dayOfWeek } from '../shared/dates.js';

export const PEAKS = ['none', 'morning', 'afternoon', 'evening'];
export const DEFAULT_ENERGY = Object.freeze({ peak: 'none', lightDays: [], lightPercent: 60, countRoutines: false });

export function normalizeEnergy(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const lightDays = [...new Set((Array.isArray(src.lightDays) ? src.lightDays : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
  let pct = Math.round(Number(src.lightPercent));
  if (!Number.isFinite(pct)) pct = DEFAULT_ENERGY.lightPercent;
  return {
    peak: PEAKS.includes(src.peak) ? src.peak : 'none',
    lightDays,
    lightPercent: Math.max(25, Math.min(100, pct)),
    countRoutines: src.countRoutines === true,
  };
}

export function isLightDay(energy, date) {
  return Boolean(energy) && (energy.lightDays || []).includes(dayOfWeek(date));
}

/**
 * Study capacity for one day.
 * @param {number} base        the day's limit (its own setting or the daily max)
 * @param {object} energy      normalized energy preferences
 * @param {number} [routineMinutes] routine minutes planned that day
 */
export function adjustedCapacity(base, energy, date, routineMinutes = 0) {
  let cap = Math.max(0, Number(base) || 0);
  if (isLightDay(energy, date)) cap = Math.round((cap * energy.lightPercent) / 100);
  if (energy && energy.countRoutines) cap = Math.max(0, cap - Math.max(0, Math.round(routineMinutes || 0)));
  return cap;
}

/** Default preferred study period for a newly created day ('none' = leave the Planner default). */
export function defaultStudyPeriod(energy) {
  return energy && PEAKS.includes(energy.peak) ? energy.peak : 'none';
}
