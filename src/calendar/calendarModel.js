// Pure, DOM-free, Supabase-free iCalendar (.ics) logic for Calendar
// Import/Export (Phase 12). No network, no file APIs, no Date-object
// timezone conversion for schedule times — everything here works on plain
// "YYYY-MM-DD" date strings and absolute-minutes-since-midnight numbers,
// the same representation scheduler.js/analyticsModel.js/
// notificationsModel.js already use, and is testable with plain Node the
// same way they are. The browser-facing pieces (reading a File, triggering
// a download, building the export/import UI) live in
// src/calendar/calendar.js.
//
// Timezone strategy (deliberate, not an oversight): this app has no stored
// timezone concept anywhere — every wake/sleep/class/study time is a plain
// local wall-clock value the student typed into a <input type="time">.
// Exported events are written as iCalendar "floating time" (RFC 5545 —
// a DATE-TIME with no trailing Z and no TZID), which every calendar app
// interprets as local time in whatever timezone its own system is set to.
// That is exactly correct here: it reproduces the same wall-clock time the
// student planned around, with zero UTC conversion and therefore zero risk
// of the classic "event shows up a day early/late" bug that comes from
// constructing a timezone-aware Date from a bare date string. DTSTAMP
// (when the file was generated, not a schedule time) is the one field
// that's genuinely UTC per spec, and is generated from the real current
// time accordingly.

import { addDaysToDateStr } from '../dashboard/dateUtils.js';

// ---------------------------------------------------------------------------
// Shared ICS text helpers
// ---------------------------------------------------------------------------

const FOLD_LIMIT = 75; // RFC 5545 §3.1 recommends folding content lines at 75 octets

// Escapes a TEXT value per RFC 5545 §3.3.11: backslash, semicolon, comma,
// and newline all need escaping, in that order (backslash first, so it
// doesn't double-escape the backslashes this function itself inserts).
export function escapeIcsText(value) {
  const str = typeof value === 'string' ? value : '';
  return str
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// Reverses escapeIcsText — used when parsing an imported file's property
// values back into plain text.
export function unescapeIcsText(value) {
  const str = typeof value === 'string' ? value : '';
  let result = '';
  for (let i = 0; i < str.length; i += 1) {
    if (str[i] === '\\' && i + 1 < str.length) {
      const next = str[i + 1];
      if (next === 'n' || next === 'N') {
        result += '\n';
      } else if (next === ';' || next === ',' || next === '\\') {
        result += next;
      } else {
        result += next; // unknown escape — RFC says treat conservatively, keep the literal char
      }
      i += 1;
    } else {
      result += str[i];
    }
  }
  return result;
}

// Folds one logical content line into RFC-5545-compliant physical lines:
// every continuation starts with a single space, and CRLF is used
// throughout (the spec requires CRLF line endings, not bare \n).
export function foldIcsLine(line) {
  if (line.length <= FOLD_LIMIT) return line;
  const parts = [];
  let rest = line;
  parts.push(rest.slice(0, FOLD_LIMIT));
  rest = rest.slice(FOLD_LIMIT);
  while (rest.length > 0) {
    const chunkSize = FOLD_LIMIT - 1; // continuation lines lose 1 char to the leading space
    parts.push(` ${rest.slice(0, chunkSize)}`);
    rest = rest.slice(chunkSize);
  }
  return parts.join('\r\n');
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const DEFAULT_EXPORT_EVENT_TYPES = ['class', 'study'];
export const VALID_EXPORT_EVENT_TYPES = ['class', 'study', 'meal', 'break'];

// Floating local date-time — see the timezone note at the top of this
// file. `minutes` may be >= 1440 (the scheduler's own convention for a
// block past midnight); the extra day is rolled into the calendar date via
// plain integer division/addDaysToDateStr, never a timezone-sensitive Date
// constructor.
export function formatIcsLocalDateTime(dateStr, minutes) {
  const total = Math.round(Number(minutes));
  const dayOffset = Math.floor(total / 1440);
  const minuteOfDay = ((total % 1440) + 1440) % 1440;
  const hh = Math.floor(minuteOfDay / 60);
  const mm = minuteOfDay % 60;
  const rolledDate = dayOffset !== 0 ? addDaysToDateStr(dateStr, dayOffset) : dateStr;
  const [y, m, d] = rolledDate.split('-');
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${y}${m}${d}T${pad2(hh)}${pad2(mm)}00`;
}

// The one genuinely-UTC field in this file (DTSTAMP: "when was this file
// generated"), per RFC 5545 §3.8.7.2.
export function formatIcsUtcTimestamp(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}T${String(
    d.getUTCHours()
  ).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}${String(d.getUTCSeconds()).padStart(2, '0')}Z`;
}

// Stable across repeated exports of the SAME saved schedule_item — derived
// directly from its own database id, never randomly generated — so a
// calendar app that already has a previous export of this exact item has
// a real chance of recognizing it as the same event rather than a
// duplicate.
export function buildEventUid(itemId) {
  return `${itemId}@student-scheduler.app`;
}

export function filterExportableItems(items, eventTypes) {
  const types = new Set(Array.isArray(eventTypes) && eventTypes.length > 0 ? eventTypes : DEFAULT_EXPORT_EVENT_TYPES);
  types.delete('free'); // never exportable, regardless of input — "free time" is the absence of a plan, not a calendar event
  return (items || []).filter((item) => types.has(item.item_type));
}

const EVENT_TYPE_LABEL_FALLBACK = { class: 'Class', study: 'Study', meal: 'Meal', break: 'Break' };

// Maps one raw schedule_item row (the {id, item_type, name, start_minutes,
// end_minutes} shape src/dashboard/data.js already returns) plus the
// calendar date it belongs to into the plain fields a VEVENT needs.
// `typeLabel` lets the caller supply a translated category word for the
// description line without this function importing i18n itself.
export function mapScheduleItemToIcsEventFields(item, dateStr, { typeLabel, generatedByText } = {}) {
  const label = typeLabel || EVENT_TYPE_LABEL_FALLBACK[item.item_type] || item.item_type || '';
  const generatedBy = generatedByText || 'Generated by Student Scheduler';
  return {
    uid: buildEventUid(item.id),
    dtstart: formatIcsLocalDateTime(dateStr, item.start_minutes),
    dtend: formatIcsLocalDateTime(dateStr, item.end_minutes),
    summary: typeof item.name === 'string' ? item.name : '',
    description: label ? `${generatedBy} (${label})` : generatedBy,
  };
}

// Assembles one full VCALENDAR document from a list of already-built event
// field objects ({uid, dtstart, dtend, summary, description}). Every
// content line is folded per RFC 5545 and the whole file uses CRLF.
export function buildIcsCalendar(eventFieldsList, { generatedAt } = {}) {
  const dtstamp = formatIcsUtcTimestamp(generatedAt);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Student Scheduler//EN', 'CALSCALE:GREGORIAN'];

  (eventFieldsList || []).forEach((event) => {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${escapeIcsText(event.uid)}`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART:${event.dtstart}`);
    lines.push(`DTEND:${event.dtend}`);
    lines.push(`SUMMARY:${escapeIcsText(event.summary)}`);
    if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
    lines.push('END:VEVENT');
  });

  lines.push('END:VCALENDAR');
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

// Top-level export orchestrator: `days` is [{dateStr, items}, ...] (one
// entry per exported calendar date, items in the raw {id, item_type,
// name, start_minutes, end_minutes} shape). Filters by event type, maps
// every remaining item to VEVENT fields, and builds the final .ics text.
export function exportDaysToIcs(days, { eventTypes, generatedAt, typeLabels, generatedByText } = {}) {
  const eventFieldsList = [];
  (days || []).forEach(({ dateStr, items }) => {
    filterExportableItems(items, eventTypes).forEach((item) => {
      eventFieldsList.push(
        mapScheduleItemToIcsEventFields(item, dateStr, {
          typeLabel: typeLabels && typeLabels[item.item_type],
          generatedByText,
        })
      );
    });
  });
  return { ics: buildIcsCalendar(eventFieldsList, { generatedAt }), eventCount: eventFieldsList.length };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export const MAX_ICS_TEXT_LENGTH = 2_000_000; // ~2MB of text — generous for a calendar file, a sanity cap against absurd input
export const MAX_IMPORT_EVENTS = 500;

export function validateIcsInput(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { valid: false, error: 'empty' };
  }
  if (text.length > MAX_ICS_TEXT_LENGTH) {
    return { valid: false, error: 'too_large' };
  }
  if (!text.includes('BEGIN:VCALENDAR') || !text.includes('BEGIN:VEVENT')) {
    return { valid: false, error: 'not_a_calendar' };
  }
  return { valid: true, error: null };
}

// RFC 5545 §3.1: a line that starts with a single space or horizontal tab
// is a continuation of the previous line, joined with no separator at all
// (the leading whitespace itself is removed). Handles both \r\n and bare
// \n input, since not every exporter is spec-perfect about line endings.
export function unfoldIcsLines(text) {
  const rawLines = (text || '').split(/\r\n|\r|\n/);
  const lines = [];
  rawLines.forEach((raw) => {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += raw.slice(1);
    } else if (raw.length > 0) {
      lines.push(raw);
    }
  });
  return lines;
}

// Splits "NAME;PARAM=X;PARAM2=Y:VALUE" into {name, params, value}. Only
// the first unescaped colon ends the name/params section — a VALUE can
// itself legally contain colons (e.g. a URL in a DESCRIPTION).
export function parseIcsPropertyLine(line) {
  const colonIndex = line.indexOf(':');
  if (colonIndex === -1) return null;
  const head = line.slice(0, colonIndex);
  const value = line.slice(colonIndex + 1);
  const segments = head.split(';');
  const name = (segments[0] || '').toUpperCase();
  const params = {};
  segments.slice(1).forEach((seg) => {
    const eq = seg.indexOf('=');
    if (eq === -1) return;
    params[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1);
  });
  return { name, params, value };
}

function parseIcsDateTimeValue(value, params) {
  // All-day (VALUE=DATE, or an 8-digit-only value with no "T"): "YYYYMMDD".
  const isDateOnly = (params && params.VALUE === 'DATE') || /^\d{8}$/.test(value);
  const digits = value.replace(/[^0-9]/g, '');
  if (digits.length < 8) return null;
  const dateStr = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  if (isDateOnly) {
    return { dateStr, minutes: 0, allDay: true };
  }
  const hh = Number(digits.slice(8, 10) || '0');
  const mm = Number(digits.slice(10, 12) || '0');
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  // A trailing "Z" (UTC) on an imported file is treated the same as
  // floating local time for this simple import — displaying/blocking a
  // wall-clock time is what matters here, not precise UTC conversion, and
  // this app has no stored timezone to convert into anyway.
  return { dateStr, minutes: hh * 60 + mm, allDay: false };
}

const MAX_TITLE_LENGTH = 200;

// Parses a .ics file's VEVENT blocks into a simple, safe, plain-object
// shape. Every recurring event (any VEVENT carrying an RRULE) is
// deliberately excluded from the returned `events` — this phase does not
// implement any part of RFC 5545's recurrence expansion (not even
// "simple" daily/weekly rules), since getting recurrence math subtly
// wrong is worse than clearly not supporting it; see
// importErrorMessageKey/'unsupported_recurrence' and the Phase 12 report
// for why. Skipped events are counted, not silently dropped.
export function parseIcsCalendar(text) {
  const validation = validateIcsInput(text);
  if (!validation.valid) {
    return { valid: false, error: validation.error, events: [], skippedRecurringCount: 0 };
  }

  const lines = unfoldIcsLines(text);
  const events = [];
  let skippedRecurringCount = 0;
  let current = null;

  lines.forEach((line) => {
    if (line === 'BEGIN:VEVENT') {
      current = { uid: null, title: '', dtstartRaw: null, dtendRaw: null, hasRecurrence: false };
      return;
    }
    if (line === 'END:VEVENT') {
      if (current) {
        if (current.hasRecurrence) {
          skippedRecurringCount += 1;
        } else if (current.dtstartRaw) {
          const start = parseIcsDateTimeValue(current.dtstartRaw.value, current.dtstartRaw.params);
          const end = current.dtendRaw ? parseIcsDateTimeValue(current.dtendRaw.value, current.dtendRaw.params) : null;
          if (start && events.length < MAX_IMPORT_EVENTS) {
            const allDay = start.allDay;
            events.push({
              id: events.length,
              uid: current.uid,
              title: (current.title || '').slice(0, MAX_TITLE_LENGTH),
              dateStr: start.dateStr,
              startMinutes: allDay ? 0 : start.minutes,
              endMinutes: allDay ? 24 * 60 - 1 : end && !end.allDay ? end.minutes : start.minutes + 60,
              allDay,
            });
          }
        }
      }
      current = null;
      return;
    }
    if (!current) return;

    const prop = parseIcsPropertyLine(line);
    if (!prop) return;
    if (prop.name === 'UID') current.uid = unescapeIcsText(prop.value);
    else if (prop.name === 'SUMMARY') current.title = unescapeIcsText(prop.value);
    else if (prop.name === 'DTSTART') current.dtstartRaw = prop;
    else if (prop.name === 'DTEND') current.dtendRaw = prop;
    else if (prop.name === 'RRULE') current.hasRecurrence = true;
  });

  const warnings = skippedRecurringCount > 0 ? ['unsupported_recurrence'] : [];
  // Nothing importable is nothing importable regardless of WHY — whether
  // the file had zero events at all, or every event was a recurring one
  // this phase doesn't support. skippedRecurringCount/warnings are still
  // returned alongside the rejection so the caller can show a more
  // specific message than a bare "no events found."
  if (events.length === 0) {
    return { valid: false, error: 'no_events', events: [], skippedRecurringCount, warnings };
  }
  return { valid: true, error: null, events, skippedRecurringCount, warnings };
}

export function selectImportEvents(events, selectedIndexes) {
  const selected = new Set(selectedIndexes || []);
  return (events || []).filter((_, i) => selected.has(i));
}

// Maps one selected, already-parsed import event onto the EXISTING
// classes table's field shape ({name, start_time, end_time}) — see the
// Phase 12 report for why classes (not a new table) is the right target.
// An all-day event becomes a full-day block (00:00-23:59) ONLY because
// the user explicitly selected it in the preview — that selection IS the
// "let the user decide whether it should block study time" the brief
// asks for; nothing here decides that on its own.
export function mapImportEventToClassFields(event) {
  const pad2 = (n) => String(n).padStart(2, '0');
  function toTimeString(minutes) {
    const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(minutes)));
    return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
  }
  return {
    name: event.title && event.title.trim() ? event.title.trim() : 'Imported event',
    start_time: toTimeString(event.startMinutes),
    end_time: toTimeString(event.endMinutes),
  };
}

// Groups selected import events by calendar date, so the caller only
// needs one getOrCreateScheduleForDate call per unique date rather than
// one per event.
export function groupSelectedEventsByDate(events) {
  const groups = {};
  (events || []).forEach((event) => {
    if (!event.dateStr) return;
    if (!groups[event.dateStr]) groups[event.dateStr] = [];
    groups[event.dateStr].push(event);
  });
  return groups;
}

const IMPORT_ERROR_MESSAGE_KEYS = {
  empty: 'calendar.importEmptyFile',
  too_large: 'calendar.importFileTooLarge',
  not_a_calendar: 'calendar.importNotACalendar',
  no_events: 'calendar.importNoValidEvents',
};

export function importErrorMessageKey(errorCode) {
  return IMPORT_ERROR_MESSAGE_KEYS[errorCode] || 'calendar.importGenericError';
}
