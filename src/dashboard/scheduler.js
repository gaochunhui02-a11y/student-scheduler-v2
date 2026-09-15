// Pure scheduling logic — no DOM, no Supabase. Given the day's settings, classes,
// meals, and study subjects, returns the list of events that make up the plan.

export function timeToMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

export function minutesToClock(mins) {
  mins = ((mins % 1440) + 1440) % 1440;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const period = h < 12 ? 'AM' : 'PM';
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

export function formatClock(mins) {
  return mins >= 1440 ? `${minutesToClock(mins)} (next day)` : minutesToClock(mins);
}

const PRIORITY_RANK = { high: 3, medium: 2, low: 1 };

// Clock-time windows (minutes since midnight) used for the "preferred study
// time" soft preference. Not configurable — matches the Morning/Afternoon/
// Evening choices in the UI.
const PERIOD_RANGES = {
  morning: [6 * 60, 12 * 60],
  afternoon: [12 * 60, 17 * 60],
  evening: [17 * 60, 21 * 60],
};

// How many minutes of [start, end) fall inside the given preferred period,
// accounting for the period recurring once per calendar day even when the
// schedule itself spans past midnight. Returns 0 for 'none'/unknown periods.
function periodOverlapMinutes(period, start, end) {
  const range = PERIOD_RANGES[period];
  if (!range || end <= start) return 0;
  const [windowStart, windowEnd] = range;
  let total = 0;
  for (let base = Math.floor(start / 1440) * 1440; base < end; base += 1440) {
    const occStart = base + windowStart;
    const occEnd = base + windowEnd;
    total += Math.max(0, Math.min(end, occEnd) - Math.max(start, occStart));
  }
  return total;
}

// "Earliest study time" can't sensibly be earlier than wake-up, so it's just
// clamped — no next-day interpretation needed.
function resolveEarliestStudyTime(timeStr, dayStart) {
  const raw = timeToMinutes(timeStr);
  if (raw === null) return dayStart;
  return Math.max(dayStart, raw);
}

// "Latest study time" can be a small clock value like "00:30" meaning "after
// midnight" on an overnight day — only roll it to the next day when the day
// itself crosses midnight and the value looks earlier than wake-up.
function resolveLatestStudyTime(timeStr, dayStart, dayEnd) {
  const raw = timeToMinutes(timeStr);
  if (raw === null) return dayEnd;
  const abs = dayEnd > 1440 && raw < dayStart ? raw + 1440 : raw;
  return Math.min(dayEnd, abs);
}

// Splits each free gap at the earliest/latest study-time boundaries so the
// portions outside that window are excluded from study placement but still
// end up reported as free time (they're just gaps nothing ever gets placed
// in). When no window is configured this is a no-op — every gap comes back
// unchanged and fully eligible, so existing behavior is unaffected.
function splitGapsForStudyWindow(gaps, studyWindowStart, studyWindowEnd) {
  const segments = [];
  for (const g of gaps) {
    const ws = Math.max(g.start, studyWindowStart);
    const we = Math.min(g.end, studyWindowEnd);
    if (we > ws) {
      if (ws > g.start) segments.push({ start: g.start, end: ws, studyAllowed: false });
      segments.push({ start: ws, end: we, studyAllowed: true });
      if (we < g.end) segments.push({ start: we, end: g.end, studyAllowed: false });
    } else {
      segments.push({ start: g.start, end: g.end, studyAllowed: false });
    }
  }
  return segments;
}

// Resolves wake/sleep clock times into absolute wake-to-bedtime minute bounds,
// applying the "bedtime at/before wake time means next day" rule. Exported so
// callers that need the day's span without generating a full schedule (e.g.
// summary reporting for an already-generated/loaded schedule) don't have to
// duplicate this logic.
export function resolveDayBounds(wakeTime, sleepTime) {
  const dayStart = timeToMinutes(wakeTime);
  let dayEnd = timeToMinutes(sleepTime);
  if (dayStart === null || dayEnd === null) {
    return { error: 'Please set both a wake-up time and a sleep time.' };
  }
  if (dayEnd <= dayStart) dayEnd += 1440; // bedtime at/before wake time means "next day"
  if (dayEnd - dayStart < 60) {
    return { error: 'Your sleep time must be later than your wake-up time, with at least an hour in between.' };
  }
  return { dayStart, dayEnd };
}

// Places a fixed-length event as close to `desiredStart` as possible without
// overlapping anything already in `existingEvents`, or returns null if it
// can't fit before `dayEnd` at all.
function placeEvent(desiredStart, duration, existingEvents, dayStart, dayEnd) {
  let start = Math.max(desiredStart, dayStart);
  let end = start + duration;
  let moved = true;
  while (moved) {
    moved = false;
    for (const e of existingEvents) {
      if (start < e.end && end > e.start) {
        start = e.end;
        end = start + duration;
        moved = true;
      }
    }
  }
  if (end > dayEnd) return null;
  return { start, end };
}

/**
 * @param {object} input
 * @param {string} input.wakeTime  "HH:MM"
 * @param {string} input.sleepTime "HH:MM" — at/before wakeTime means "next day"
 * @param {{name:string, start:string, end:string}[]} input.classes
 * @param {{id:string, name:string, duration:number, on:boolean, time:string}[]} input.meals
 * @param {{name:string, minutes:number, priority?:'low'|'medium'|'high', dueDate?:string|null}[]} input.subjects
 * @param {{sessionCap:number, staminaBreak:number, switchBreak:number, minNewBlock:number, preferredPeriod?:'none'|'morning'|'afternoon'|'evening', earliestStudyTime?:string|null, latestStudyTime?:string|null}} input.prefs
 * @returns {{ events: {type:string,name:string,start:number,end:number}[], notes: string[], error?: string }}
 */
export function generateSchedule({ wakeTime, sleepTime, classes, meals, subjects, prefs }) {
  const notes = [];
  const {
    sessionCap,
    staminaBreak,
    switchBreak,
    minNewBlock,
    preferredPeriod = 'none',
    earliestStudyTime = null,
    latestStudyTime = null,
  } = prefs;

  function spanNeeded(minutes) {
    if (minutes <= sessionCap) return minutes;
    const sessions = Math.ceil(minutes / sessionCap);
    return minutes + (sessions - 1) * staminaBreak;
  }
  function maxStudyForCapacity(capacity) {
    let total = 0;
    let remaining = capacity;
    while (remaining > 0) {
      const session = Math.min(remaining, sessionCap);
      total += session;
      remaining -= session;
      if (remaining > 0) {
        remaining = remaining >= staminaBreak ? remaining - staminaBreak : 0;
      }
    }
    return total;
  }

  const bounds = resolveDayBounds(wakeTime, sleepTime);
  if (bounds.error) {
    return { events: [], notes: [], error: bounds.error };
  }
  const { dayStart, dayEnd } = bounds;

  // ----- earliest/latest study-time window (bounds STUDY placement only — classes,
  // meals, and free time still use the full wake-to-bedtime day) -----
  let studyWindowStart = resolveEarliestStudyTime(earliestStudyTime, dayStart);
  let studyWindowEnd = resolveLatestStudyTime(latestStudyTime, dayStart, dayEnd);
  if (studyWindowEnd <= studyWindowStart) {
    notes.push("Your earliest/latest study time settings don't leave any room to study — ignoring them for today.");
    studyWindowStart = dayStart;
    studyWindowEnd = dayEnd;
  }

  // ----- classes -----
  const classEvents = (classes || [])
    .map((c) => ({
      type: 'class',
      name: c.name,
      start: timeToMinutes(c.start),
      end: timeToMinutes(c.end),
    }))
    .filter((c) => c.name && c.start !== null && c.end !== null && c.end > c.start)
    .sort((a, b) => a.start - b.start);

  for (let i = 1; i < classEvents.length; i++) {
    if (classEvents[i].start < classEvents[i - 1].end) {
      notes.push(`Note: "${classEvents[i].name}" overlaps with "${classEvents[i - 1].name}" — double check your class times.`);
    }
  }

  // ----- meals -----
  const fixedEvents = [...classEvents];
  (meals || []).forEach((m) => {
    if (!m.on) return;
    const desired = timeToMinutes(m.time);
    if (desired === null) return;
    const placed = placeEvent(desired, m.duration, fixedEvents, dayStart, dayEnd);
    if (!placed) {
      notes.push(`Couldn't fit ${m.name} into your day — skipped it.`);
      return;
    }
    if (placed.start !== Math.max(desired, dayStart)) {
      notes.push(`${m.name} was shifted to ${minutesToClock(placed.start)} to avoid a conflict.`);
    }
    fixedEvents.push({ type: 'meal', name: m.name, start: placed.start, end: placed.end });
  });

  fixedEvents.sort((a, b) => a.start - b.start);

  // ----- free gaps between wake and sleep -----
  const gaps = [];
  let cursor = dayStart;
  fixedEvents.forEach((e) => {
    if (e.start > cursor) gaps.push({ start: cursor, end: e.start });
    cursor = Math.max(cursor, e.end);
  });
  if (cursor < dayEnd) gaps.push({ start: cursor, end: dayEnd });

  // ----- study subjects -----
  const subjectQueue = (subjects || [])
    .filter((s) => s.name && s.minutes > 0)
    .map((s) => ({
      name: s.name,
      remaining: s.minutes,
      priority: PRIORITY_RANK[s.priority] ? s.priority : 'medium',
      dueDate: s.dueDate || null,
    }));

  if (subjectQueue.length === 0) {
    notes.push('No study subjects were entered — schedule shows only classes, meals, and free time.');
  }

  const studyEvents = [];
  const workingGaps = splitGapsForStudyWindow(gaps, studyWindowStart, studyWindowEnd).map((g) => ({
    ...g,
    lastSubject: null,
  }));

  function placeInGap(gap, subject, amount, switchBreakLen) {
    if (switchBreakLen > 0) {
      studyEvents.push({ type: 'break', name: 'Break', start: gap.start, end: gap.start + switchBreakLen });
      gap.start += switchBreakLen;
    }
    let remaining = amount;
    while (remaining > 0) {
      const session = Math.min(remaining, sessionCap);
      studyEvents.push({ type: 'study', name: subject.name, start: gap.start, end: gap.start + session });
      gap.start += session;
      subject.remaining -= session;
      remaining -= session;
      if (remaining > 0) {
        studyEvents.push({ type: 'break', name: 'Break', start: gap.start, end: gap.start + staminaBreak });
        gap.start += staminaBreak;
      }
    }
    gap.lastSubject = subject.name;
  }

  // highest priority first, then earlier deadline first, then largest request first —
  // within the same priority/deadline tier a big subject still claims a whole free
  // block before it gets nibbled away by smaller ones
  const queue = subjectQueue.filter((s) => s.remaining > 0).sort((a, b) => {
    const priorityDiff = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
    if (priorityDiff !== 0) return priorityDiff;
    const aDue = a.dueDate ? Date.parse(a.dueDate) : Infinity;
    const bDue = b.dueDate ? Date.parse(b.dueDate) : Infinity;
    if (aDue !== bDue) return aDue - bDue;
    return b.remaining - a.remaining;
  });

  for (const subject of queue) {
    while (subject.remaining > 0) {
      // 1) a single gap that fits the ENTIRE remaining amount. Among those, prefer
      //    whichever overlaps the preferred study period the most (a soft preference —
      //    when there's no preference, or none of them overlap it, this collapses to
      //    the old behavior of just preferring the LARGEST such gap).
      let target = null;
      let targetExtra = 0;
      let targetScore = -1;
      let targetSize = -1;
      for (const g of workingGaps) {
        if (!g.studyAllowed) continue;
        const cap = g.end - g.start;
        if (cap <= 0) continue;
        const extra = g.lastSubject && g.lastSubject !== subject.name ? switchBreak : 0;
        const needed = spanNeeded(subject.remaining) + extra;
        if (cap < needed) continue;
        const score = periodOverlapMinutes(preferredPeriod, g.start + extra, g.start + extra + subject.remaining);
        if (!target || score > targetScore || (score === targetScore && cap > targetSize)) {
          target = g;
          targetExtra = extra;
          targetScore = score;
          targetSize = cap;
        }
      }

      if (target) {
        placeInGap(target, subject, subject.remaining, targetExtra);
        continue;
      }

      // 2) nothing fits it whole — fall back to the LARGEST remaining gap so we create as few
      //    fragments as possible, and only if it's big enough to be worth studying in at all.
      //    (Preferred period isn't applied here — minimizing fragments matters more than
      //    honoring a soft preference once we're already splitting a subject up.)
      let best = null;
      let bestExtra = 0;
      for (const g of workingGaps) {
        if (!g.studyAllowed) continue;
        const cap = g.end - g.start;
        if (cap <= 0) continue;
        const extra = g.lastSubject && g.lastSubject !== subject.name ? switchBreak : 0;
        const usable = cap - extra;
        if (usable < minNewBlock) continue;
        if (!best || usable > best.end - best.start - bestExtra) {
          best = g;
          bestExtra = extra;
        }
      }

      if (!best) break; // no block left worth starting a session in — reported as a shortfall below

      const usable = best.end - best.start - bestExtra;
      const chunk = Math.min(subject.remaining, maxStudyForCapacity(usable));
      placeInGap(best, subject, chunk, bestExtra);
    }
  }

  workingGaps.forEach((g) => {
    if (g.end - g.start > 0) {
      studyEvents.push({ type: 'free', name: 'Free time', start: g.start, end: g.end });
    }
  });

  const leftover = queue.filter((s) => s.remaining > 0);
  if (leftover.length > 0) {
    const list = leftover.map((s) => `${s.name} (${s.remaining} min short)`).join(', ');
    notes.push(`Not enough free time to fit everything. Couldn't schedule: ${list}.`);
  }

  const events = [...fixedEvents, ...studyEvents].sort((a, b) => a.start - b.start);
  return { events, notes, dayStart, dayEnd };
}
