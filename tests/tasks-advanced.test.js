// V3-H dependencies, recurring tasks, and resource URL safety.
// Run: node tests/tasks-advanced.test.js

import assert from 'node:assert/strict';
import { wouldCreateCycle, findCycle, computeBlockedState, topologicalOrder, splitBlockedSubjects } from '../src/tasks/dependencyModel.js';
import { validateRuleFields, occurrencesInRange, planGeneration } from '../src/tasks/recurringModel.js';
import { normalizeUrl, validateResourceFields, guessKind, hostOf } from '../src/resources/resourceModel.js';

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

// Research -> Outline -> Draft -> Revision -> Submit
const chain = [
  { task_id: 'outline', depends_on_id: 'research' },
  { task_id: 'draft', depends_on_id: 'outline' },
  { task_id: 'revision', depends_on_id: 'draft' },
  { task_id: 'submit', depends_on_id: 'revision' },
];
const g = (id, done = false, extra = {}) => ({ id, name: id, done, dependencyOverride: false, ...extra });

console.log('\n=== dependencies ===');
check('detects direct and transitive cycles before they are created', () => {
  assert.equal(wouldCreateCycle(chain, 'research', 'submit'), true);
  assert.equal(wouldCreateCycle(chain, 'research', 'outline'), true);
  assert.equal(wouldCreateCycle(chain, 'draft', 'draft'), true);
  assert.equal(wouldCreateCycle(chain, 'submit', 'research'), false);
  assert.equal(wouldCreateCycle([], 'a', 'b'), false);
});
check('finds a cycle already present in stored data', () => {
  assert.equal(findCycle(chain), null);
  const loop = findCycle([...chain, { task_id: 'research', depends_on_id: 'submit' }]);
  assert.ok(loop && loop.includes('research') && loop.includes('submit'));
});
check('downstream tasks are blocked until prerequisites are done', () => {
  const groups = [g('research', true), g('outline', true), g('draft'), g('revision'), g('submit')];
  const st = computeBlockedState(groups, chain);
  assert.equal(st.get('draft').blocked, false);
  assert.equal(st.get('revision').blocked, true);
  assert.deepEqual(st.get('revision').waitingOn.map((w) => w.id), ['draft']);
  assert.equal(st.get('submit').blocked, true);
  assert.deepEqual(st.get('outline').dependentIds, ['draft']);
});
check('manual override unblocks but is reported', () => {
  const groups = [g('draft'), g('revision', false, { dependencyOverride: true })];
  const st = computeBlockedState(groups, chain);
  assert.equal(st.get('revision').blocked, false);
  assert.equal(st.get('revision').overridden, true);
});
check('a done task is never blocked; unknown prerequisites never block', () => {
  const st = computeBlockedState([g('revision', true), g('submit')], chain);
  assert.equal(st.get('revision').blocked, false);
  assert.equal(st.get('submit').blocked, false); // revision done
  const unknown = computeBlockedState([g('draft')], chain);
  assert.equal(unknown.get('draft').blocked, false); // outline not loaded
});
check('topological order puts prerequisites first', () => {
  assert.deepEqual(topologicalOrder(['submit', 'draft', 'research', 'outline', 'revision'], chain), ['research', 'outline', 'draft', 'revision', 'submit']);
});
check('planner generation skips blocked subjects, chunks follow their root', () => {
  const groups = [g('outline'), g('draft')];
  const subjects = [{ id: 'chunk1', name: 'Draft (part 2)', origin_subject_id: 'draft' }, { id: 'outline', name: 'Outline', origin_subject_id: null }];
  const { allowed, skipped } = splitBlockedSubjects(subjects, groups, chain);
  assert.deepEqual(allowed.map((s) => s.id), ['outline']);
  assert.equal(skipped[0].subject.id, 'chunk1');
  assert.equal(skipped[0].waitingOn[0].name, 'outline');
});

console.log('\n=== recurring tasks ===');
const rule = { id: 'r1', name: 'Weekly reading', days_of_week: [2, 4], start_date: '2026-09-01', end_date: '2026-12-18', minutes: 45, due_offset_days: 1, active: true, priority: 'medium', tags: ['Reading'] };
check('occurrences honour weekdays and the rule window', () => {
  assert.deepEqual(occurrencesInRange(rule, '2026-10-05', '2026-10-11'), ['2026-10-06', '2026-10-08']);
  assert.deepEqual(occurrencesInRange(rule, '2026-12-15', '2026-12-31'), ['2026-12-15', '2026-12-17']);
  assert.deepEqual(occurrencesInRange({ ...rule, active: false }, '2026-10-05', '2026-10-11'), []);
});
check('generation creates only missing occurrences (no duplicates)', () => {
  const existing = [{ recurrence_rule_id: 'r1', recurrence_date: '2026-10-08' }];
  const plan = planGeneration([rule], existing, '2026-10-07', 7);
  assert.deepEqual(plan.map((p) => p.occurrenceDate), ['2026-10-13']);
  assert.equal(plan[0].dueDate, '2026-10-14');
  assert.equal(plan[0].fields.recurrence_date, '2026-10-13');
  // running again with the result applied creates nothing
  const again = planGeneration([rule], [...existing, { recurrence_rule_id: 'r1', recurrence_date: '2026-10-13' }], '2026-10-07', 7);
  assert.equal(again.length, 0);
});
check('rule validation', () => {
  assert.equal(validateRuleFields({ name: '', days_of_week: [], minutes: 0, start_date: 'x', end_date: 'y' }).ok, false);
  const ok = validateRuleFields({ name: 'Lab prep', days_of_week: ['4', 4, 9], minutes: '30', start_date: '2026-09-01', end_date: '2026-12-01' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.fields.days_of_week, [4]);
  assert.equal(validateRuleFields({ ...ok.fields, end_date: '2026-08-01' }).errors.end_date, 'recur.errEndOrder');
});

console.log('\n=== resource links ===');
check('only http(s) URLs survive', () => {
  assert.equal(normalizeUrl('https://example.edu/syllabus.pdf'), 'https://example.edu/syllabus.pdf');
  assert.equal(normalizeUrl('example.edu/a b'), null);
  assert.equal(normalizeUrl('example.edu/notes'), 'https://example.edu/notes');
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.equal(normalizeUrl('JAVASCRIPT:alert(1)'), null);
  assert.equal(normalizeUrl('data:text/html,<script>'), null);
  assert.equal(normalizeUrl('file:///etc/passwd'), null);
  assert.equal(normalizeUrl('//evil.com'), null);
  assert.equal(normalizeUrl('https://user:pass@example.com'), null);
  assert.equal(normalizeUrl('https://x'), null);
  assert.equal(normalizeUrl(`https://example.com/${'a'.repeat(2100)}`), null);
});
check('titles default to the host and kinds are guessed', () => {
  const r = validateResourceFields({ url: 'https://www.youtube.com/watch?v=1', title: '' });
  assert.equal(r.ok, true);
  assert.equal(r.fields.title, 'youtube.com');
  assert.equal(r.fields.kind, 'lecture');
  assert.equal(guessKind('https://example.edu/notes.pdf'), 'document');
  assert.equal(hostOf('not a url'), '');
  assert.equal(validateResourceFields({ url: 'javascript:x', title: 'x' }).errors.url, 'resources.errUrl');
});

console.log('\n------------------------');
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
