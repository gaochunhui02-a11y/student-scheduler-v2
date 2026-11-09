// Import rows from CSV / .ics, duplicate detection, and the "ready to save"
// rules (V5-C), pure.
//
// Every source (pasted syllabus, CSV, .ics) produces the same row shape:
//   { id, kind, title, date, time, minutes, flags[], include, source, lineNo }
// `flags` lists what the student must confirm: 'order' (3/4 — March 4 or
// 3 April?), 'year', 'multiDate', 'title', 'kind', 'date'. A row with open
// flags can't be imported until the student edits that field or presses
// "Looks right" — nothing ambiguous is saved on a guess.

import { findDateMentions, resolveDate, findTime, isRealDate } from './importDates.js';
import { classify, DEFAULT_MINUTES, ITEM_KINDS } from './syllabusParser.js';

export const MAX_CSV_ROWS = 1000;

// ---------------- CSV ----------------

/** RFC 4180-ish: quoted fields, "" escapes, CRLF/LF, delimiter , ; or tab (auto). */
export function parseCsv(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const firstLine = s.split(/\r?\n/, 1)[0] || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQ = false;
  for (const ch of firstLine) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch in counts) counts[ch] += 1;
  }
  const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0 ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      if (rows.length > MAX_CSV_ROWS) break;
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((c) => c.trim() !== '')) rows.push(row);
  }
  return { delimiter: delim, header: rows[0] || [], rows: rows.slice(1, MAX_CSV_ROWS + 1) };
}

const HEADER_HINTS = {
  title: /^(title|name|assignment|task|item|activity|event|description|topic|作业|任务|名称|标题|タイトル|課題|項目)$/i,
  date: /^(due|due ?date|date|deadline|due_date|day|when|截止(日期)?|日期|期限|締め?切り?|日付)$/i,
  time: /^(time|due ?time|start ?time|start|时间|時間|時刻)$/i,
  kind: /^(type|category|kind|类型|類型|種類|区分)$/i,
  course: /^(course|class|subject|course ?code|module|课程|科目|授業)$/i,
  minutes: /^(estimate|est\.?|minutes|mins?|duration|time needed|hours|est\.? hours|workload|预计|预计时间|所要|所要時間)$/i,
  notes: /^(notes?|details|comments?|备注|メモ|備考)$/i,
};

/** Best guess of which column holds what (the UI lets the student change it). */
export function guessColumns(header) {
  const out = {};
  header.forEach((h, i) => {
    const name = String(h || '').trim();
    Object.entries(HEADER_HINTS).forEach(([field, re]) => {
      if (out[field] === undefined && re.test(name)) out[field] = i;
    });
  });
  return out;
}

const KIND_ALIASES = { exam: 'exam', test: 'exam', midterm: 'exam', final: 'exam', quiz: 'quiz', project: 'project', reading: 'reading', read: 'reading', assignment: 'assignment', homework: 'assignment', hw: 'assignment', essay: 'assignment', paper: 'assignment', lab: 'assignment' };

/**
 * CSV rows → import rows.
 * @param {{ header, rows }} csv
 * @param {object} columns  { title, date, time?, kind?, course?, minutes?, notes? } column indexes
 */
export function rowsFromCsv(csv, columns, ctx) {
  const out = [];
  csv.rows.forEach((cells, i) => {
    const cell = (k) => (columns[k] === undefined || columns[k] === null || columns[k] === '' ? '' : String(cells[Number(columns[k])] ?? '').trim());
    const title = cell('title').slice(0, 120);
    const dateText = cell('date');
    if (!title && !dateText) return;
    const flags = [];
    let date = null;
    const mentions = findDateMentions(dateText);
    if (mentions.length) {
      const r = resolveDate(mentions[0], ctx);
      date = r.date;
      flags.push(...r.flags);
      if (mentions.length > 1) flags.push('multiDate');
    }
    if (!date) flags.push('date');
    const kindText = cell('kind').toLowerCase();
    let kind = KIND_ALIASES[kindText] || (kindText ? classify(kindText) : classify(title));
    if (!ITEM_KINDS.includes(kind)) kind = 'other';
    if (kind === 'other') flags.push('kind');
    if (!title) flags.push('title');
    const minutesRaw = cell('minutes');
    const isHours = columns.minutes !== undefined && /hour|時間|小时/i.test(String(csv.header[Number(columns.minutes)] || ''));
    const num = Number(String(minutesRaw).replace(',', '.').replace(/[^\d.]/g, ''));
    const minutes = minutesRaw && Number.isFinite(num) && num > 0 ? Math.round(isHours ? num * 60 : num) : DEFAULT_MINUTES[kind] || 0;
    out.push({
      id: `c${i + 1}`,
      kind,
      title,
      date,
      time: findTime(cell('time')) || findTime(dateText),
      minutes: Math.min(1440, minutes),
      course: cell('course') || null,
      notes: cell('notes').slice(0, 2000),
      flags,
      include: kind !== 'noClass',
      source: cells.join(', ').slice(0, 300),
      lineNo: i + 2,
    });
  });
  return out;
}

// ---------------- .ics ----------------

/** Calendar events (calendarModel.parseIcsCalendar) → import rows; plain events are 'other' and unticked. */
export function rowsFromIcsEvents(events = []) {
  return events.map((e, i) => {
    const kind = classify(e.title || '');
    const flags = [];
    if (!e.title) flags.push('title');
    return {
      id: `i${i + 1}`,
      kind,
      title: String(e.title || '').slice(0, 120),
      date: e.dateStr,
      time: e.allDay ? null : `${String(Math.floor(e.startMinutes / 60)).padStart(2, '0')}:${String(e.startMinutes % 60).padStart(2, '0')}`,
      minutes: DEFAULT_MINUTES[kind] || 0,
      flags,
      // Only things that look like coursework are ticked by default.
      include: kind !== 'other' && kind !== 'noClass',
      source: `${e.title || ''} · ${e.dateStr}`,
      lineNo: i + 1,
      uid: e.uid || null,
    };
  });
}

// ---------------- duplicates ----------------

export function normalizeTitle(s) {
  return String(s || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** exams/quizzes are compared with exams; everything else with tasks. */
export function dupKey(kind, title, date) {
  const bucket = kind === 'exam' || kind === 'quiz' ? 'exam' : 'task';
  return `${bucket}|${normalizeTitle(title)}|${date || ''}`;
}

/**
 * Marks duplicates — of something already saved for this course, or of an
 * earlier row in the same import — and unticks them.
 * @param {Array} rows
 * @param {Array<{kind, title, date}>} existing  saved tasks (kind 'task') and exams (kind 'exam') of the course
 */
export function markDuplicates(rows, existing = []) {
  const saved = new Set(existing.map((x) => dupKey(x.kind, x.title, x.date)));
  const seen = new Set();
  return rows.map((r) => {
    const key = dupKey(r.kind, r.title, r.date);
    const dupOf = saved.has(key) ? 'saved' : seen.has(key) ? 'file' : null;
    seen.add(key);
    return dupOf ? { ...r, duplicate: dupOf, include: false } : { ...r, duplicate: null };
  });
}

/**
 * Items dated before today start unticked (a syllabus pasted mid-term
 * shouldn't flood the overdue list); the student can still tick them.
 */
export function markPast(rows, today) {
  return rows.map((r) => (r.date && r.date < today ? { ...r, past: true, include: false } : { ...r, past: false }));
}

// ---------------- review & save ----------------

/** Clears a flag once the student edited the field it is about. */
export function editRow(row, field, value) {
  const next = { ...row, [field]: value };
  const clears = { date: ['date', 'order', 'year', 'multiDate'], title: ['title'], kind: ['kind'] };
  if (clears[field]) next.flags = row.flags.filter((f) => !clears[field].includes(f));
  if (field === 'kind' && row.minutes === (DEFAULT_MINUTES[row.kind] || 0)) next.minutes = DEFAULT_MINUTES[value] || 0;
  return next;
}

export function confirmRow(row) {
  return { ...row, flags: [] };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Why a ticked row can't be saved yet (null = fine). */
export function rowProblem(r) {
  if (r.flags && r.flags.length) return 'confirm';
  if (!String(r.title || '').trim()) return 'title';
  if (!DATE_RE.test(r.date || '') || !isRealDate(...r.date.split('-').map(Number))) return 'date';
  if (r.time && !TIME_RE.test(r.time)) return 'time';
  if (!ITEM_KINDS.includes(r.kind)) return 'kind';
  const m = Number(r.minutes);
  if (['assignment', 'project', 'reading', 'other'].includes(r.kind) && !(Number.isFinite(m) && m >= 5 && m <= 1440)) return 'minutes';
  return null;
}

/** Summary for the Import button. */
export function reviewSummary(rows) {
  const ticked = rows.filter((r) => r.include);
  const blocked = ticked.filter((r) => rowProblem(r));
  return {
    ticked: ticked.length,
    blocked: blocked.length,
    ready: ticked.length - blocked.length,
    duplicates: rows.filter((r) => r.duplicate).length,
    canImport: ticked.length > 0 && blocked.length === 0,
  };
}

/**
 * The writes an import will make. noClass rows are informational only.
 * @returns {{ tasks: Array<{name, due_date, minutes_requested, notes}>, exams: Array<{name, exam_date, start_time}>, meetings: Array }}
 */
export function buildImportPlan(rows, meetings = []) {
  const ready = rows.filter((r) => r.include && !rowProblem(r) && r.kind !== 'noClass');
  return {
    tasks: ready.filter((r) => !['exam', 'quiz'].includes(r.kind)).map((r) => ({
      name: r.title.trim().slice(0, 120),
      due_date: r.date,
      minutes_requested: Math.max(5, Math.min(1440, Math.round(Number(r.minutes) || DEFAULT_MINUTES[r.kind] || 60))),
      notes: r.notes || '',
      ...(r.time ? { due_time: r.time } : {}),
    })),
    exams: ready.filter((r) => ['exam', 'quiz'].includes(r.kind)).map((r) => ({
      name: r.title.trim().slice(0, 120),
      exam_date: r.date,
      start_time: r.time || null,
    })),
    meetings: meetings.filter((m) => m.include && m.days.length && TIME_RE.test(m.start) && TIME_RE.test(m.end) && m.end > m.start),
  };
}
