// Plain Node tests for the pure subtasks model logic in
// src/dashboard/subtasksModel.js. No DOM, no Supabase. Run with `npm test`
// or `node tests/subtasks-model.test.js`.

import assert from 'node:assert/strict';
import {
  normalizeSubtaskTitle,
  isValidSubtaskTitle,
  buildSubtaskFields,
  nextSubtaskSortOrder,
  computeSubtaskProgress,
  isSubtasksFullyComplete,
} from '../src/dashboard/subtasksModel.js';

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
scenario('A. Title normalization + validation', () => {
  check('trims whitespace', () => assert.equal(normalizeSubtaskTitle('  Chapter 1  '), 'Chapter 1'));
  check('non-string becomes empty string', () => assert.equal(normalizeSubtaskTitle(undefined), ''));
  check('caps at 200 characters', () => assert.equal(normalizeSubtaskTitle('a'.repeat(250)).length, 200));
  check('a real title is valid', () => assert.equal(isValidSubtaskTitle('Chapter 1'), true));
  check('an empty/whitespace-only title is invalid', () => assert.equal(isValidSubtaskTitle('   '), false));
  check('undefined is invalid', () => assert.equal(isValidSubtaskTitle(undefined), false));
});

// ---------------------------------------------------------------------------
scenario('B. buildSubtaskFields', () => {
  check('maps a trimmed title and starts not completed', () => {
    assert.deepEqual(buildSubtaskFields('  Practice Questions '), { title: 'Practice Questions', completed: false });
  });
});

// ---------------------------------------------------------------------------
scenario('C. nextSubtaskSortOrder', () => {
  check('first subtask gets 0', () => assert.equal(nextSubtaskSortOrder(0), 0));
  check('third subtask gets 2', () => assert.equal(nextSubtaskSortOrder(2), 2));
  check('non-finite input defaults to 0', () => assert.equal(nextSubtaskSortOrder(undefined), 0));
});

// ---------------------------------------------------------------------------
scenario('D. computeSubtaskProgress', () => {
  check('no subtasks at all -> 0/0', () => assert.deepEqual(computeSubtaskProgress([]), { completed: 0, total: 0 }));
  check('null/undefined input -> 0/0', () => assert.deepEqual(computeSubtaskProgress(undefined), { completed: 0, total: 0 }));
  check('mixed completion counts correctly', () => {
    const subtasks = [{ completed: true }, { completed: false }, { completed: true }];
    assert.deepEqual(computeSubtaskProgress(subtasks), { completed: 2, total: 3 });
  });
});

// ---------------------------------------------------------------------------
scenario('E. isSubtasksFullyComplete', () => {
  check('zero subtasks is never "fully complete via subtasks"', () => assert.equal(isSubtasksFullyComplete([]), false));
  check('all completed is fully complete', () => {
    assert.equal(isSubtasksFullyComplete([{ completed: true }, { completed: true }]), true);
  });
  check('one incomplete is not fully complete', () => {
    assert.equal(isSubtasksFullyComplete([{ completed: true }, { completed: false }]), false);
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
