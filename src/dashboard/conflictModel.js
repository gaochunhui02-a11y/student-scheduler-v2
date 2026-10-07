// Pure schedule-conflict detection for the Planner's "Schedule conflicts"
// panel (V2 item 11). No DOM, no Supabase, no i18n — each conflict is a
// { kind, key, params, action, itemId? } object the UI translates and
// renders with one clear action.
//
// Kinds (all from data the Planner already holds):
//   class_overlap      two classes overlap                 -> edit_classes
//   class_outside_day  a class falls outside wake..bedtime  -> edit_day
//   study_conflict     a saved study block overlaps a class
//                      or another study block (e.g. classes
//                      were edited after the plan was made) -> edit_block / regenerate
//   lock_conflict      a locked block blocked regeneration
//                      (scheduler.js lockConflictDetails)   -> unlock_block
//   insufficient_time  requested study doesn't fit          -> shortfall_details
//
// Times are minutes since midnight. dayEnd may exceed 1440 for an overnight
// day (scheduler.js convention); a class is inside the day if either its
// own time or its next-day time (+1440) fits.

function overlaps(a, b) {
  return a.start < b.end && a.end > b.start;
}

function insideDay(c, dayStart, dayEnd) {
  const fits = (s, e) => s >= dayStart && e <= dayEnd;
  return fits(c.start, c.end) || fits(c.start + 1440, c.end + 1440);
}

// @param {object} input
// @param {{name:string, start:number, end:number}[]} input.classes — the day's
//   effective classes (ad-hoc + recurring), minutes; rows without a full
//   valid time are ignored
// @param {{id?:string, type:string, name:string, start:number, end:number}[]} input.items —
//   the day's saved schedule blocks (camelCase in-memory shape)
// @param {number|null} input.dayStart
// @param {number|null} input.dayEnd
// @param {{key:string, params:object}[]} [input.lockConflictDetails]
// @param {{unscheduledTotal:number}|null} [input.shortfall]
// @param {(minutes:number) => string} input.formatRange — (start, end) => display text
export function detectScheduleConflicts({
  classes = [], items = [], dayStart = null, dayEnd = null, lockConflictDetails = [], shortfall = null, formatRange,
  // V3 (all optional): daily study cap, preferred study window, and the
  // day's tasks that are due by this date but couldn't be fully placed.
  dailyMaxMinutes = null, studyWindow = null, dueShortfalls = [], formatMinutes,
}) {
  const range = typeof formatRange === 'function' ? formatRange : (s, e) => `${s}–${e}`;
  const mins = typeof formatMinutes === 'function' ? formatMinutes : (n) => `${n} min`;
  const conflicts = [];
  const valid = (classes || [])
    .filter((c) => c && c.name && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
    .sort((a, b) => a.start - b.start);

  // Overlapping classes (each pair once).
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      if (!overlaps(valid[i], valid[j])) continue;
      const start = Math.max(valid[i].start, valid[j].start);
      const end = Math.min(valid[i].end, valid[j].end);
      conflicts.push({
        kind: 'class_overlap',
        key: 'conflicts.classOverlap',
        params: { a: valid[i].name, b: valid[j].name, range: range(start, end) },
        action: 'edit_classes',
      });
    }
  }

  // Classes outside the wake/sleep window.
  if (Number.isFinite(dayStart) && Number.isFinite(dayEnd)) {
    valid.forEach((c) => {
      if (insideDay(c, dayStart, dayEnd)) return;
      conflicts.push({
        kind: 'class_outside_day',
        key: 'conflicts.classOutsideDay',
        params: { name: c.name, range: range(c.start, c.end), day: range(dayStart, dayEnd) },
        action: 'edit_day',
      });
    });
  }

  // Saved study blocks that now overlap a class or another study block.
  const study = (items || []).filter((i) => i && i.type === 'study' && Number.isFinite(i.start) && Number.isFinite(i.end));
  const reported = new Set();
  study.forEach((s) => {
    const clash = valid.find((c) => overlaps(s, c) || overlaps(s, { start: c.start + 1440, end: c.end + 1440 }));
    if (clash) {
      conflicts.push({
        kind: 'study_conflict',
        key: 'conflicts.studyOverlapsClass',
        params: { name: s.name, range: range(s.start, s.end), other: clash.name },
        action: s.locked ? 'regenerate' : 'edit_block',
        itemId: s.id || null,
      });
      reported.add(s.id || s.name);
    }
  });
  for (let i = 0; i < study.length; i++) {
    for (let j = i + 1; j < study.length; j++) {
      if (!overlaps(study[i], study[j])) continue;
      const target = study[j].locked && !study[i].locked ? study[i] : study[j];
      conflicts.push({
        kind: 'study_conflict',
        key: 'conflicts.studyOverlapsStudy',
        params: { a: study[i].name, b: study[j].name, range: range(Math.max(study[i].start, study[j].start), Math.min(study[i].end, study[j].end)) },
        action: target.locked ? 'regenerate' : 'edit_block',
        itemId: target.id || null,
      });
    }
  }

  // Locked blocks that stopped regeneration.
  (lockConflictDetails || []).forEach((d) => {
    conflicts.push({ kind: 'lock_conflict', key: d.key || null, params: d.params || {}, error: d.error || null, action: 'unlock_block' });
  });

  // V3: study placed outside the student's preferred study hours.
  if (studyWindow && Number.isFinite(studyWindow.start) && Number.isFinite(studyWindow.end)) {
    study.forEach((s) => {
      if (s.start >= studyWindow.start && s.end <= studyWindow.end) return;
      conflicts.push({
        kind: 'outside_preferred',
        key: 'conflicts.outsidePreferred',
        params: { name: s.name, range: range(s.start, s.end), window: range(studyWindow.start, studyWindow.end) },
        action: s.locked ? 'edit_prefs' : 'edit_block',
        itemId: s.id || null,
      });
    });
  }

  // V3: more study planned than the day's maximum.
  if (Number.isFinite(dailyMaxMinutes) && dailyMaxMinutes > 0) {
    const total = study.reduce((sum, s) => sum + (s.end - s.start), 0);
    if (total > dailyMaxMinutes) {
      conflicts.push({
        kind: 'daily_max',
        key: 'conflicts.dailyMax',
        params: { total: mins(total), max: mins(dailyMaxMinutes), over: mins(total - dailyMaxMinutes) },
        action: 'edit_prefs',
      });
    }
  }

  // V3: a task due by today that couldn't be fully placed — say exactly
  // how much time existed instead of a generic error.
  (dueShortfalls || []).forEach((d) => {
    if (!d || !(d.unscheduled > 0)) return;
    conflicts.push({
      kind: 'impossible_deadline',
      key: d.scheduled > 0 ? 'conflicts.deadlinePartly' : 'conflicts.deadlineNone',
      params: { name: d.name, available: mins(d.scheduled || 0), short: mins(d.unscheduled) },
      action: 'shortfall_details',
    });
  });

  // Not enough time.
  if (shortfall && shortfall.unscheduledTotal > 0) {
    conflicts.push({
      kind: 'insufficient_time',
      key: 'conflicts.insufficientTime',
      params: { minutes: shortfall.unscheduledTotal },
      action: 'shortfall_details',
    });
  }

  return conflicts;
}

// Classes as the Planner shows them (HH:MM strings) -> minutes.
export function classesToMinutes(rows, timeToMinutes) {
  return (rows || []).map((r) => ({ name: (r.name || '').trim(), start: timeToMinutes(r.start || ''), end: timeToMinutes(r.end || '') }));
}
