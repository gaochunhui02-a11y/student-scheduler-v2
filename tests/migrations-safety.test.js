// Guards for the V2 migrations (0005–0009): additive only, safe to run
// under the production v1.x app. Reads the SQL files as text — no database.
// Run with `npm test` or `node tests/migrations-safety.test.js`.
//
// Rules checked on every V2 migration (comments stripped first):
//   - no DROP TABLE / DROP COLUMN / TRUNCATE / DELETE / RENAME
//   - no ALTER COLUMN ... TYPE (type changes)
//   - no UPDATE (data writes across rows) — 0009's optional backfill must
//     live outside supabase/migrations/
//   - a DROP CONSTRAINT is allowed only when the same file re-adds a
//     constraint with that exact name (0008 widens a check this way)
//   - every ADD COLUMN is nullable or has a default (never breaks inserts
//     from the v1.x app, which doesn't know the column exists)

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../supabase/migrations');
let totalFailures = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (e) {
    totalFailures++;
    console.log(`  FAIL  ${label}`);
    console.log(`        ${e.message}`);
  }
}

function stripComments(sql) {
  return sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

const v2Files = readdirSync(migrationsDir)
  .filter((f) => /^000[5-9]_.*\.sql$/.test(f))
  .sort();

console.log('\n=== V2 migrations are additive and non-destructive ===');
check('found migrations 0005 through 0009', () => {
  assert.deepEqual(v2Files.map((f) => f.slice(0, 4)), ['0005', '0006', '0007', '0008', '0009']);
});

v2Files.forEach((file) => {
  const sql = stripComments(readFileSync(join(migrationsDir, file), 'utf8')).toLowerCase();

  check(`${file}: no DROP TABLE / DROP COLUMN / TRUNCATE / DELETE / RENAME`, () => {
    assert.doesNotMatch(sql, /\bdrop\s+table\b/);
    assert.doesNotMatch(sql, /\bdrop\s+column\b/);
    assert.doesNotMatch(sql, /\btruncate\b/);
    assert.doesNotMatch(sql, /\bdelete\s+from\b/);
    assert.doesNotMatch(sql, /\brename\b/);
  });
  check(`${file}: no column type changes`, () => {
    assert.doesNotMatch(sql, /\balter\s+column\b[^;]*\btype\b/);
  });
  check(`${file}: no UPDATE (no mass data writes)`, () => {
    assert.doesNotMatch(sql, /\bupdate\s+(public\.)?\w+\s+set\b/);
  });
  check(`${file}: any dropped constraint is re-added in the same file`, () => {
    const dropped = [...sql.matchAll(/drop\s+constraint\s+(?:if\s+exists\s+)?(\w+)/g)].map((m) => m[1]);
    dropped.forEach((name) => {
      assert.match(sql, new RegExp(`add\\s+constraint\\s+${name}\\b`), `${name} dropped but never re-added`);
    });
  });
  check(`${file}: every added column is nullable or defaulted`, () => {
    const adds = [...sql.matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?(\w+)\s+([^,;]+)/g)];
    adds.forEach(([, col, def]) => {
      if (/\bnot\s+null\b/.test(def)) assert.match(def, /\bdefault\b/, `${col} is NOT NULL without a default`);
    });
  });
});

console.log('\n=== 0009 specifics ===');
const sql0009 = stripComments(readFileSync(join(migrationsDir, '0009_onboarding.sql'), 'utf8')).toLowerCase();
check('0009 only adds profiles.onboarding_completed_at (nullable, no default)', () => {
  const statements = sql0009.split(';').map((s) => s.trim()).filter(Boolean);
  assert.equal(statements.length, 1);
  assert.match(statements[0], /^alter table public\.profiles\s+add column if not exists onboarding_completed_at timestamptz$/);
});
check('the optional backfill lives outside supabase/migrations', () => {
  assert.equal(existsSync(join(__dirname, '../supabase/optional/0009b_onboarding_backfill_OPTIONAL.sql')), true);
  assert.equal(readdirSync(migrationsDir).some((f) => /backfill/i.test(f)), false);
});

console.log('\n------------------------');
if (totalFailures > 0) {
  console.log(`${totalFailures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
