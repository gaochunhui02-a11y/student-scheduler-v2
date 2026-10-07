// Date-only helpers for V3 (semesters, workload, exams, calendar month
// grids). Every academic date in this app is a local calendar date stored
// as "YYYY-MM-DD" — never a timestamp — so all arithmetic here is done on
// UTC midnights built from the string's own Y/M/D parts. That makes the
// results independent of the browser's timezone and of daylight-saving
// transitions (a DST day still counts as exactly one day; nothing can slip
// to the previous/next date the way Date#toISOString() can).
//
// The only function that reads the clock is todayStr(), which uses LOCAL
// getters so "today" matches the student's wall calendar.

const DAY_MS = 86400000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDateStr(value) {
  if (typeof value !== 'string') return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function toUtc(dateStr) {
  const m = DATE_RE.exec(dateStr || '');
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function fromUtc(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// The student's local calendar date. `now` is injectable for tests.
export function todayStr(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function addDays(dateStr, delta) {
  return fromUtc(toUtc(dateStr) + delta * DAY_MS);
}

// Whole days from `a` to `b` (positive when b is later).
export function diffDays(a, b) {
  return Math.round((toUtc(b) - toUtc(a)) / DAY_MS);
}

// 0 = Sunday … 6 = Saturday (Date#getDay convention, same as class_series).
export function dayOfWeek(dateStr) {
  return new Date(toUtc(dateStr)).getUTCDay();
}

// Monday of the week containing dateStr (the app's weeks start on Monday).
export function startOfWeek(dateStr) {
  const dow = dayOfWeek(dateStr);
  return addDays(dateStr, dow === 0 ? -6 : 1 - dow);
}

// Inclusive list of dates from start to end ([] when end < start). Capped
// so a corrupted range can never build an enormous array.
export function dateRange(start, end, maxDays = 800) {
  const n = diffDays(start, end);
  if (!Number.isFinite(n) || n < 0) return [];
  const out = [];
  for (let i = 0; i <= Math.min(n, maxDays - 1); i += 1) out.push(addDays(start, i));
  return out;
}

export function compareDates(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1; // ISO date strings sort lexicographically
}

export function isWithin(dateStr, start, end) {
  return Boolean(dateStr) && dateStr >= start && dateStr <= end;
}

export function firstOfMonth(dateStr) {
  return `${dateStr.slice(0, 7)}-01`;
}

export function addMonths(dateStr, delta) {
  const [y, m] = [Number(dateStr.slice(0, 4)), Number(dateStr.slice(5, 7))];
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12 + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-01`;
}

// 6 rows x 7 columns (Mon-first) covering the month of `dateStr`, each
// cell { date, inMonth }. Always 42 cells so the grid never jumps height.
export function monthGrid(dateStr) {
  const first = firstOfMonth(dateStr);
  const gridStart = startOfWeek(first);
  const month = first.slice(0, 7);
  return Array.from({ length: 42 }, (_, i) => {
    const date = addDays(gridStart, i);
    return { date, inMonth: date.slice(0, 7) === month };
  });
}

// Minutes since local midnight for a Date (used for "now" markers).
export function minutesOfDay(now = new Date()) {
  return now.getHours() * 60 + now.getMinutes();
}

// "HH:MM[:SS]" -> minutes, or null.
export function clockToMinutes(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function minutesToClockStr(mins) {
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
