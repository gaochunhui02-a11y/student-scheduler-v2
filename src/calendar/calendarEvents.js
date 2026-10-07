// Calendar events for Month / Week / Agenda (V3-M), pure. One list built
// from the same tables everything else uses — never a second copy:
//   class     generated class blocks, or one-off classes + recurring class
//             occurrences on days not generated yet
//   external  classes imported from an .ics file (source = 'imported')
//   study     study blocks from the Planner (with locked / done / missed)
//   deadline  open (and finished) tasks on their due date, all-day
//   exam      exams, timed when a start time is known

import { dateRange, dayOfWeek, clockToMinutes } from '../shared/dates.js';

export const EVENT_KINDS = ['class', 'study', 'deadline', 'exam', 'external'];

function occurrence(series, date, exceptions) {
  if (date < series.start_date || date > series.end_date) return null;
  if (!(series.days_of_week || []).map(Number).includes(dayOfWeek(date))) return null;
  const ex = exceptions.find((e) => e.series_id === series.id && e.exception_date === date);
  if (ex && ex.action === 'skip') return null;
  const start = clockToMinutes(String((ex && ex.override_start_time) || series.start_time));
  const end = clockToMinutes(String((ex && ex.override_end_time) || series.end_time));
  if (start === null || end === null || end <= start) return null;
  return { name: (ex && ex.override_name) || series.name, start, end };
}

/**
 * @returns {Array<{id, date, kind, title, start?, end?, allDay, courseId, color, locked?, completed?, missed?, itemId?, taskId?, examId?, seriesId?, scheduleId?, sourceSubjectId?}>}
 */
export function buildCalendarEvents({ from, to, schedules = [], items = [], classes = [], series = [], exceptions = [], subjects = [], groups = [], exams = [], courses = [] }) {
  const dates = dateRange(from, to);
  const colorOf = new Map(courses.map((c) => [c.id, c.color]));
  const scheduleByDate = new Map(schedules.map((s) => [s.for_date, s]));
  const courseBySubject = new Map(subjects.map((s) => [s.id, s.course_id || null]));
  groups.forEach((g) => g.rowIds.forEach((id) => { if (!courseBySubject.get(id) && g.courseId) courseBySubject.set(id, g.courseId); }));
  const events = [];

  dates.forEach((date) => {
    const sched = scheduleByDate.get(date);
    const dayItems = sched ? items.filter((i) => i.schedule_id === sched.id) : [];
    const dayClasses = sched ? classes.filter((c) => c.schedule_id === sched.id) : [];
    const imported = new Set(dayClasses.filter((c) => c.source === 'imported').map((c) => `${c.name}|${clockToMinutes(String(c.start_time))}`));
    const classItems = dayItems.filter((i) => i.item_type === 'class');
    if (classItems.length) {
      classItems.forEach((i) => {
        const external = imported.has(`${i.name}|${i.start_minutes}`);
        const row = dayClasses.find((c) => c.name === i.name && clockToMinutes(String(c.start_time)) === i.start_minutes);
        // Generated class blocks carry no course; recover it from the one-off
        // class row, or from the recurring series of the same name that day.
        const viaSeries = !row ? series.find((se) => se.name === i.name && occurrence(se, date, exceptions)) : null;
        const courseId = row ? row.course_id || null : viaSeries ? viaSeries.course_id || null : null;
        events.push({ id: `item-${i.id}`, date, kind: external ? 'external' : 'class', title: i.name, start: i.start_minutes, end: i.end_minutes, allDay: false, courseId, color: colorOf.get(courseId) || null, itemId: i.id, scheduleId: sched.id });
      });
    } else {
      dayClasses.forEach((c) => {
        const start = clockToMinutes(String(c.start_time));
        const end = clockToMinutes(String(c.end_time));
        if (start === null || end === null || end <= start) return;
        const kind = c.source === 'imported' ? 'external' : 'class';
        events.push({ id: `class-${c.id}`, date, kind, title: c.name, start, end, allDay: false, courseId: c.course_id || null, color: colorOf.get(c.course_id) || null, scheduleId: sched.id });
      });
      series.forEach((s) => {
        const occ = occurrence(s, date, exceptions);
        if (occ) events.push({ id: `series-${s.id}-${date}`, date, kind: 'class', title: occ.name, start: occ.start, end: occ.end, allDay: false, courseId: s.course_id || null, color: colorOf.get(s.course_id) || null, seriesId: s.id });
      });
    }
    dayItems.filter((i) => i.item_type === 'study').forEach((i) => {
      const courseId = courseBySubject.get(i.source_subject_id) || null;
      events.push({
        id: `item-${i.id}`, date, kind: 'study', title: i.name, start: i.start_minutes, end: i.end_minutes, allDay: false, courseId, color: colorOf.get(courseId) || null,
        locked: Boolean(i.locked), completed: Boolean(i.completed), missed: Boolean(i.missed), itemId: i.id, scheduleId: sched.id, sourceSubjectId: i.source_subject_id || null,
      });
    });
  });

  groups.filter((g) => g.dueDate && g.dueDate >= from && g.dueDate <= to).forEach((g) => {
    events.push({ id: `task-${g.id}`, date: g.dueDate, kind: 'deadline', title: g.name, allDay: true, courseId: g.courseId, color: colorOf.get(g.courseId) || null, taskId: g.id, completed: g.done });
  });
  exams.filter((e) => e.exam_date >= from && e.exam_date <= to).forEach((e) => {
    const start = e.start_time ? clockToMinutes(String(e.start_time)) : null;
    events.push({
      id: `exam-${e.id}`, date: e.exam_date, kind: 'exam', title: e.name, allDay: start === null,
      start: start ?? undefined, end: start !== null ? start + (e.duration_minutes || 60) : undefined,
      courseId: e.course_id || null, color: colorOf.get(e.course_id) || null, examId: e.id,
    });
  });

  const kindOrder = { exam: 0, deadline: 1, class: 2, external: 3, study: 4 };
  return events.sort((a, b) => a.date.localeCompare(b.date) || Number(b.allDay) - Number(a.allDay) || (a.start ?? 0) - (b.start ?? 0) || kindOrder[a.kind] - kindOrder[b.kind] || String(a.title).localeCompare(String(b.title)));
}

export function filterEvents(events, enabledKinds) {
  const set = new Set(enabledKinds);
  return events.filter((e) => set.has(e.kind));
}

/**
 * Side-by-side columns for overlapping timed events in one day (so a
 * clash is visible instead of hidden). Adds {col, cols} to each event.
 */
export function layoutDay(events) {
  const timed = events.filter((e) => !e.allDay && Number.isFinite(e.start) && Number.isFinite(e.end)).sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => {
    const cols = [];
    cluster.forEach((ev) => {
      let col = cols.findIndex((end) => end <= ev.start);
      if (col === -1) { col = cols.length; cols.push(ev.end); } else cols[col] = ev.end;
      out.push({ ...ev, col });
    });
    const n = cols.length;
    out.slice(out.length - cluster.length).forEach((ev) => { ev.cols = n; });
    cluster = [];
  };
  timed.forEach((ev) => {
    if (cluster.length && ev.start >= clusterEnd) flush();
    cluster.push(ev);
    clusterEnd = Math.max(clusterEnd, ev.end);
  });
  if (cluster.length) flush();
  return out;
}

// Validates dropping a study block at [start, end) on `date` against the
// other timed events that day and the day's window. Returns null or a
// reason { key, params }.
export function validateDrop({ date, start, end, today, window, others = [], dueDate = null }) {
  if (date < today) return { key: 'calendar3.dropPast' };
  if (dueDate && date > dueDate) return { key: 'calendar3.dropPastDue', params: { date: dueDate } };
  if (end - start < 10) return { key: 'calendar3.dropTooShort' };
  if (window && (start < window.start || end > window.end)) return { key: 'calendar3.dropOutsideDay', params: { start: window.start, end: window.end } };
  const clash = others.find((o) => Number.isFinite(o.start) && start < o.end && end > o.start);
  if (clash) return { key: 'calendar3.dropOverlap', params: { name: clash.title || clash.name || '' } };
  return null;
}
