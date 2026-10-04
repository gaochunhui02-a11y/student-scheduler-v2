// Plain Node tests for the pure tags model logic in
// src/dashboard/tagsModel.js. No DOM, no Supabase. Run with `npm test` or
// `node tests/tags-model.test.js`.

import assert from 'node:assert/strict';
import {
  PRESET_TASK_TAGS,
  normalizeTag,
  isValidTag,
  normalizeTagList,
  hasTag,
  toggleTag,
  addCustomTag,
} from '../src/dashboard/tagsModel.js';

let totalFailures = 0;

function scenario(name, fn) {
  console.log(`\n=== ${name} ===`);
  try {
    fn();
  } catch (e) {
    totalFailures++;
    console.log(`  FAIL  (scenario threw) ${e.message}`);
  }
}

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

// ---------------------------------------------------------------------------
scenario('A. normalizeTag / isValidTag', () => {
  check('trims whitespace', () => assert.equal(normalizeTag('  Exam  '), 'Exam'));
  check('caps at 30 characters', () => assert.equal(normalizeTag('x'.repeat(50)).length, 30));
  check('non-string becomes empty string', () => assert.equal(normalizeTag(42), ''));
  check('a real tag is valid', () => assert.equal(isValidTag('Exam'), true));
  check('whitespace-only is invalid', () => assert.equal(isValidTag('   '), false));
});

// ---------------------------------------------------------------------------
scenario('B. normalizeTagList', () => {
  check('non-array input becomes an empty list', () => assert.deepEqual(normalizeTagList(null), []));
  check('trims and drops empty entries', () => assert.deepEqual(normalizeTagList(['Exam', '  ', 'Review']), ['Exam', 'Review']));
  check('deduplicates (case-sensitive, post-trim)', () => assert.deepEqual(normalizeTagList(['Exam', 'Exam', ' Exam ']), ['Exam']));
  check('caps at 12 tags', () => {
    const many = Array.from({ length: 20 }, (_, i) => `Tag${i}`);
    assert.equal(normalizeTagList(many).length, 12);
  });
});

// ---------------------------------------------------------------------------
scenario('C. hasTag', () => {
  check('finds a present tag', () => assert.equal(hasTag(['Exam', 'Review'], 'Exam'), true));
  check('misses an absent tag', () => assert.equal(hasTag(['Exam'], 'Homework'), false));
});

// ---------------------------------------------------------------------------
scenario('D. toggleTag (never mutates input)', () => {
  check('adds an absent tag', () => assert.deepEqual(toggleTag(['Exam'], 'Review'), ['Exam', 'Review']));
  check('removes a present tag', () => assert.deepEqual(toggleTag(['Exam', 'Review'], 'Exam'), ['Review']));
  check('an empty/invalid tag is a no-op', () => assert.deepEqual(toggleTag(['Exam'], '   '), ['Exam']));
  check('the original array is never mutated', () => {
    const original = ['Exam'];
    toggleTag(original, 'Review');
    assert.deepEqual(original, ['Exam']);
  });
});

// ---------------------------------------------------------------------------
scenario('E. addCustomTag', () => {
  check('adds a valid custom tag', () => assert.deepEqual(addCustomTag(['Exam'], 'Lab Report'), ['Exam', 'Lab Report']));
  check('rejects a blank custom tag, leaving the list unchanged', () => assert.deepEqual(addCustomTag(['Exam'], '   '), ['Exam']));
  check('adding an already-present tag removes it (same toggle semantics)', () => {
    assert.deepEqual(addCustomTag(['Exam'], 'Exam'), []);
  });
});

// ---------------------------------------------------------------------------
scenario('F. PRESET_TASK_TAGS', () => {
  check('exposes the five documented presets', () => {
    assert.deepEqual(PRESET_TASK_TAGS, ['Exam', 'Homework', 'Reading', 'Project', 'Review']);
  });
});

// ---------------------------------------------------------------------------
console.log('\n------------------------');
if (totalFailures > 0) {
  console.log(`${totalFailures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
