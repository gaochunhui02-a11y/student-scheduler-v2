// V5-C imports: syllabus text, CSV, .ics rows, dates/times, duplicates and
// the "nothing ambiguous is saved" rule.
// Run: node tests/import.test.js

import assert from 'node:assert/strict';
import { findDateMentions, resolveDate, findTime, findTimeRange, findWeekdays } from '../src/import/importDates.js';
import { parseSyllabus, classify, detectCourse } from '../src/import/syllabusParser.js';
import { parseCsv, guessColumns, rowsFromCsv, rowsFromIcsEvents, markDuplicates, markPast, editRow, confirmRow, rowProblem, reviewSummary, buildImportPlan, normalizeTitle } from '../src/import/importModel.js';

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${label}`);
    console.log(`        ${e.message}`);
  }
}

const TODAY = '2026-08-20';
const TERM = { today: TODAY, termStart: '2026-08-24' };

console.log('\n=== dates & times ===');
check('formats: ISO, month names, ordinals, day-first, CJK, dotted, slashes', () => {
  const pick = (s) => findDateMentions(s).map((m) => resolveDate(m, TERM).date);
  assert.deepEqual(pick('due 2026-09-14'), ['2026-09-14']);
  assert.deepEqual(pick('Sep 14'), ['2026-09-14']);
  assert.deepEqual(pick('September 14th, 2026'), ['2026-09-14']);
  assert.deepEqual(pick('Sept. 3'), ['2026-09-03']);
  assert.deepEqual(pick('14 Sep'), ['2026-09-14']);
  assert.deepEqual(pick('Mon, Oct 5 and Thu, Oct 8'), ['2026-10-05', '2026-10-08']);
  assert.deepEqual(pick('9月14日 提交'), ['2026-09-14']);
  assert.deepEqual(pick('2027年1月8日'), ['2027-01-08']);
  assert.deepEqual(pick('14.09.2026'), ['2026-09-14']);
  assert.deepEqual(pick('9/14'), ['2026-09-14']);
  assert.deepEqual(pick('due 10/21/26'), ['2026-10-21']);
});
check('impossible dates are ignored, never "fixed"', () => {
  assert.equal(findDateMentions('Feb 30').length, 0);
  assert.equal(findDateMentions('13/13').length, 0);
  assert.equal(findDateMentions('2026-02-29').length, 0);
  assert.equal(findDateMentions('page 3 of 12').length, 0);
});
check('3/4 is ambiguous unless the order is chosen; a day > 12 settles it', () => {
  const [m] = findDateMentions('Quiz 3/4');
  assert.deepEqual(resolveDate(m, TERM), { date: '2027-03-04', flags: ['order'] });
  assert.equal(resolveDate(m, { ...TERM, dateOrder: 'dmy' }).date, '2027-04-03');
  assert.deepEqual(resolveDate(m, { ...TERM, dateOrder: 'mdy' }).flags, []);
  assert.deepEqual(resolveDate(findDateMentions('14/9')[0], TERM), { date: '2026-09-14', flags: [] });
});
check('missing year: rolls into next year after the term start; flagged without a term start', () => {
  assert.deepEqual(resolveDate(findDateMentions('Jan 12')[0], TERM), { date: '2027-01-12', flags: [] });
  assert.deepEqual(resolveDate(findDateMentions('Dec 4')[0], TERM), { date: '2026-12-04', flags: [] });
  assert.deepEqual(resolveDate(findDateMentions('Dec 4')[0], { today: TODAY }), { date: '2026-12-04', flags: ['year'] });
  assert.deepEqual(resolveDate(findDateMentions('Sep 14, 2026')[0], { today: TODAY }).flags, []);
});
check('times and time ranges', () => {
  assert.equal(findTime('due 11:59 PM'), '23:59');
  assert.equal(findTime('by 5pm'), '17:00');
  assert.equal(findTime('at 9 a.m.'), '09:00');
  assert.equal(findTime('17:30'), '17:30');
  assert.equal(findTime('noon'), '12:00');
  assert.equal(findTime('Chapter 4'), null);
  assert.deepEqual([findTimeRange('10:30-11:45am').start, findTimeRange('10:30-11:45am').end], ['10:30', '11:45']);
  assert.deepEqual([findTimeRange('2–3:15 PM').start, findTimeRange('2–3:15 PM').end], ['14:00', '15:15']);
  assert.deepEqual([findTimeRange('11-12:15pm').start, findTimeRange('11-12:15pm').end], ['11:00', '12:15']);
  assert.deepEqual([findTimeRange('13:00 to 14:15').start, findTimeRange('13:00 to 14:15').end], ['13:00', '14:15']);
  assert.equal(findTimeRange('Chapters 3-4'), null);
});
check('weekdays: names, abbreviations, compact codes — not random words', () => {
  assert.deepEqual(findWeekdays('MWF 9:00'), [1, 3, 5]);
  assert.deepEqual(findWeekdays('TTh 2-3:15pm'), [2, 4]);
  assert.deepEqual(findWeekdays('Tuesdays and Thursdays'), [2, 4]);
  assert.deepEqual(findWeekdays('Mon/Wed'), [1, 3]);
  assert.deepEqual(findWeekdays('monthly friendly satisfaction'), []);
});

console.log('\n=== syllabus text ===');
const SYLLABUS = `CHEM 110 — General Chemistry (Fall 2026)
Instructor: Dr. Lee Park
Lectures: MWF 9:00–9:50 AM, Science Center 3
Lab: Thursdays 2-4:50pm
Office hours: Tue 3-4pm

Schedule
Week 1\tAug 24\tIntro; Chapter 1 reading
Sep 4 – Problem Set 1 due by 11:59 PM
Sep 7 – Labor Day, no class
Quiz 1: Sep 11
Lab report 1 due 9/18
Midterm exam — Oct 9, 9:00 AM
Sep 21 - Sep 25: Unit 2
3/4 Review session
Final project proposal due November 6
Final Exam: Dec 14, 8:00-10:00 AM
Remember to bring a calculator to every class.`;
const parsed = parseSyllabus(SYLLABUS, TERM);
const find = (re) => parsed.items.find((x) => re.test(x.title));

check('course code and name from the header', () => {
  assert.deepEqual(parsed.course, { code: 'CHEM 110', name: 'General Chemistry' });
  assert.deepEqual(detectCourse(['Course: Modern World History']), { code: null, name: 'Modern World History' });
});
check('dated lines become typed items with the right dates and times', () => {
  const ps = find(/problem set 1/i);
  assert.deepEqual([ps.kind, ps.date, ps.time, ps.flags], ['assignment', '2026-09-04', '23:59', []]);
  assert.deepEqual([find(/quiz 1/i).kind, find(/quiz 1/i).date], ['quiz', '2026-09-11']);
  assert.deepEqual([find(/lab report 1/i).kind, find(/lab report 1/i).date], ['assignment', '2026-09-18']);
  const mid = find(/midterm/i);
  assert.deepEqual([mid.kind, mid.date, mid.time], ['exam', '2026-10-09', '09:00']);
  assert.deepEqual([find(/proposal/i).kind, find(/proposal/i).date], ['project', '2026-11-06']);
  assert.deepEqual([find(/final exam/i).kind, find(/final exam/i).date, find(/final exam/i).time], ['exam', '2026-12-14', '08:00']);
});
check('titles keep the line\'s own words, without dates, times or bullets', () => {
  assert.equal(find(/problem set 1/i).title, 'Problem Set 1');
  assert.equal(find(/midterm/i).title, 'Midterm exam');
  assert.equal(find(/proposal/i).title, 'Final project proposal');
});
check('table rows: one item per meaningful cell, week labels dropped', () => {
  const week1 = parsed.items.filter((x) => x.date === '2026-08-24');
  assert.ok(week1.some((x) => /chapter 1 reading/i.test(x.title) && x.kind === 'reading'), JSON.stringify(week1));
  assert.ok(!week1.some((x) => /^week 1$/i.test(x.title)));
});
check('no-class days are recognised and unticked; ranges and ambiguous dates are flagged', () => {
  const labor = find(/labor day/i);
  assert.deepEqual([labor.kind, labor.include], ['noClass', false]);
  assert.ok(find(/unit 2/i).flags.includes('multiDate'));
  assert.ok(find(/review session/i).flags.includes('order'));
  assert.ok(find(/review session/i).flags.includes('kind'));
});
check('weekly meetings from undated weekday + time-range lines', () => {
  const lect = parsed.meetings.find((m) => m.label === 'lecture');
  assert.deepEqual([lect.days, lect.start, lect.end], [[1, 3, 5], '09:00', '09:50']);
  const lab = parsed.meetings.find((m) => m.label === 'lab');
  assert.deepEqual([lab.days, lab.start, lab.end], [[4], '14:00', '16:50']);
  const oh = parsed.meetings.find((m) => m.label === 'officeHours');
  assert.equal(oh.include, false);
});
check('lines without a date never become deadlines', () => {
  assert.ok(!parsed.items.some((x) => /calculator|instructor/i.test(x.title)));
  assert.ok(parsed.stats.skipped >= 2);
});
check('classify: multilingual keywords', () => {
  assert.equal(classify('期中考试'), 'exam');
  assert.equal(classify('レポート提出'), 'assignment');
  assert.equal(classify('Read pp. 40-62'), 'reading');
  assert.equal(classify('Guest speaker'), 'other');
});

console.log('\n=== CSV ===');
check('parser: quotes, escaped quotes, CRLF, semicolons, BOM', () => {
  const c = parseCsv('﻿Title,Due,Notes\r\n"Essay, draft",2026-09-30,"He said ""go"""\r\nQuiz 2,Oct 2,\n');
  assert.deepEqual(c.header, ['Title', 'Due', 'Notes']);
  assert.deepEqual(c.rows, [['Essay, draft', '2026-09-30', 'He said "go"'], ['Quiz 2', 'Oct 2', '']]);
  assert.equal(parseCsv('a;b\n1;2').delimiter, ';');
  assert.equal(parseCsv('a\tb\n1\t2').delimiter, '\t');
});
check('columns guessed from headers (en/zh/ja); hours converted; rows typed and flagged', () => {
  const c = parseCsv('Assignment,Due date,Type,Est. hours\nEssay 1,2026-09-30,assignment,3\nMidterm,10/9,exam,\nGuest talk,,,\n');
  const cols = guessColumns(c.header);
  assert.deepEqual(cols, { title: 0, date: 1, kind: 2, minutes: 3 });
  const rows = rowsFromCsv(c, cols, TERM);
  assert.deepEqual([rows[0].kind, rows[0].date, rows[0].minutes, rows[0].flags], ['assignment', '2026-09-30', 180, []]);
  assert.deepEqual([rows[1].kind, rows[1].date], ['exam', '2026-10-09']);
  assert.ok(rows[2].flags.includes('date'));
  assert.deepEqual(guessColumns(['作业', '截止日期']), { title: 0, date: 1 });
  assert.deepEqual(guessColumns(['課題', '締め切り']), { title: 0, date: 1 });
});

console.log('\n=== .ics ===');
check('.ics events: coursework ticked, other events unticked', () => {
  const rows = rowsFromIcsEvents([
    { uid: 'a', title: 'HW 3 due', dateStr: '2026-09-20', allDay: false, startMinutes: 1439, endMinutes: 1440 },
    { uid: 'b', title: 'Club meeting', dateStr: '2026-09-21', allDay: true, startMinutes: 0, endMinutes: 1439 },
  ]);
  assert.deepEqual(rows.map((r) => [r.kind, r.include, r.time]), [['assignment', true, '23:59'], ['other', false, null]]);
});

console.log('\n=== duplicates & confirmation ===');
check('duplicates of saved work and within the file are unticked and labelled', () => {
  const rows = [
    { id: '1', kind: 'assignment', title: 'Problem Set 1', date: '2026-09-04', flags: [], include: true },
    { id: '2', kind: 'assignment', title: 'problem set 1!', date: '2026-09-04', flags: [], include: true },
    { id: '3', kind: 'exam', title: 'Midterm', date: '2026-10-09', flags: [], include: true },
    { id: '4', kind: 'assignment', title: 'Essay', date: '2026-09-30', flags: [], include: true },
  ];
  const out = markDuplicates(rows, [{ kind: 'exam', title: 'MIDTERM', date: '2026-10-09' }]);
  assert.deepEqual(out.map((r) => [r.duplicate, r.include]), [[null, true], ['file', false], ['saved', false], [null, true]]);
  assert.equal(normalizeTitle('  Lab—Report #2 '), 'lab report 2');
});
check('past-dated items start unticked (still selectable)', () => {
  const out = markPast([{ id: '1', date: '2026-09-04', include: true }, { id: '2', date: '2026-12-01', include: true }, { id: '3', date: null, include: true }], '2026-11-09');
  assert.deepEqual(out.map((r) => [r.past, r.include]), [[true, false], [false, true], [false, true]]);
});
check('flagged rows block the import until edited or confirmed', () => {
  const row = { id: '1', kind: 'other', title: 'Review session', date: '2027-03-04', time: null, minutes: 60, flags: ['order', 'kind'], include: true };
  assert.equal(rowProblem(row), 'confirm');
  assert.equal(reviewSummary([row]).canImport, false);
  const edited = editRow(editRow(row, 'date', '2027-04-03'), 'kind', 'reading');
  assert.deepEqual(edited.flags, []);
  assert.equal(edited.minutes, 45); // default follows the new type when untouched
  assert.equal(rowProblem(edited), null);
  assert.equal(rowProblem(confirmRow(row)), null);
  assert.equal(rowProblem({ ...confirmRow(row), date: '2027-02-30' }), 'date');
  assert.equal(rowProblem({ ...confirmRow(row), title: '  ' }), 'title');
  assert.equal(rowProblem({ ...confirmRow(row), time: '25:00' }), 'time');
});
check('buildImportPlan: tasks vs exams, only ticked + ready rows, no-class days never saved', () => {
  const rows = [
    { id: '1', kind: 'assignment', title: 'PS 1', date: '2026-09-04', time: '23:59', minutes: 120, flags: [], include: true },
    { id: '2', kind: 'quiz', title: 'Quiz 1', date: '2026-09-11', time: null, minutes: 0, flags: [], include: true },
    { id: '3', kind: 'noClass', title: 'Labor Day', date: '2026-09-07', flags: [], include: true },
    { id: '4', kind: 'assignment', title: 'Skip me', date: '2026-09-08', minutes: 60, flags: [], include: false },
    { id: '5', kind: 'reading', title: 'Unsure', date: '2026-09-08', minutes: 45, flags: ['year'], include: true },
  ];
  const plan = buildImportPlan(rows, [{ include: true, days: [1, 3], start: '09:00', end: '09:50' }, { include: true, days: [2], start: '10:00', end: '09:00' }]);
  assert.deepEqual(plan.tasks, [{ name: 'PS 1', due_date: '2026-09-04', minutes_requested: 120, notes: '', due_time: '23:59' }]);
  assert.deepEqual(plan.exams, [{ name: 'Quiz 1', exam_date: '2026-09-11', start_time: null }]);
  assert.equal(plan.meetings.length, 1);
});

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
