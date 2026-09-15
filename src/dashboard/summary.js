// Pure derived-reporting helpers for a generated schedule — no DOM, no
// Supabase. Everything here is computed from the actual event timeline
// (plus the day bounds returned alongside it), never recomputed separately,
// so the numbers always match what's actually on the schedule.

function sumEventType(events, type) {
  return events.filter((e) => e.type === type).reduce((total, e) => total + (e.end - e.start), 0);
}

// Same identity rule scheduler.js uses: prefer the subject's database id when
// available, falling back to its name (e.g. for legacy blocks saved before
// source_subject_id existed, or a subject not yet persisted).
function subjectKey(id, name) {
  return id != null ? `id:${id}` : `name:${name}`;
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
 * it onto the timeline, and against how much of what's there is marked done.
 * Blocks are matched to a subject by sourceSubjectId when present, falling
 * back to name — same rule scheduler.js uses to attribute locked minutes.
 *
 * A subject counts as "completed" only when it has at least one scheduled
 * study block AND every one of its study blocks is completed — a subject
 * split across two blocks isn't done until both are.
 *
 * @param {{type:string,name:string,start:number,end:number,sourceSubjectId?:string|null,completed?:boolean}[]} events
 * @param {{id?:string|null, name:string, minutes:number}[]} subjects the original requested subjects
 */
export function computeSubjectProgress(events, subjects) {
  const byKey = new Map(); // key -> { scheduled, blockCount, completedBlockCount }
  events
    .filter((e) => e.type === 'study')
    .forEach((e) => {
      const key = subjectKey(e.sourceSubjectId, e.name);
      const entry = byKey.get(key) || { scheduled: 0, blockCount: 0, completedBlockCount: 0 };
      entry.scheduled += e.end - e.start;
      entry.blockCount += 1;
      if (e.completed) entry.completedBlockCount += 1;
      byKey.set(key, entry);
    });

  const list = (subjects || [])
    .filter((s) => s.name && s.minutes > 0)
    .map((s) => {
      const entry = byKey.get(subjectKey(s.id, s.name)) || { scheduled: 0, blockCount: 0, completedBlockCount: 0 };
      const completed = entry.blockCount > 0 && entry.completedBlockCount === entry.blockCount;
      return {
        name: s.name,
        requested: s.minutes,
        scheduled: entry.scheduled,
        unscheduled: Math.max(0, s.minutes - entry.scheduled),
        blockCount: entry.blockCount,
        completed,
      };
    });

  const requestedTotal = list.reduce((sum, s) => sum + s.requested, 0);
  const scheduledTotal = list.reduce((sum, s) => sum + s.scheduled, 0);
  const scheduledCount = list.filter((s) => s.unscheduled === 0).length;
  const completedCount = list.filter((s) => s.completed).length;
  const completionPercent = list.length > 0 ? Math.round((completedCount / list.length) * 100) : 0;

  return {
    subjects: list,
    requestedTotal,
    scheduledTotal,
    unscheduledTotal: Math.max(0, requestedTotal - scheduledTotal),
    // "fully scheduled" (Phase 4 meaning — did the requested time fit at all)
    scheduledCount,
    remainingCount: list.length - scheduledCount,
    // "done" (Phase 6 meaning — has the student finished studying it)
    completedCount,
    notCompletedCount: list.length - completedCount,
    completionPercent,
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
