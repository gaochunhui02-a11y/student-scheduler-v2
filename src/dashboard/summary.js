// Pure derived-reporting helpers for a generated schedule — no DOM, no
// Supabase. Everything here is computed from the actual event timeline
// (plus the day bounds returned alongside it), never recomputed separately,
// so the numbers always match what's actually on the schedule.

function sumEventType(events, type) {
  return events.filter((e) => e.type === type).reduce((total, e) => total + (e.end - e.start), 0);
}

/**
 * @param {{type:string,start:number,end:number}[]} events
 * @param {number} dayStart wake-up, in minutes since midnight
 * @param {number} dayEnd   bedtime, in minutes since midnight (may exceed 1440 for an overnight day)
 */
export function computeDailySummary(events, dayStart, dayEnd) {
  const awakeMinutes = dayEnd - dayStart;
  // a valid single-day plan is always awake somewhere between 1 minute and a
  // full 24 hours; outside that, sleep duration isn't meaningfully calculable
  const sleepMinutes = awakeMinutes > 0 && awakeMinutes < 1440 ? 1440 - awakeMinutes : null;
  return {
    classMinutes: sumEventType(events, 'class'),
    studyMinutes: sumEventType(events, 'study'),
    mealMinutes: sumEventType(events, 'meal'),
    breakMinutes: sumEventType(events, 'break'),
    freeMinutes: sumEventType(events, 'free'),
    awakeMinutes,
    sleepMinutes,
  };
}

/**
 * Compares each requested study subject against how much of it actually made
 * it onto the timeline, by name (the same key the scheduler itself uses to
 * group study blocks).
 * @param {{type:string,name:string,start:number,end:number}[]} events
 * @param {{name:string, minutes:number}[]} subjects the original requested subjects
 */
export function computeSubjectProgress(events, subjects) {
  const scheduledByName = new Map();
  events
    .filter((e) => e.type === 'study')
    .forEach((e) => scheduledByName.set(e.name, (scheduledByName.get(e.name) || 0) + (e.end - e.start)));

  const list = (subjects || [])
    .filter((s) => s.name && s.minutes > 0)
    .map((s) => {
      const scheduled = scheduledByName.get(s.name) || 0;
      return { name: s.name, requested: s.minutes, scheduled, unscheduled: Math.max(0, s.minutes - scheduled) };
    });

  const requestedTotal = list.reduce((sum, s) => sum + s.requested, 0);
  const scheduledTotal = list.reduce((sum, s) => sum + s.scheduled, 0);
  const scheduledCount = list.filter((s) => s.unscheduled === 0).length;

  return {
    subjects: list,
    requestedTotal,
    scheduledTotal,
    unscheduledTotal: Math.max(0, requestedTotal - scheduledTotal),
    scheduledCount,
    remainingCount: list.length - scheduledCount,
  };
}

export function formatDuration(minutes) {
  if (minutes === null || minutes === undefined) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
