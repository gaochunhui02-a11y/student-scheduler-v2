// Date and time recognition for imports (V5-C), pure and deterministic.
//
// Never guesses silently: every date carries how sure we are.
//   * an explicit year, or a term start the student gave us → certain
//   * a numeric date like 3/4 where both parts could be the month →
//     `ambiguous: 'order'` unless the student chose the order (M/D or D/M)
//   * no year anywhere → the year is resolved from the term start (or
//     today) and flagged `ambiguous: 'year'` unless a term start was given
// Supported: 2026-09-14 · Sep 14 · September 14th, 2026 · Sept. 14 ·
// 14 Sep · Mon, Sep 14 · 9/14 · 9/14/26 · 14.09.2026 · 9月14日 ·
// 2026年9月14日. Times: 11:59 PM · 5pm · 23:59 · noon · midnight.

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const ORD = '(?:st|nd|rd|th)?';

function pad(n) {
  return String(n).padStart(2, '0');
}
export function isRealDate(y, m, d) {
  if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function iso(y, m, d) {
  return `${y}-${pad(m)}-${pad(d)}`;
}
function fullYear(y) {
  const n = Number(y);
  return n < 100 ? 2000 + n : n;
}

/**
 * Every date mention in a string, left to right, without overlaps.
 * @returns {Array<{ index, length, raw, year: number|null, month, day, order?: 'ambiguous'|'mdy'|'dmy' }>}
 */
export function findDateMentions(text) {
  const s = String(text || '');
  const found = [];
  const taken = [];
  const free = (i, len) => !taken.some(([a, b]) => i < b && i + len > a);
  const add = (m, year, month, day, extra = {}) => {
    if (!free(m.index, m[0].length)) return;
    if (!isRealDate(year === null ? 2024 : year, month, day)) return; // 2024: allows Feb 29 without a year
    taken.push([m.index, m.index + m[0].length]);
    found.push({ index: m.index, length: m[0].length, raw: m[0], year, month, day, ...extra });
  };
  let m;
  // ISO 2026-09-14
  const isoRe = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g;
  while ((m = isoRe.exec(s))) add(m, Number(m[1]), Number(m[2]), Number(m[3]));
  // CJK 2026年9月14日 / 9月14日
  const cjk = /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g;
  while ((m = cjk.exec(s))) add(m, m[1] ? Number(m[1]) : null, Number(m[2]), Number(m[3]));
  // Sep 14 / September 14th, 2026 / Sept. 14
  const md = new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})${ORD}\\b(?:,?\\s+(\\d{4})\\b)?`, 'gi');
  while ((m = md.exec(s))) add(m, m[3] ? Number(m[3]) : null, MONTHS[m[1].toLowerCase()], Number(m[2]));
  // 14 Sep / 14th September 2026
  const dm = new RegExp(`\\b(\\d{1,2})${ORD}\\s+(?:of\\s+)?${MONTH_RE}\\.?\\b(?:,?\\s+(\\d{4})\\b)?`, 'gi');
  while ((m = dm.exec(s))) add(m, m[3] ? Number(m[3]) : null, MONTHS[m[2].toLowerCase()], Number(m[1]));
  // 14.09.2026 (dots only with a 4-digit year — "9.50" is a time or a number)
  const dotted = /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g;
  while ((m = dotted.exec(s))) add(m, Number(m[3]), Number(m[2]), Number(m[1]), { order: 'dmy' });
  // 9/14, 9/14/26, 14/9/2026
  const slash = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?![\d/])/g;
  while ((m = slash.exec(s))) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = m[3] ? fullYear(m[3]) : null;
    if (a > 12 && b <= 12) add(m, year, b, a, { order: 'dmy' });
    else if (b > 12 && a <= 12) add(m, year, a, b, { order: 'mdy' });
    else if (a <= 12 && b <= 12) add(m, year, a, b, { order: 'ambiguous', alt: { month: b, day: a } });
  }
  return found.sort((x, y) => x.index - y.index);
}

/**
 * Resolves a mention to YYYY-MM-DD plus what still needs the student's eye.
 * @param {object} mention from findDateMentions
 * @param {{ termStart?: string|null, today: string, dateOrder?: 'mdy'|'dmy'|null }} ctx
 * @returns {{ date: string|null, flags: string[] }}  flags ⊂ ['order', 'year']
 */
export function resolveDate(mention, { termStart = null, today, dateOrder = null } = {}) {
  const flags = [];
  let { month, day } = mention;
  if (mention.order === 'ambiguous') {
    if (dateOrder === 'dmy' && mention.alt) ({ month, day } = mention.alt);
    else if (dateOrder !== 'mdy') flags.push('order');
  }
  let year = mention.year;
  if (year === null) {
    const anchor = termStart || today;
    const [ay] = anchor.split('-').map(Number);
    year = ay;
    // Dates more than a month before the anchor belong to the next year
    // (a spring term listed in a syllabus that starts in August, etc.).
    const candidate = iso(year, month, day);
    const cutoff = new Date(Date.parse(`${anchor}T00:00:00Z`) - 31 * 86400000).toISOString().slice(0, 10);
    if (candidate < cutoff) year += 1;
    if (!termStart) flags.push('year');
  }
  if (!isRealDate(year, month, day)) return { date: null, flags: ['order'] };
  return { date: iso(year, month, day), flags };
}

/** A clock time in the text → 'HH:MM', or null. Ranges return the first time. */
export function findTime(text) {
  const s = String(text || '').toLowerCase();
  let m = s.match(/\b(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/);
  if (m) {
    let h = Number(m[1]) % 12;
    if (m[3].startsWith('p')) h += 12;
    if (Number(m[1]) > 12) return null;
    return `${pad(h)}:${m[2] || '00'}`;
  }
  m = s.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m) return `${pad(Number(m[1]))}:${m[2]}`;
  if (/\bnoon\b|正午/.test(s)) return '12:00';
  if (/\bmidnight\b|午夜|深夜0時/.test(s)) return '23:59';
  return null;
}

function to24(h, mins, mer) {
  let hh = Number(h);
  if (mer) {
    hh %= 12;
    if (mer.startsWith('p')) hh += 12;
  }
  return hh * 60 + Number(mins || 0);
}

/**
 * A time range like "10:30-11:45am", "2–3:15 PM", "13:00 to 14:15".
 * @returns {{ start: 'HH:MM', end: 'HH:MM', index, length } | null}
 */
export function findTimeRange(text) {
  const s = String(text || '');
  const re = /\b(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:-|–|—|to|~|〜|～)\s*(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)?(?![\w])/i;
  const m = s.match(re);
  if (!m) return null;
  const m1 = m[3] ? m[3].toLowerCase() : null;
  const m2 = m[6] ? m[6].toLowerCase() : null;
  if (!m[2] && !m[5] && !m1 && !m2) return null; // "3-4" alone is not a time range
  if (Number(m[1]) > 23 || Number(m[4]) > 23) return null;
  let end = to24(m[4], m[5], m2);
  let start;
  if (m1) start = to24(m[1], m[2], m1);
  else if (m2) {
    // "2-3:15pm" → 14:00; "11-12:15pm" → 11:00
    start = to24(m[1], m[2], m2);
    if (start >= end) start = to24(m[1], m[2], m2.startsWith('p') ? 'am' : 'pm');
    if (start >= end) start = to24(m[1], m[2], null);
  } else start = to24(m[1], m[2], null);
  if (!m2 && m1 && end <= start) end = to24(m[4], m[5], m1.startsWith('a') ? 'pm' : 'am');
  if (!(end > start) || end > 24 * 60) return null;
  const hhmm = (x) => `${pad(Math.floor(x / 60))}:${pad(x % 60)}`;
  return { start: hhmm(start), end: hhmm(end), index: m.index, length: m[0].length };
}

const DAY_WORDS = [
  [/\b(sun(?:day)?s?)\b|周日|星期日|日曜/i, 0], [/\b(mon(?:day)?s?)\b|周一|星期一|月曜/i, 1],
  [/\b(tue(?:s(?:day)?)?s?)\b|周二|星期二|火曜/i, 2], [/\b(wed(?:nesday)?s?)\b|周三|星期三|水曜/i, 3],
  [/\b(thu(?:r(?:s(?:day)?)?)?s?)\b|周四|星期四|木曜/i, 4], [/\b(fri(?:day)?s?)\b|周五|星期五|金曜/i, 5],
  [/\b(sat(?:urday)?s?)\b|周六|星期六|土曜/i, 6],
];
// Compact meeting codes students see on timetables. Only multi-letter
// combinations — a lone "M" or "F" is far too likely to be something else.
const COMPACT = { MWF: [1, 3, 5], MW: [1, 3], WF: [3, 5], MF: [1, 5], TTH: [2, 4], TUTH: [2, 4], TR: [2, 4], MTWTHF: [1, 2, 3, 4, 5], MTWRF: [1, 2, 3, 4, 5], MTW: [1, 2, 3], TWTH: [2, 3, 4] };

/** Weekdays named in a line (0 = Sunday), sorted, or [] */
export function findWeekdays(text) {
  const s = String(text || '');
  const days = new Set();
  s.split(/[\s,/&+]+/).forEach((tok) => {
    const c = tok.replace(/[^a-z]/gi, '').toUpperCase();
    if (COMPACT[c]) COMPACT[c].forEach((d) => days.add(d));
  });
  DAY_WORDS.forEach(([re, d]) => { if (re.test(s)) days.add(d); });
  return [...days].sort((a, b) => a - b);
}
