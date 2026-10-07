// Static safety checks for the V3 migrations (0010+). These files are NOT
// applied by anything in this repo; the owner runs them by hand. This test
// guarantees they stay additive and that every new user-owned table is
// locked down by RLS. Run: node tests/migrations-v3.test.js

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dir = join(__dirname, '../supabase/migrations');

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

// SQL with comments removed and whitespace collapsed (lower case).
function sqlOf(file) {
  return readFileSync(join(dir, file), 'utf8')
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const v3 = files.filter((f) => Number(f.slice(0, 4)) >= 10);

console.log('\n=== V3 migration inventory ===');
check('0010–0017 exist, numbered without gaps', () => {
  // V3 = 0010-0017, V4 = 0018+; any number of files, but no gaps.
  const nums = v3.map((f) => Number(f.slice(0, 4)));
  assert.ok(nums.length >= 9, 'expected at least 0010-0018');
  nums.forEach((n, i) => assert.equal(n, 10 + i, `gap before ${v3[i]}`));
  assert.ok(v3.includes('0018_spaces.sql'));
});

console.log('\n=== additive only ===');
v3.forEach((file) => {
  const sql = sqlOf(file);
  check(`${file}: no drop table / column / policy / function, no truncate`, () => {
    assert.doesNotMatch(sql, /\bdrop (table|column|policy|function|schema|index|view|type)\b/);
    assert.doesNotMatch(sql, /\btruncate\b/);
  });
  check(`${file}: no DELETE / UPDATE of existing rows`, () => {
    // Only flag statements; "on delete set null" / "on update" FK actions,
    // "for delete"/"for update" policies and "before insert or update" triggers are fine.
    const stripped = sql
      .replace(/on (delete|update) (set null|cascade|restrict|no action)/g, '')
      .replace(/for (delete|update)\b/g, '')
      .replace(/(insert or update|or update of|update of)/g, '')
      .replace(/': (update|delete) own'/g, '');
    assert.doesNotMatch(stripped, /(^|;|\bthen|\bbegin|\bloop) ?(delete from|update public\.)/);
  });
  check(`${file}: no column renames or type changes`, () => {
    assert.doesNotMatch(sql, /\brename\b/);
    assert.doesNotMatch(sql, /alter column \w+ (set data )?type\b/);
    assert.doesNotMatch(sql, /alter column \w+ set not null/);
  });
  check(`${file}: NOT NULL is only relaxed where reviewed (study_subjects.schedule_id, 0021)`, () => {
    // Relaxing a constraint keeps every existing row and insert valid, but
    // each one changes what the app may store, so each is allowlisted.
    const ALLOWED = ['alter table public.study_subjects alter column schedule_id drop not null'];
    const found = [...sql.matchAll(/alter table [\w.]+ alter column \w+ drop not null/g)].map((m) => m[0]);
    found.forEach((stmt) => assert.ok(ALLOWED.includes(stmt), `unreviewed: ${stmt}`));
    if (file.startsWith('0021')) assert.deepEqual(found, ALLOWED);
  });
  check(`${file}: added columns are nullable or have a default`, () => {
    const adds = [...sql.matchAll(/add column if not exists (\w+) ([^,;]+)/g)];
    adds.forEach(([, col, def]) => {
      if (/not null/.test(def)) assert.match(def, /default/, `${col} is NOT NULL without a default`);
    });
    assert.doesNotMatch(sql, /add column (?!if not exists)/, 'add column without "if not exists"');
  });
  check(`${file}: every dropped trigger is re-created`, () => {
    const dropped = [...sql.matchAll(/drop trigger if exists (\w+) on/g)].map((m) => m[1]);
    dropped.forEach((name) => assert.match(sql, new RegExp(`create trigger ${name}\\b`), `${name} dropped but not re-created`));
  });
  check(`${file}: idempotent table creation`, () => {
    assert.doesNotMatch(sql, /create table (?!if not exists)/);
  });
});

console.log('\n=== Row Level Security ===');
v3.forEach((file) => {
  const sql = sqlOf(file);
  const tables = [...sql.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
  tables.forEach((tbl) => {
    check(`${tbl}: user_id owner column, RLS on, select/insert/update/delete own`, () => {
      const body = sql.slice(sql.indexOf(`create table if not exists public.${tbl}`));
      assert.match(body.slice(0, 400), /user_id uuid not null references auth\.users \(id\) on delete cascade/);
      assert.match(sql, new RegExp(`alter table public\\.${tbl} enable row level security`));
      const direct = (op) => new RegExp(`create policy "${tbl}: ${op} own" on public\\.${tbl} for ${op} (using|with check) \\(auth\\.uid\\(\\) = user_id\\)`).test(sql);
      const looped = (op) => new RegExp(`array\\[[^\\]]*'${tbl}'[^\\]]*\\] loop`).test(sql)
        && new RegExp(`create policy %i on public\\.%i for ${op} (using|with check) \\(auth\\.uid\\(\\) = user_id\\)`).test(sql);
      ['select', 'insert', 'update', 'delete'].forEach((op) => assert.ok(direct(op) || looped(op), `${tbl} is missing its "${op} own" policy`));
      // update must check BOTH the old row (using) and the new row (with check)
      assert.match(sql, /for update using \(auth\.uid\(\) = user_id\) with check \(auth\.uid\(\) = user_id\)/);
    });
  });
  check(`${file}: no permissive "using (true)" policies`, () => {
    assert.doesNotMatch(sql, /using \(true\)|with check \(true\)/);
  });
});

console.log('\n=== cross-user references ===');
check('the ownership guard runs as the caller (security invoker) with a fixed search_path', () => {
  const sql = sqlOf('0010_semesters.sql');
  assert.match(sql, /function public\.v3_assert_owned_ref\(\) returns trigger language plpgsql security invoker set search_path = public/);
});
check('every V3 foreign key to a user-owned table has an ownership trigger', () => {
  const OWNED = ['spaces', 'projects', 'project_milestones', 'semesters', 'courses', 'exams', 'exam_topics', 'task_recurrence_rules', 'study_subjects', 'schedule_items', 'grade_categories'];
  v3.forEach((file) => {
    const sql = sqlOf(file);
    // "<col> uuid [not null] references public.<target>" (table bodies and add column)
    [...sql.matchAll(/(?:add column if not exists )?(\w+) uuid (?:not null )?references public\.(\w+)/g)].forEach(([, col, target]) => {
      if (!OWNED.includes(target)) return;
      // task_dependencies / focus_sessions / grade_items etc. — find any trigger guarding this column
      const guarded = new RegExp(`v3_assert_owned_ref\\('${target}', '${col}'\\)`).test(sql)
        || (col === 'category_id' && /grade_items_category_matches/.test(sql));
      assert.ok(guarded, `${file}: ${col} -> ${target} has no ownership trigger`);
    });
  });
});
check('no storage buckets are created (no public file storage)', () => {
  v3.forEach((file) => assert.doesNotMatch(sqlOf(file), /storage\.buckets/));
});
check('resource URLs are limited to http(s) in the database too', () => {
  assert.ok(sqlOf('0015_resources.sql').includes("check (url ~* '^https?://"));
});

console.log('\n------------------------');
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
