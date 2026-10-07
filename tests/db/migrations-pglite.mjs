// Applies the real schema + every migration to a throwaway in-memory
// Postgres 17 (PGlite, WebAssembly) with a minimal Supabase auth shim
// (auth.users, auth.uid(), an "authenticated" role), then probes RLS,
// ownership triggers, constraints and cascades as two different users.
// Never touches any real database.
//
// PGlite is deliberately NOT a project dependency (keeps installs and
// Vercel builds lean). Run with:
//   npm i --no-save @electric-sql/pglite && node tests/db/migrations-pglite.mjs
//
// Limits: stock Postgres, not Supabase — Supabase's own grants, auth
// schema and extensions are approximated by the shim below.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../supabase', import.meta.url));
const db = new PGlite();
let pass = 0, fail = 0;
const ok = (label) => { pass += 1; console.log(`  PASS  ${label}`); };
const bad = (label, why) => { fail += 1; console.log(`  FAIL  ${label}\n        ${why}`); };

async function expectOk(label, sql, params) {
  try { const r = await db.query(sql, params); ok(label); return r; } catch (e) { bad(label, e.message); return null; }
}
async function expectErr(label, sql, params, match) {
  try { await db.query(sql, params); bad(label, 'expected an error, statement succeeded'); }
  catch (e) { if (match && !match.test(e.message + ' ' + (e.code || ''))) bad(label, `wrong error: ${e.message}`); else ok(`${label}  [${e.code || ''}: ${e.message.slice(0, 70)}]`); }
}
async function rows(sql, params) { return (await db.query(sql, params)).rows; }

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
async function as(user) { await db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub', '${user}', false);`); }
async function asAdmin() { await db.exec(`reset role;`); }

// ---------- Supabase shim ----------
await db.exec(`
  create schema auth;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create role authenticated nologin;
  create role anon nologin;
  grant usage on schema public, auth to authenticated, anon;
  grant execute on function auth.uid() to authenticated, anon;
  alter default privileges in schema public grant all on tables to authenticated;
  alter default privileges in schema public grant all on sequences to authenticated;
  alter default privileges in schema public grant execute on functions to authenticated;
`);

console.log('\n=== apply schema + migrations ===');
const files = readdirSync(`${ROOT}/migrations`).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
try { await db.exec(readFileSync(`${ROOT}/schema.sql`, 'utf8')); ok('schema.sql'); } catch (e) { bad('schema.sql', e.message); }
for (const f of files) {
  try { await db.exec(readFileSync(`${ROOT}/migrations/${f}`, 'utf8')); ok(f); } catch (e) { bad(f, e.message); }
}
console.log('\n=== re-apply V3 migrations (idempotent) ===');
for (const f of files.filter((x) => Number(x.slice(0, 4)) >= 10)) {
  try { await db.exec(readFileSync(`${ROOT}/migrations/${f}`, 'utf8')); ok(`${f} again`); } catch (e) { bad(`${f} again`, e.message); }
}

console.log('\n=== users ===');
await expectOk('create users A and B (profile trigger)', `insert into auth.users (id, email, raw_user_meta_data) values ($1, 'a@x.test', '{"name":"A"}'), ($2, 'b@x.test', '{"name":"B"}')`, [A, B]);
const prof = await rows('select id, preferences from public.profiles order by id');
prof.length === 2 && JSON.stringify(prof[0].preferences) === '{}' ? ok('profiles created, preferences default {}') : bad('profiles', JSON.stringify(prof));

console.log('\n=== user A creates data ===');
await as(A);
const ins = async (label, sql, params) => { const r = await expectOk(label, sql + ' returning id', params); return r && r.rows[0] && r.rows[0].id; };
const semA = await ins('A semester', `insert into public.semesters (user_id, name, start_date, end_date, is_current) values ($1, 'Fall', '2026-09-01', '2026-12-18', true)`, [A]);
const courseA = await ins('A course', `insert into public.courses (user_id, semester_id, name, code, color) values ($1, $2, 'Calculus', 'M1', '#3b6fe0')`, [A, semA]);
const schedA = await ins('A schedule (V2 table)', `insert into public.schedules (user_id, for_date) values ($1, '2026-10-07')`, [A]);
const taskA = await ins('A task with course_id', `insert into public.study_subjects (user_id, schedule_id, name, minutes_requested, course_id) values ($1, $2, 'Essay', 60, $3)`, [A, schedA, courseA]);
const taskA2 = await ins('A second task', `insert into public.study_subjects (user_id, schedule_id, name, minutes_requested) values ($1, $2, 'Outline', 30)`, [A, schedA]);
await ins('V2-shaped insert still works (no V3 columns)', `insert into public.study_subjects (user_id, schedule_id, name, minutes_requested, priority, tags) values ($1, $2, 'Old style', 20, 'high', '[]')`, [A, schedA]);
const itemA = await ins('A schedule item', `insert into public.schedule_items (user_id, schedule_id, item_type, name, start_minutes, end_minutes, source_subject_id) values ($1, $2, 'study', 'Essay', 600, 660, $3)`, [A, schedA, taskA]);
const catA = await ins('A grade category', `insert into public.grade_categories (user_id, course_id, name, weight) values ($1, $2, 'Exams', 60)`, [A, courseA]);
await ins('A grade item', `insert into public.grade_items (user_id, course_id, category_id, name, earned_points, possible_points) values ($1, $2, $3, 'Midterm', 86, 100)`, [A, courseA, catA]);
const examA = await ins('A exam', `insert into public.exams (user_id, course_id, name, exam_date) values ($1, $2, 'Final', '2026-12-10')`, [A, courseA]);
await ins('A exam topic', `insert into public.exam_topics (user_id, exam_id, name) values ($1, $2, 'Limits')`, [A, examA]);
await ins('A resource', `insert into public.resources (user_id, course_id, task_id, title, url) values ($1, $2, $3, 'Syllabus', 'https://x.edu/s.pdf')`, [A, courseA, taskA]);
await ins('A focus session', `insert into public.focus_sessions (user_id, schedule_item_id, task_id, course_id, started_at, actual_minutes) values ($1, $2, $3, $4, now(), 25)`, [A, itemA, taskA, courseA]);
await ins('A dependency (Essay after Outline)', `insert into public.task_dependencies (user_id, task_id, depends_on_id) values ($1, $2, $3)`, [A, taskA, taskA2]);
const ruleA = await ins('A recurrence rule', `insert into public.task_recurrence_rules (user_id, name, minutes, days_of_week, start_date, end_date) values ($1, 'Reading', 30, '[1,3]', '2026-10-01', '2026-12-01')`, [A]);
await expectOk('A updates own preferences', `update public.profiles set preferences = '{"maxDailyStudyMinutes":240}' where id = $1`, [A]);

console.log('\n=== user B cannot see or touch A ===');
await as(B);
for (const tbl of ['semesters', 'courses', 'schedules', 'study_subjects', 'schedule_items', 'grade_categories', 'grade_items', 'exams', 'exam_topics', 'resources', 'focus_sessions', 'task_dependencies', 'task_recurrence_rules']) {
  const n = (await rows(`select count(*)::int as n from public.${tbl}`))[0].n;
  n === 0 ? ok(`B sees 0 rows in ${tbl}`) : bad(`B sees A's ${tbl}`, `${n} rows visible`);
}
const pv = await rows('select id from public.profiles');
pv.length === 1 && pv[0].id === B ? ok('B sees only own profile') : bad('profiles visible to B', JSON.stringify(pv));
const upd = await db.query(`update public.courses set name = 'hacked' where id = $1`, [courseA]);
upd.affectedRows === 0 ? ok('B update of A course affects 0 rows') : bad('B updated A course', String(upd.affectedRows));
const del = await db.query(`delete from public.exams where id = $1`, [examA]);
del.affectedRows === 0 ? ok('B delete of A exam affects 0 rows') : bad('B deleted A exam', String(del.affectedRows));
await expectErr('B cannot insert a row owned by A', `insert into public.courses (user_id, name) values ($1, 'x')`, [A], /row-level security/);

console.log('\n=== ownership triggers: B cannot point at A records ===');
const schedB = await ins('B schedule', `insert into public.schedules (user_id, for_date) values ($1, '2026-10-07')`, [B]);
const taskB = await ins('B task', `insert into public.study_subjects (user_id, schedule_id, name, minutes_requested) values ($1, $2, 'Mine', 30)`, [B, schedB]);
await expectErr('B task -> A course', `insert into public.study_subjects (user_id, schedule_id, name, minutes_requested, course_id) values ($1, $2, 'x', 30, $3)`, [B, schedB, courseA], /42501|does not belong/);
await expectErr('B updates own task to A course', `update public.study_subjects set course_id = $2 where id = $1`, [taskB, courseA], /42501|does not belong/);
await expectErr('B course -> A semester', `insert into public.courses (user_id, semester_id, name) values ($1, $2, 'x')`, [B, semA], /42501|does not belong/);
await expectErr('B exam -> A course', `insert into public.exams (user_id, course_id, name, exam_date) values ($1, $2, 'x', '2026-12-01')`, [B, courseA], /42501|does not belong/);
await expectErr('B topic -> A exam', `insert into public.exam_topics (user_id, exam_id, name) values ($1, $2, 'x')`, [B, examA], /42501|does not belong/);
await expectErr('B grade item -> A course', `insert into public.grade_items (user_id, course_id, name, possible_points) values ($1, $2, 'x', 10)`, [B, courseA], /42501|does not belong|violates foreign key/);
await expectErr('B resource -> A task', `insert into public.resources (user_id, task_id, title, url) values ($1, $2, 'x', 'https://a.b/c')`, [B, taskA], /42501|does not belong/);
await expectErr('B focus session -> A block', `insert into public.focus_sessions (user_id, schedule_item_id, started_at) values ($1, $2, now())`, [B, itemA], /42501|does not belong/);
await expectErr('B dependency on A task', `insert into public.task_dependencies (user_id, task_id, depends_on_id) values ($1, $2, $3)`, [B, taskB, taskA], /42501|does not belong/);
await expectErr('B task -> A recurrence rule', `insert into public.study_subjects (user_id, schedule_id, name, minutes_requested, recurrence_rule_id, recurrence_date) values ($1, $2, 'x', 30, $3, '2026-10-07')`, [B, schedB, ruleA], /42501|does not belong/);
await expectErr('B class series -> A course', `insert into public.class_series (user_id, name, days_of_week, start_time, end_time, start_date, end_date, course_id) values ($1, 'x', '[1]', '09:00', '10:00', '2026-10-01', '2026-11-01', $2)`, [B, courseA], /42501|does not belong/);

console.log('\n=== integrity rules (as A) ===');
await as(A);
await expectErr('dependency cycle rejected', `insert into public.task_dependencies (user_id, task_id, depends_on_id) values ($1, $2, $3)`, [A, taskA2, taskA], /cycle|depend/i);
await expectErr('self-dependency rejected', `insert into public.task_dependencies (user_id, task_id, depends_on_id) values ($1, $2, $2)`, [A, taskA], null);
await expectErr('javascript: resource URL rejected', `insert into public.resources (user_id, title, url) values ($1, 'x', 'javascript:alert(1)')`, [A], /check/);
await expectErr('semester ending before it starts rejected', `insert into public.semesters (user_id, name, start_date, end_date) values ($1, 'x', '2026-12-01', '2026-09-01')`, [A], /check/);
await expectErr('second current semester rejected', `insert into public.semesters (user_id, name, start_date, end_date, is_current) values ($1, 'y', '2027-01-01', '2027-05-01', true)`, [A], /duplicate|unique/);
await expectErr('bad course colour rejected', `insert into public.courses (user_id, name, color) values ($1, 'x', 'red;}')`, [A], /check/);
await expectErr('preferences must be an object', `update public.profiles set preferences = '[1]' where id = $1`, [A], /check/);
const course2 = await ins('A second course', `insert into public.courses (user_id, name) values ($1, 'Bio')`, [A]);
await expectErr('grade item category from another course rejected', `insert into public.grade_items (user_id, course_id, category_id, name, possible_points) values ($1, $2, $3, 'x', 10)`, [A, course2, catA], null);
await ins('recurring occurrence created', `insert into public.study_subjects (user_id, schedule_id, name, minutes_requested, recurrence_rule_id, recurrence_date) values ($1, $2, 'Reading', 30, $3, '2026-10-07')`, [A, schedA, ruleA]);
await expectErr('duplicate occurrence of a rule rejected', `insert into public.study_subjects (user_id, schedule_id, name, minutes_requested, recurrence_rule_id, recurrence_date) values ($1, $2, 'Reading', 30, $3, '2026-10-07')`, [A, schedA, ruleA], /duplicate|unique/);

console.log('\n=== V4 spaces (0018) ===');
await as(A);
const spaceA = await ins('A space', `insert into public.spaces (user_id, name, icon, color) values ($1, 'School', 'school', '#3b6fe0')`, [A]);
const course3 = await ins('A course in a space', `insert into public.courses (user_id, name, space_id) values ($1, 'Physics', $2)`, [A, spaceA]);
const spacedTask = await ins('A task in a space', `insert into public.study_subjects (user_id, schedule_id, name, minutes_requested, space_id) values ($1, $2, 'Lab', 30, $3)`, [A, schedA, spaceA]);
await ins('A board in a space', `insert into public.boards (user_id, title, space_id) values ($1, 'Portfolio', $2)`, [A, spaceA]);
await expectErr('space icon must be a key', `insert into public.spaces (user_id, name, icon) values ($1, 'x', '<svg>')`, [A], /check/);
await expectErr('space colour must be hex', `insert into public.spaces (user_id, name, color) values ($1, 'x', 'red')`, [A], /check/);
await expectErr('blank space name rejected', `insert into public.spaces (user_id, name) values ($1, '   ')`, [A], /check/);
await as(B);
const bs = (await rows('select count(*)::int n from public.spaces'))[0].n;
bs === 0 ? ok("B sees 0 of A's spaces") : bad('B sees A spaces', String(bs));
await expectErr('B task -> A space', `insert into public.study_subjects (user_id, schedule_id, name, minutes_requested, space_id) values ($1, $2, 'x', 30, $3)`, [B, schedB, spaceA], /42501|does not belong/);
await expectErr('B course -> A space', `insert into public.courses (user_id, name, space_id) values ($1, 'x', $2)`, [B, spaceA], /42501|does not belong/);
await expectErr('B board -> A space', `insert into public.boards (user_id, title, space_id) values ($1, 'x', $2)`, [B, spaceA], /42501|does not belong/);
const bu = await db.query(`update public.spaces set name = 'hacked' where id = $1`, [spaceA]);
bu.affectedRows === 0 ? ok("B rename of A's space affects 0 rows") : bad('B renamed A space', String(bu.affectedRows));
await as(A);
await expectOk('A deletes the space', `delete from public.spaces where id = $1`, [spaceA]);
const afterSpace = await rows(`select (select space_id from public.courses where id = $1) as c, (select space_id from public.study_subjects where id = $2) as t, (select count(*)::int from public.study_subjects where id = $2) as n`, [course3, spacedTask]);
afterSpace[0].c === null && afterSpace[0].t === null && afterSpace[0].n === 1 ? ok('deleting a space keeps its course and task (space_id -> null)') : bad('space delete', JSON.stringify(afterSpace));

console.log('\n=== V4 projects + universal tasks (0019, 0020) ===');
await as(A);
const spaceW = await ins('A work space', `insert into public.spaces (user_id, name, icon) values ($1, 'Work', 'briefcase')`, [A]);
const projA = await ins('A project in a space', `insert into public.projects (user_id, space_id, title, status, priority, start_date, due_date) values ($1, $2, 'Portfolio', 'active', 'high', '2026-10-01', '2026-11-30')`, [A, spaceW]);
const projA2 = await ins('A second project', `insert into public.projects (user_id, title) values ($1, 'Move to Tokyo')`, [A]);
const msA = await ins('A milestone', `insert into public.project_milestones (user_id, project_id, title, due_date) values ($1, $2, 'Prototype', '2026-10-25')`, [A, projA]);
const msOther = await ins('A milestone on the other project', `insert into public.project_milestones (user_id, project_id, title) values ($1, $2, 'Visa')`, [A, projA2]);
const ptask = await ins('project task with NO course', `insert into public.study_subjects (user_id, schedule_id, name, minutes_requested, project_id, project_milestone_id, due_time, start_time, status_override) values ($1, $2, 'Homepage', 90, $3, $4, '23:59', '14:00', 'in_progress')`, [A, schedA, projA, msA]);
const plainTask = await ins('generic task with no course, project or space', `insert into public.study_subjects (user_id, schedule_id, name, minutes_requested) values ($1, $2, 'Groceries', 20)`, [A, schedA]);
const v3row = await rows(`select project_id, project_milestone_id, due_time, start_time, status_override, project_sort from public.study_subjects where id = $1`, [plainTask]);
JSON.stringify(v3row[0]) === JSON.stringify({ project_id: null, project_milestone_id: null, due_time: null, start_time: null, status_override: null, project_sort: 0 }) ? ok('V3-shaped task gets null / 0 defaults for every V4 column') : bad('V3-shaped defaults', JSON.stringify(v3row));
await expectErr('task milestone from a different project rejected', `update public.study_subjects set project_milestone_id = $2 where id = $1`, [ptask, msOther], /23514|milestone must belong/);
await expectErr('bad project status rejected', `insert into public.projects (user_id, title, status) values ($1, 'x', 'done')`, [A], /check/);
await expectErr('project due before start rejected', `insert into public.projects (user_id, title, start_date, due_date) values ($1, 'x', '2026-12-01', '2026-11-01')`, [A], /check/);
await expectErr('manual progress over 100 rejected', `insert into public.projects (user_id, title, progress_mode, manual_progress) values ($1, 'x', 'manual', 120)`, [A], /check/);
await expectErr('blank project title rejected', `insert into public.projects (user_id, title) values ($1, '  ')`, [A], /check/);
await expectErr('bad milestone status rejected', `insert into public.project_milestones (user_id, project_id, title, status) values ($1, $2, 'x', 'finished')`, [A, projA], /check/);
await expectErr('status override limited to in_progress/deferred', `update public.study_subjects set status_override = 'done' where id = $1`, [ptask], /check/);
await as(B);
for (const tbl of ['projects', 'project_milestones']) {
  const n = (await rows(`select count(*)::int n from public.${tbl}`))[0].n;
  n === 0 ? ok(`B sees 0 rows in ${tbl}`) : bad(`B sees A's ${tbl}`, String(n));
}
const bp = await db.query(`update public.projects set title = 'hacked' where id = $1`, [projA]);
bp.affectedRows === 0 ? ok("B update of A's project affects 0 rows") : bad('B updated A project', String(bp.affectedRows));
const bd = await db.query(`delete from public.projects where id = $1`, [projA]);
bd.affectedRows === 0 ? ok("B delete of A's project affects 0 rows") : bad('B deleted A project', String(bd.affectedRows));
await expectErr('B task -> A project', `insert into public.study_subjects (user_id, schedule_id, name, minutes_requested, project_id) values ($1, $2, 'x', 30, $3)`, [B, schedB, projA], /42501|does not belong/);
await expectErr('B milestone -> A project', `insert into public.project_milestones (user_id, project_id, title) values ($1, $2, 'x')`, [B, projA], /42501|does not belong/);
await expectErr('B project -> A space', `insert into public.projects (user_id, title, space_id) values ($1, 'x', $2)`, [B, spaceW], /42501|does not belong/);
await expectErr('B cannot insert a project owned by A', `insert into public.projects (user_id, title) values ($1, 'x')`, [A], /row-level security/);
await as(A);
await expectOk('A deletes a milestone', `delete from public.project_milestones where id = $1`, [msA]);
const afterMs = await rows(`select project_id, project_milestone_id from public.study_subjects where id = $1`, [ptask]);
afterMs[0].project_id === projA && afterMs[0].project_milestone_id === null ? ok('deleting a milestone keeps the task and its project') : bad('milestone delete', JSON.stringify(afterMs));
const ms2 = await ins('A another milestone', `insert into public.project_milestones (user_id, project_id, title) values ($1, $2, 'Launch')`, [A, projA]);
await expectOk('link the task to it', `update public.study_subjects set project_milestone_id = $2 where id = $1`, [ptask, ms2]);
await expectOk('A deletes the project', `delete from public.projects where id = $1`, [projA]);
const afterProj = await rows(`select id, project_id, project_milestone_id, name from public.study_subjects where id = $1`, [ptask]);
afterProj.length === 1 && afterProj[0].project_id === null && afterProj[0].project_milestone_id === null ? ok('deleting a project KEEPS its tasks (project_id and milestone -> null)') : bad('project delete lost task', JSON.stringify(afterProj));
const msLeft = (await rows(`select count(*)::int n from public.project_milestones where project_id = $1`, [projA]))[0].n;
msLeft === 0 ? ok("deleting a project removes its milestones") : bad('milestones remain', String(msLeft));

console.log('\n=== cascades ===');
await expectOk('A deletes the course', `delete from public.courses where id = $1`, [courseA]);
const t = await rows(`select course_id from public.study_subjects where id = $1`, [taskA]);
t.length === 1 && t[0].course_id === null ? ok('task kept, course_id set to null') : bad('task after course delete', JSON.stringify(t));
const g = (await rows(`select count(*)::int n from public.grade_items`))[0].n;
g === 0 ? ok('grade items removed with their course') : bad('grade items remain', String(g));
const ex = await rows(`select course_id from public.exams where id = $1`, [examA]);
ex.length === 1 && ex[0].course_id === null ? ok('exam kept, course_id set to null') : bad('exam after course delete', JSON.stringify(ex));
await expectOk('A deletes the semester', `delete from public.semesters where id = $1`, [semA]);
await asAdmin();
await expectOk('deleting user A cascades everything of A', `delete from auth.users where id = $1`, [A]);
const left = (await rows(`select (select count(*) from public.study_subjects where user_id = $1) + (select count(*) from public.exams where user_id = $1) + (select count(*) from public.task_recurrence_rules where user_id = $1) as n`, [A]))[0].n;
Number(left) === 0 ? ok('no rows of A remain') : bad('rows of A remain', String(left));
const bLeft = (await rows(`select count(*)::int n from public.study_subjects where user_id = $1`, [B]))[0].n;
bLeft === 1 ? ok("B's data untouched") : bad("B's data changed", String(bLeft));

console.log(`\n------------------------\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
