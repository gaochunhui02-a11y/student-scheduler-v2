// Pure, DOM-free, Supabase-free model for the Calendar agenda (V2-E): one
// list per day of everything on the calendar, each entry tagged with where
// it came from, plus the All / Classes / Study / External filter.
//
// Sources, each read exactly as the rest of the app already stores them:
//   - classes rows: source 'manual' (typed in the Planner) or 'imported'
//     (from an .ics file) — 'imported' rows are the "External" category
//   - recurring classes: never stored as rows; projected per date from
//     class_series + exceptions via recurringClasses.js, the same
//     projection the Planner uses
//   - study blocks: schedule_items with item_type 'study'. Class/meal/
//     break items are skipped — the classes rows above are the source of
//     truth for classes, so nothing is listed twice.

import { resolveOccurrenceForDate } from '../dashboard/recurringClasses.js';
import { timeToMinutes } from '../dashboard/scheduler.js';

export const AGENDA_FILTERS = ['all', 'classes', 'study', 'external'];

// Which filter category an entry belongs to.
export function agendaCategory(entry) {
  if (entry.kind === 'study') return 'study';
  if (entry.origin === 'imported') return 'external';
  return 'classes';
}

function clockToMinutes(value) {
  if (typeof value !== 'string' || !value) return null;
  const m = timeToMinutes(value.slice(0, 5));
  return Number.isFinite(m) ? m : null;
}

// @param {object} input
// @param {string[]} input.dates — the YYYY-MM-DD dates to build, in order
// @param {{id:string, for_date:string}[]} input.schedules
// @param {{schedule_id:string, name:string, start_time:string, end_time:string, source?:string}[]} input.classes
// @param {{schedule_id:string, item_type:string, name:string, start_minutes:number, end_minutes:number, completed?:boolean}[]} input.items
// @param {object[]} [input.seriesList]
// @param {object[]} [input.exceptions]
// @returns {{date:string, entries:object[]}[]} — entries sorted by start time
export function buildAgenda({ dates, schedules, classes, items, seriesList = [], exceptions = [] }) {
  const dateById = new Map((schedules || []).map((s) => [s.id, s.for_date]));
  const byDate = new Map((dates || []).map((d) => [d, []]));

  (classes || []).forEach((c) => {
    const list = byDate.get(dateById.get(c.schedule_id));
    if (!list) return;
    list.push({
      kind: 'class',
      origin: c.source === 'imported' ? 'imported' : 'manual',
      name: c.name || '',
      start: clockToMinutes(c.start_time),
      end: clockToMinutes(c.end_time),
    });
  });

  (seriesList || []).forEach((series) => {
    byDate.forEach((list, date) => {
      const occurrence = resolveOccurrenceForDate(series, date, exceptions);
      if (!occurrence) return;
      list.push({
        kind: 'class',
        origin: 'recurring',
        name: occurrence.name || '',
        start: clockToMinutes(occurrence.start_time),
        end: clockToMinutes(occurrence.end_time),
        modified: occurrence.isModified,
      });
    });
  });

  (items || []).forEach((i) => {
    if (i.item_type !== 'study') return;
    const list = byDate.get(dateById.get(i.schedule_id));
    if (!list) return;
    list.push({
      kind: 'study',
      origin: 'planner',
      name: i.name || '',
      start: Number.isFinite(i.start_minutes) ? i.start_minutes : null,
      end: Number.isFinite(i.end_minutes) ? i.end_minutes : null,
      completed: Boolean(i.completed),
    });
  });

  // Untimed entries (a class row with no time) sort last; ties keep a
  // stable classes-before-study order, then by name.
  const order = (e) => (e.start === null ? Infinity : e.start);
  return (dates || []).map((date) => ({
    date,
    entries: byDate.get(date).sort((a, b) => order(a) - order(b) || (a.kind === b.kind ? 0 : a.kind === 'class' ? -1 : 1) || a.name.localeCompare(b.name)),
  }));
}

// Keeps every day (so the agenda still shows the full week with "Nothing
// here" days) but only the entries matching `filter`.
export function filterAgenda(days, filter = 'all') {
  const f = AGENDA_FILTERS.includes(filter) ? filter : 'all';
  return (days || []).map((d) => ({
    date: d.date,
    entries: f === 'all' ? d.entries.slice() : d.entries.filter((e) => agendaCategory(e) === f),
  }));
}

// Totals for the filter chips ("Study 6").
export function countAgendaCategories(days) {
  const counts = { all: 0, classes: 0, study: 0, external: 0 };
  (days || []).forEach((d) => d.entries.forEach((e) => {
    counts.all += 1;
    counts[agendaCategory(e)] += 1;
  }));
  return counts;
}
