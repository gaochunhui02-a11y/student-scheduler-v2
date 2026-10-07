// V3 foundation: date-only arithmetic (timezone/DST safety), hash routes,
// the Demo Mode seed's integrity, and the in-memory demo client.
// Run with `npm test` or `node tests/v3-foundation.test.js`.

import assert from 'node:assert/strict';
import {
  isValidDateStr, todayStr, addDays, diffDays, dayOfWeek, startOfWeek, dateRange, addMonths, monthGrid, clockToMinutes, minutesToClockStr,
} from '../src/shared/dates.js';
import { parseHash, buildHash, ROUTES } from '../src/app/router.js';
import { buildDemoSeed, DEMO_USER_ID } from '../src/demo/demoSeed.js';
import { createMemoryClient } from '../src/demo/memoryClient.js';

let failures = 0;
async function check(label, fn) {
  try {
    await fn();
    console.log(`  PASS  ${label}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${label}`);
    console.log(`        ${e.message}`);
  }
}

console.log('\n=== dates.js ===');
await check('validates real calendar dates only', () => {
  assert.equal(isValidDateStr('2026-02-28'), true);
  assert.equal(isValidDateStr('2026-02-29'), false);
  assert.equal(isValidDateStr('2028-02-29'), true);
  assert.equal(isValidDateStr('2026-13-01'), false);
  assert.equal(isValidDateStr('2026-1-01'), false);
  assert.equal(isValidDateStr(null), false);
});
await check('addDays crosses month/year/leap boundaries', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-10-07', 0), '2026-10-07');
});
await check('DST transition days still count as exactly one day', () => {
  // US DST starts 2026-03-08, ends 2026-11-01; EU 2026-03-29 / 2026-10-25.
  assert.equal(addDays('2026-03-07', 1), '2026-03-08');
  assert.equal(addDays('2026-03-08', 1), '2026-03-09');
  assert.equal(addDays('2026-10-31', 2), '2026-11-02');
  assert.equal(diffDays('2026-03-01', '2026-04-01'), 31);
  assert.equal(diffDays('2026-10-20', '2026-11-03'), 14);
  assert.equal(dateRange('2026-03-07', '2026-03-10').length, 4);
});
await check('results do not depend on the process timezone', () => {
  // dates.js uses UTC internally; TZ only matters for todayStr()
  const before = process.env.TZ;
  ['America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Kiritimati', 'UTC'].forEach((tz) => {
    process.env.TZ = tz;
    assert.equal(addDays('2026-11-01', 1), '2026-11-02');
    assert.equal(dayOfWeek('2026-10-07'), 3);
  });
  process.env.TZ = before;
});
await check('todayStr uses the local calendar date, not UTC', () => {
  const late = new Date(2026, 9, 7, 23, 50); // local 23:50
  assert.equal(todayStr(late), '2026-10-07');
  const early = new Date(2026, 9, 8, 0, 5);
  assert.equal(todayStr(early), '2026-10-08');
});
await check('weeks start on Monday', () => {
  assert.equal(startOfWeek('2026-10-07'), '2026-10-05'); // Wed -> Mon
  assert.equal(startOfWeek('2026-10-11'), '2026-10-05'); // Sun -> previous Mon
  assert.equal(startOfWeek('2026-10-05'), '2026-10-05');
});
await check('dateRange is inclusive and empty for inverted ranges', () => {
  assert.deepEqual(dateRange('2026-10-30', '2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  assert.deepEqual(dateRange('2026-11-02', '2026-10-30'), []);
});
await check('month helpers', () => {
  assert.equal(addMonths('2026-12-15', 1), '2027-01-01');
  assert.equal(addMonths('2026-01-31', -1), '2025-12-01');
  const grid = monthGrid('2026-10-07');
  assert.equal(grid.length, 42);
  assert.equal(grid[0].date, '2026-09-28');
  assert.equal(grid.filter((c) => c.inMonth).length, 31);
});
await check('clock conversion', () => {
  assert.equal(clockToMinutes('09:30:00'), 570);
  assert.equal(clockToMinutes('24:00'), null);
  assert.equal(minutesToClockStr(570), '09:30');
  assert.equal(minutesToClockStr(1445), '00:05');
});

console.log('\n=== router.js ===');
await check('parses and builds hash routes', () => {
  assert.deepEqual(parseHash('#/courses/abc-123'), { view: 'coursesView', slug: 'courses', param: 'abc-123' });
  assert.deepEqual(parseHash('#/home'), { view: 'analyticsView', slug: 'home', param: null });
  assert.equal(parseHash('#/nope'), null);
  assert.equal(parseHash(''), null);
  assert.equal(buildHash('coursesView', 'x1'), '#/courses/x1');
  assert.equal(buildHash('plannerForm'), '#/planner');
  Object.entries(ROUTES).forEach(([slug, view]) => assert.equal(parseHash(buildHash(view)).slug, slug));
});
await check('rejects unsafe route params', () => {
  assert.equal(parseHash('#/courses/<script>').param, null);
  assert.equal(parseHash('#/courses/a%22b').param, null);
});

console.log('\n=== demo seed ===');
const NOW = new Date(2026, 9, 7, 10, 30);
const seed = buildDemoSeed(NOW);
await check('every id is unique across all tables', () => {
  const ids = Object.values(seed).flat().map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});
await check('every row belongs to the demo user', () => {
  Object.entries(seed).forEach(([table, rows]) => rows.forEach((r) => assert.equal(table === 'profiles' ? r.id : r.user_id, DEMO_USER_ID, table)));
});
await check('foreign keys point at existing rows', () => {
  const byId = (table) => new Set(seed[table].map((r) => r.id));
  const fk = [
    ['study_subjects', 'schedule_id', 'schedules'], ['schedule_items', 'schedule_id', 'schedules'], ['classes', 'schedule_id', 'schedules'],
    ['schedule_items', 'source_subject_id', 'study_subjects'], ['study_subjects', 'course_id', 'courses'], ['courses', 'semester_id', 'semesters'],
    ['grade_items', 'category_id', 'grade_categories'], ['grade_items', 'course_id', 'courses'], ['exam_topics', 'exam_id', 'exams'],
    ['task_dependencies', 'task_id', 'study_subjects'], ['task_dependencies', 'depends_on_id', 'study_subjects'], ['board_nodes', 'board_id', 'boards'],
    ['board_edges', 'source_node_id', 'board_nodes'], ['board_nodes', 'linked_study_subject_id', 'study_subjects'], ['resources', 'course_id', 'courses'],
    ['focus_sessions', 'task_id', 'study_subjects'], ['class_series', 'course_id', 'courses'], ['study_subjects', 'recurrence_rule_id', 'task_recurrence_rules'],
  ];
  fk.forEach(([table, col, parent]) => {
    const ids = byId(parent);
    seed[table].forEach((r) => {
      if (r[col] !== null && r[col] !== undefined) assert.ok(ids.has(r[col]), `${table}.${col} -> ${parent}`);
    });
  });
});
await check('one schedule per date, and today exists', () => {
  const dates = seed.schedules.map((s) => s.for_date);
  assert.equal(new Set(dates).size, dates.length);
  assert.ok(dates.includes('2026-10-07'));
});
await check('no two timed blocks overlap on any day, for any weekday/time of day', () => {
  for (let d = 4; d <= 10; d += 1) {
    [6, 9, 12, 15, 19, 23].forEach((hour) => {
      const s = buildDemoSeed(new Date(2026, 9, d, hour, 10));
      const bySchedule = {};
      s.schedule_items.filter((b) => b.item_type !== 'free').forEach((b) => { (bySchedule[b.schedule_id] ||= []).push(b); });
      Object.values(bySchedule).forEach((blocks) => {
        const sorted = blocks.slice().sort((a, b) => a.start_minutes - b.start_minutes);
        for (let i = 1; i < sorted.length; i += 1) {
          assert.ok(sorted[i].start_minutes >= sorted[i - 1].end_minutes, `day ${d} ${hour}h: ${sorted[i - 1].name} overlaps ${sorted[i].name}`);
        }
        sorted.forEach((b) => assert.ok(b.end_minutes <= 1440, `day ${d} ${hour}h: ${b.name} runs past midnight`));
      });
    });
  }
});
await check('exactly one current semester and a dependency chain exists', () => {
  assert.equal(seed.semesters.filter((s) => s.is_current).length, 1);
  assert.ok(seed.task_dependencies.length >= 4);
});
await check('seed is deterministic for the same moment', () => {
  assert.deepEqual(buildDemoSeed(NOW), seed);
});
await check('resources only use http(s) URLs', () => {
  seed.resources.forEach((r) => assert.match(r.url, /^https?:\/\//));
});

console.log('\n=== memory client ===');
const client = createMemoryClient({ seed: () => buildDemoSeed(NOW), session: { user: { id: DEMO_USER_ID } } });
await check('select with eq/order/limit', async () => {
  const { data, error } = await client.from('courses').select('*').eq('user_id', DEMO_USER_ID).order('sort_order', { ascending: false }).limit(2);
  assert.equal(error, null);
  assert.equal(data.length, 2);
  assert.ok(data[0].sort_order > data[1].sort_order);
});
await check('insert applies defaults and returns rows', async () => {
  const { data } = await client.from('courses').insert({ user_id: DEMO_USER_ID, name: 'Test course' }).select().single();
  assert.equal(data.archived, false);
  assert.equal(data.notes, '');
  assert.ok(data.id);
});
await check('unique (user, for_date) on schedules is enforced', async () => {
  const { error } = await client.from('schedules').insert({ user_id: DEMO_USER_ID, for_date: '2026-10-07' });
  assert.equal(error && error.code, '23505');
});
await check('delete cascades to children and nulls optional references', async () => {
  const exam = seed.exams[0];
  await client.from('exams').delete().eq('id', exam.id);
  const { data: topics } = await client.from('exam_topics').select('*').eq('exam_id', exam.id);
  assert.equal(topics.length, 0);
  const course = seed.courses[0];
  await client.from('courses').delete().eq('id', course.id);
  const { data: tasks } = await client.from('study_subjects').select('*').eq('course_id', course.id);
  assert.equal(tasks.length, 0);
  const { data: grades } = await client.from('grade_items').select('*').eq('course_id', course.id);
  assert.equal(grades.length, 0);
});
await check('embedded many-to-one select (schedules(for_date))', async () => {
  const { data } = await client.from('study_subjects').select('*, schedules(for_date)').limit(1);
  assert.match(data[0].schedules.for_date, /^\d{4}-\d{2}-\d{2}$/);
});
await check('missing tables report a relation error (pre-migration simulation)', async () => {
  const c = createMemoryClient({ seed: () => ({}), session: {}, missingTables: new Set(['courses']) });
  const { error } = await c.from('courses').select('id').limit(0);
  assert.equal(error.code, '42P01');
});

console.log('\n------------------------');
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
