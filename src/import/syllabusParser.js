// Syllabus text → import rows (V5-C), pure and deterministic — no AI.
//
// It reads pasted syllabus text line by line and only reports what is
// actually written there:
//   * dated lines become items (assignment / exam / quiz / project /
//     reading / no-class / other), titled with the line's own words
//   * undated lines naming weekdays and a time range become weekly
//     meetings ("MWF 9:00–9:50 AM Lecture")
//   * the course code / name, if a line near the top states them
// Anything uncertain is flagged for the student to confirm — a date whose
// day/month order or year isn't certain, a line with several dates, an item
// whose type couldn't be told, a title that was only a date. Lines without
// a date are never turned into deadlines.

import { findDateMentions, resolveDate, findTime, findTimeRange, findWeekdays } from './importDates.js';

export const ITEM_KINDS = ['assignment', 'exam', 'quiz', 'project', 'reading', 'other', 'noClass'];
export const DEFAULT_MINUTES = { assignment: 120, project: 300, reading: 45, other: 60, quiz: 0, exam: 0, noClass: 0 };
export const MAX_LINES = 2000;
export const MAX_TEXT = 200000;

const KIND_RULES = [
  ['noClass', /\b(no class(?:es)?|holiday|recess|spring break|fall break|thanksgiving|reading (?:day|week)|class(?:es)? cancel(?:l)?ed)\b|停课|放假|假期|休講|休み|祝日/i],
  ['project', /\b(projects?|presentations?|proposals?|portfolio|capstone)\b|项目|课题|プロジェクト|発表/i],
  ['quiz', /\bquiz(?:zes)?\b|小测|测验|小テスト/i],
  ['exam', /\b(exams?|mid-?terms?|finals?(?: exam)?|tests?)\b|考试|期中|期末|試験|テスト|中間/i],
  ['assignment', /\b(assignments?|homework|hw\s?\d*|problem sets?|psets?|ps\s?\d+|essays?|papers?|lab reports?|reports?|worksheets?|exercises?|due|submit|submission|write-?up)\b|作业|论文|提交|課題|宿題|レポート|提出/i],
  ['reading', /\b(read(?:ing)?s?|chapters?|ch\.\s?\d+|pp\.\s?\d+|textbook)\b|阅读|章节|読む|読書|章/i],
];

export function classify(text) {
  for (const [kind, re] of KIND_RULES) if (re.test(text)) return kind;
  return 'other';
}

const MEETING_LABELS = [
  ['lab', /\blab(?:oratory)?\b|实验|実験/i], ['recitation', /\brecitation\b/i], ['discussion', /\bdiscussion\b|讨论/i],
  ['seminar', /\bseminar\b|研讨|ゼミ/i], ['tutorial', /\btutorial\b|辅导/i], ['officeHours', /\boffice hours?\b|答疑|オフィスアワー/i],
  ['lecture', /\blectures?\b|讲座|講義|授業/i],
];

/** "CHEM 110 — General Chemistry" / "Course: Intro to CS" near the top. */
export function detectCourse(lines) {
  const head = lines.slice(0, 15);
  let code = null;
  let name = null;
  for (const line of head) {
    const m = line.match(/\b([A-Z]{2,5})\s?-?(\d{3,4}[A-Z]?)\b/);
    if (m && !code) {
      code = `${m[1]} ${m[2]}`;
      const rest = line.slice(m.index + m[0].length).replace(/^[\s:–—\-|,.]+/, '').trim();
      if (rest && rest.length <= 120 && !findDateMentions(rest).length) name = rest.replace(/\s*\(.*?\)\s*$/, '').trim() || null;
    }
    const named = line.match(/^\s*(?:course(?: title| name)?|class|课程名?称?|科目名?|授業名)\s*[:：]\s*(.{2,120})$/i);
    if (named && !name) name = named[1].trim();
    if (code && name) break;
  }
  return { code, name };
}

function cleanTitle(text, removeRanges) {
  let s = String(text);
  // Cut out the dates / times we recognised (right to left keeps indexes valid).
  removeRanges.slice().sort((a, b) => b.index - a.index).forEach((r) => { s = s.slice(0, r.index) + ' ' + s.slice(r.index + r.length); });
  s = s
    .replace(/\b(\d{1,2})(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)(?![a-z])/gi, ' ')
    .replace(/\b([01]?\d|2[0-3]):[0-5]\d\b/g, ' ')
    .replace(/\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(day)?\b\.?,?/gi, ' ')
    .replace(/^\s*(?:[-*•·▪◦>]|\d{1,2}[.)]|week\s*\d+\s*[:\-–—]?|wk\s*\d+)\s*/i, ' ')
    .replace(/(?:\s+(?:due|by|on|at|before|until))+\s*[,:;.\-–—]*\s*$/i, ' ')
    .replace(/^\s*(due|on)\b/i, ' ')
    .replace(/\(\s*\)/g, ' ')
    .replace(/[|\t]+/g, ' ')
    .replace(/\s*[–—]\s*/g, ' – ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,:;.\-–—]+|[\s,:;\-–—]+$/g, '')
    .trim();
  return s.slice(0, 120);
}

let seq = 0;
function rowId() {
  seq += 1;
  return `r${seq}`;
}

/**
 * @param {string} text
 * @param {{ today: string, termStart?: string|null, dateOrder?: 'mdy'|'dmy'|null }} ctx
 * @returns {{ course: {code, name}, items: Array, meetings: Array, stats: { lines, dated, skipped } }}
 */
export function parseSyllabus(text, ctx) {
  seq = 0;
  const raw = String(text || '').slice(0, MAX_TEXT).replace(/\r\n?/g, '\n');
  const lines = raw.split('\n').slice(0, MAX_LINES);
  const course = detectCourse(lines);
  const items = [];
  const meetings = [];
  let dated = 0;
  let skipped = 0;
  lines.forEach((line, lineNo) => {
    if (!line.trim()) return;
    // A table row (tabs / wide gaps) can hold several items for one date.
    const cells = line.split(/\t| {3,}/).map((c) => c.trim()).filter(Boolean);
    const segments = cells.length > 1 ? [cells] : line.split(/\s*;\s*/).map((seg) => [seg]);
    let lineHadDate = false;
    segments.forEach((segCells) => {
      const joined = segCells.join('  ');
      const mentions = findDateMentions(joined);
      if (!mentions.length) return;
      lineHadDate = true;
      // Several dates in one segment: a range or a list — keep the last
      // (usually the due date) and ask.
      const pick = mentions[mentions.length - 1];
      const { date, flags } = resolveDate(pick, ctx);
      if (!date) return;
      if (mentions.length > 1) flags.push('multiDate');
      const rest = joined.replace(pick.raw, ' ');
      const span = findTimeRange(rest);
      const time = span ? span.start : findTime(rest);
      // Table rows: each cell that names an item becomes its own row.
      const itemCells = segCells.length > 1
        ? segCells.filter((c) => !findDateMentions(c).length || cleanTitle(c, findDateMentions(c)).length > 2).filter((c) => !/^\s*(week|wk)\s*\d+\s*$/i.test(c))
        : [joined];
      const named = segCells.length > 1 ? itemCells.filter((c) => classify(c) !== 'other') : itemCells;
      const sources = named.length ? named : [itemCells.join(' ')];
      sources.forEach((src) => {
        const ranges = findDateMentions(src);
        let title = cleanTitle(src, ranges);
        const kind = classify(src);
        const rowFlags = [...flags];
        if (!title) {
          rowFlags.push('title');
          title = '';
        }
        if (kind === 'other') rowFlags.push('kind');
        items.push({
          id: rowId(),
          kind,
          title,
          date,
          time: time && kind !== 'noClass' ? time : null,
          minutes: DEFAULT_MINUTES[kind] || 0,
          flags: rowFlags,
          source: line.trim().slice(0, 300),
          lineNo: lineNo + 1,
          include: kind !== 'noClass',
        });
      });
      dated += 1;
    });
    if (lineHadDate) return;
    // Weekly meeting: weekdays + a time range, no date.
    const days = findWeekdays(line);
    const range = findTimeRange(line);
    if (days.length && range) {
      const label = (MEETING_LABELS.find(([, re]) => re.test(line)) || ['lecture'])[0];
      const location = (line.match(/\b(?:room|rm\.?|in|@|location:?)\s+([A-Z][\w .-]{1,40}\d{1,4}[A-Z]?)\b/i) || [])[1] || null;
      meetings.push({ id: rowId(), label, days, start: range.start, end: range.end, location, source: line.trim().slice(0, 300), lineNo: lineNo + 1, include: label !== 'officeHours', flags: [] });
      return;
    }
    skipped += 1;
  });
  return { course, items, meetings, stats: { lines: lines.filter((l) => l.trim()).length, dated, skipped } };
}
