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
 * @param {{name:string, minutes:number}[]} input.subjects
 * @param {{sessionCap:number, staminaBreak:number, switchBreak:number, minNewBlock:number}} input.prefs
 * @returns {{ events: {type:string,name:string,start:number,end:number}[], notes: string[], error?: string }}
 */
export function generateSchedule({ wakeTime, sleepTime, classes, meals, subjects, prefs }) {
  const notes = [];
  const { sessionCap, staminaBreak, switchBreak, minNewBlock } = prefs;

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

  const dayStart = timeToMinutes(wakeTime);
  let dayEnd = timeToMinutes(sleepTime);

  if (dayStart === null || dayEnd === null) {
    return { events: [], notes: [], error: 'Please set both a wake-up time and a sleep time.' };
  }
  if (dayEnd <= dayStart) dayEnd += 1440; // bedtime at/before wake time means "next day"
  if (dayEnd - dayStart < 60) {
    return {
      events: [],
      notes: [],
      error: 'Your sleep time must be later than your wake-up time, with at least an hour in between.',
    };
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
    .map((s) => ({ name: s.name, remaining: s.minutes }));

  if (subjectQueue.length === 0) {
    notes.push('No study subjects were entered — schedule shows only classes, meals, and free time.');
  }

  const studyEvents = [];
  const workingGaps = gaps.map((g) => ({ start: g.start, end: g.end, lastSubject: null }));

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

  // largest requests first, so a big subject claims a whole free block before it gets nibbled away
  const queue = subjectQueue.filter((s) => s.remaining > 0).sort((a, b) => b.remaining - a.remaining);

  for (const subject of queue) {
    while (subject.remaining > 0) {
      // 1) a single gap that fits the ENTIRE remaining amount, preferring the LARGEST such
      //    gap — favors big open stretches later in the day over small gaps before a class
      let target = null;
      let targetExtra = 0;
      for (const g of workingGaps) {
        const cap = g.end - g.start;
        if (cap <= 0) continue;
        const extra = g.lastSubject && g.lastSubject !== subject.name ? switchBreak : 0;
        const needed = spanNeeded(subject.remaining) + extra;
        if (cap >= needed && (!target || cap > target.end - target.start)) {
          target = g;
          targetExtra = extra;
        }
      }

      if (target) {
        placeInGap(target, subject, subject.remaining, targetExtra);
        continue;
      }

      // 2) nothing fits it whole — fall back to the LARGEST remaining gap so we create as few
      //    fragments as possible, and only if it's big enough to be worth studying in at all
      let best = null;
      let bestExtra = 0;
      for (const g of workingGaps) {
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
  return { events, notes };
}
