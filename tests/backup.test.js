// V3-O backup / restore. Run: node tests/backup.test.js

import assert from 'node:assert/strict';
import { restoreAvailability, buildBackup, parseBackup, validateBackup, planRestore, BACKUP_TABLES, backupFilename } from '../src/backup/backupModel.js';

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

let n = 0;
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const newIds = () => { let k = 0; return () => `11111111-1111-4111-8111-${String(++k).padStart(12, '0')}`; };
const sem = { id: uid(), name: 'Fall', start_date: '2026-09-01', end_date: '2026-12-18', breaks: [], is_current: true };
const course = { id: uid(), semester_id: sem.id, name: 'Calculus', code: 'MATH 1', color: '#3b6fe0' };
const sched = { id: uid(), for_date: '2026-10-07' };
const sched2 = { id: uid(), for_date: '2026-10-08' };
const subj = { id: uid(), schedule_id: sched.id, name: 'Essay', minutes_requested: 60, course_id: course.id };
const subj2 = { id: uid(), schedule_id: sched2.id, name: 'Essay part 2', minutes_requested: 30, origin_subject_id: subj.id };
const item = { id: uid(), schedule_id: sched.id, item_type: 'study', name: 'Essay', start_minutes: 600, end_minutes: 660, source_subject_id: subj.id };
const dep = { id: uid(), task_id: subj2.id, depends_on_id: subj.id };
const backup = buildBackup({ tables: { semesters: [sem], courses: [course], schedules: [sched, sched2], study_subjects: [subj2, subj], schedule_items: [item], task_dependencies: [dep], resources: [{ id: uid(), course_id: course.id, title: 'Syllabus', url: 'https://x.edu/s.pdf' }] }, exportedAt: '2026-10-07T00:00:00Z' });

console.log('\n=== export + parse ===');
check('export is versioned and lists every table', () => {
  assert.equal(backup.version, 3);
  assert.equal(backup.format, 'student-scheduler-export');
  assert.deepEqual(Object.keys(backup.tables), BACKUP_TABLES);
  assert.equal(backupFilename('2026-10-07'), 'student-scheduler-backup-2026-10-07.json');
});
check('malformed files are rejected with a reason', () => {
  assert.equal(parseBackup('').error, 'backup.errEmpty');
  assert.equal(parseBackup('{not json').error, 'backup.errNotJson');
  assert.equal(parseBackup('[]').error, 'backup.errFormat');
  assert.equal(parseBackup(JSON.stringify({ format: 'other', version: 3, tables: {} })).error, 'backup.errFormat');
  assert.equal(parseBackup(JSON.stringify({ format: 'student-scheduler-export', version: 99, tables: {} })).error, 'backup.errVersion');
  assert.equal(parseBackup(JSON.stringify({ format: 'student-scheduler-export', version: 3, tables: [] })).error, 'backup.errFormat');
  assert.equal(parseBackup(JSON.stringify(backup)).ok, true);
});
check('V2 (version 1) exports are still accepted', () => {
  assert.equal(parseBackup(JSON.stringify({ format: 'student-scheduler-export', version: 1, tables: { schedules: [] } })).ok, true);
});

console.log('\n=== validation ===');
check('a clean backup validates; unknown tables/columns are ignored', () => {
  const extra = { ...backup, tables: { ...backup.tables, secrets: [{ a: 1 }], courses: [{ ...course, evil_column: 'x' }] } };
  const v = validateBackup(extra);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.deepEqual(v.ignoredTables, ['secrets']);
  assert.equal('evil_column' in v.tables.courses[0], false);
});
check('bad types, missing required fields, bad ids and unsafe URLs fail validation', () => {
  const bad = { ...backup, tables: {
    courses: [{ id: 'not-a-uuid', name: 'x' }],
    schedules: [{ id: uid() }],
    resources: [{ id: uid(), course_id: course.id, title: 'x', url: 'javascript:alert(1)' }],
    schedule_items: [{ ...item, item_type: 'party' }],
    study_subjects: 'nope',
  } };
  const v = validateBackup(bad);
  assert.equal(v.ok, false);
  const problems = v.errors.map((e) => `${e.table}.${e.column}:${e.problem}`);
  assert.ok(problems.includes('courses.id:invalid'));
  assert.ok(problems.includes('schedules.for_date:missing'));
  assert.ok(problems.includes('resources.url:invalid'));
  assert.ok(problems.includes('schedule_items.item_type:invalid'));
  assert.ok(problems.includes('study_subjects.:not_a_list'));
});
check('jsonb arrays must have their real shapes (tags, weekdays, breaks)', () => {
  const v1 = validateBackup({ ...backup, tables: {
    study_subjects: [{ ...subj, tags: [{ evil: 1 }] }],
    class_series: [{ id: uid(), name: 'x', days_of_week: [9], start_time: '09:00', end_time: '10:00', start_date: '2026-10-01', end_date: '2026-10-30' }],
    semesters: [{ ...sem, breaks: [{ name: 'b', start_date: 'soon' }] }],
  } });
  const problems = v1.errors.map((e) => `${e.table}.${e.column}`);
  assert.ok(problems.includes('study_subjects.tags'));
  assert.ok(problems.includes('class_series.days_of_week'));
  assert.ok(problems.includes('semesters.breaks'));
  const ok = validateBackup({ ...backup, tables: { semesters: [{ ...sem, breaks: [{ name: 'Fall break', start_date: '2026-10-20', end_date: '2026-10-24' }] }], study_subjects: [{ ...subj, tags: ['exam', 'reading'] }] } });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
});
check('duplicate ids are caught', () => {
  const v = validateBackup({ ...backup, tables: { schedules: [sched, sched] } });
  assert.ok(v.errors.some((e) => e.problem === 'duplicate'));
});

console.log('\n=== restore plan ===');
const v = validateBackup(backup);
const all = BACKUP_TABLES;
check('everything gets new ids and consistent references, owned by the user', () => {
  const plan = planRestore({ tables: v.tables, existing: { scheduleDates: new Set(), courses: [], semesters: [] }, availableTables: all, newId: newIds(), userId: 'me' });
  const ins = plan.inserts;
  const allRows = Object.values(ins).flat();
  assert.ok(allRows.every((r) => r.user_id === 'me'));
  assert.ok(allRows.every((r) => r.id.startsWith('11111111')));
  const c = ins.courses[0];
  assert.equal(c.semester_id, ins.semesters[0].id);
  const root = ins.study_subjects.find((r) => r.name === 'Essay');
  const chunk = ins.study_subjects.find((r) => r.name === 'Essay part 2');
  assert.equal(chunk.origin_subject_id, root.id); // root inserted first despite file order
  assert.equal(ins.schedule_items[0].source_subject_id, root.id);
  assert.equal(ins.task_dependencies[0].depends_on_id, root.id);
  assert.equal(ins.semesters[0].is_current, false);
});
check('existing days are skipped with everything on them; nothing is mixed in', () => {
  const plan = planRestore({ tables: v.tables, existing: { scheduleDates: new Set(['2026-10-07']), courses: [], semesters: [] }, availableTables: all, newId: newIds(), userId: 'me' });
  assert.equal(plan.conflicts.days, 1);
  assert.equal(plan.inserts.schedules.length, 1);
  assert.equal(plan.inserts.study_subjects.length, 1); // part 2 kept, origin nulled
  assert.equal(plan.inserts.study_subjects[0].origin_subject_id, undefined); // omitted -> null in the DB
  assert.equal(plan.inserts.schedule_items, undefined);
  assert.equal(plan.inserts.task_dependencies, undefined); // its prerequisite was skipped
});
check('same-name courses link to the existing course instead of duplicating', () => {
  const plan = planRestore({ tables: v.tables, existing: { scheduleDates: new Set(), courses: [{ id: 'existing-course', name: 'calculus', code: 'math 1' }], semesters: [] }, availableTables: all, newId: newIds(), userId: 'me' });
  assert.equal(plan.conflicts.courses, 1);
  assert.equal(plan.inserts.courses, undefined);
  assert.equal(plan.inserts.resources[0].course_id, 'existing-course');
});
check('restoring a backup of this same account adds nothing twice', () => {
  const ids = Object.fromEntries(Object.entries(v.tables).map(([tb, rows]) => [tb, new Set(rows.map((r) => r.id))]));
  const dates = new Set(v.tables.schedules.map((r) => r.for_date));
  const plan = planRestore({ tables: v.tables, existing: { scheduleDates: dates, courses: [], semesters: [], ids }, availableTables: all, newId: newIds(), userId: 'me' });
  assert.deepEqual(plan.inserts, {});
  assert.ok(plan.conflicts.existing > 0);
});
check('a record deleted since the backup comes back, linked to the records still there', () => {
  const ids = { semesters: new Set([sem.id]), courses: new Set([course.id]), resources: new Set() };
  const plan = planRestore({ tables: { semesters: v.tables.semesters, courses: v.tables.courses, resources: v.tables.resources }, existing: { scheduleDates: new Set(), courses: [], semesters: [], ids }, availableTables: all, newId: newIds(), userId: 'me' });
  assert.equal(plan.inserts.resources.length, 1);
  assert.equal(plan.inserts.resources[0].course_id, course.id);
  assert.equal(plan.inserts.courses, undefined);
});
check('V4 spaces are backed up first and links are remapped; same-name spaces are reused', () => {
  const sp = { id: uid(), name: 'School', icon: 'school', color: '#3b6fe0' };
  const tables = { spaces: [sp], courses: [{ ...course, space_id: sp.id }] };
  const v4 = validateBackup({ ...backup, tables });
  assert.equal(v4.ok, true, JSON.stringify(v4.errors));
  assert.equal(BACKUP_TABLES[0], 'spaces');
  const fresh = planRestore({ tables: v4.tables, existing: { scheduleDates: new Set(), courses: [], semesters: [] }, availableTables: all, newId: newIds(), userId: 'me' });
  assert.equal(fresh.inserts.courses[0].space_id, fresh.inserts.spaces[0].id);
  const reuse = planRestore({ tables: v4.tables, existing: { scheduleDates: new Set(), courses: [], semesters: [], spaces: [{ id: 'mine', name: 'school' }] }, availableTables: all, newId: newIds(), userId: 'me' });
  assert.equal(reuse.inserts.spaces, undefined);
  assert.equal(reuse.conflicts.spaces, 1);
  assert.equal(reuse.inserts.courses[0].space_id, 'mine');
  const v3db = restoreAvailability({ semesters: 1, courses: 1, courseLinks: 1 });
  assert.ok(!v3db.availableTables.includes('spaces'));
  assert.deepEqual(v3db.unavailableColumns.courses, ['space_id']);
});
check('a bad space icon is rejected', () => {
  const bad = validateBackup({ ...backup, tables: { spaces: [{ id: uid(), name: 'x', icon: '<svg onload=1>' }] } });
  assert.ok(bad.errors.some((e) => e.table === 'spaces' && e.column === 'icon'));
});
check('tables the database does not have yet are reported, not written', () => {
  const plan = planRestore({ tables: v.tables, existing: { scheduleDates: new Set(), courses: [], semesters: [] }, availableTables: ['schedules', 'study_subjects', 'schedule_items'], newId: newIds(), userId: 'me' });
  assert.ok(plan.unavailable.includes('courses'));
  assert.equal(plan.inserts.study_subjects[0].course_id, undefined);
});

console.log('\n------------------------');
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
