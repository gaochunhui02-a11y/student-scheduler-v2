// Plain Node tests for the pure Study Tasks filtering/search logic in
// src/dashboard/taskFilters.js. No DOM, no Supabase. Run with `npm test` or
// `node tests/task-filters.test.js`.

import assert from 'node:assert/strict';
import {
  FILTER_MODES,
  matchesFilterMode,
  matchesPriorityFilter,
  matchesTagFilter,
  matchesSubjectFilter,
  matchesSearchQuery,
  listDistinctSubjectNames,
  listDistinctTags,
  filterTasks,
} from '../src/dashboard/taskFilters.js';

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

const TODAY = '2026-10-04';

function task(overrides = {}) {
  return {
    id: 't1',
    name: 'Biology Midterm',
    priority: 'high',
    dueDate: null,
    remainingMinutes: 60,
    completed: false,
    notes: '',
    tags: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
scenario('A. matchesFilterMode', () => {
  check('"all" matches everything, completed or not', () => {
    assert.equal(matchesFilterMode(task({ completed: true }), 'all', TODAY), true);
    assert.equal(matchesFilterMode(task(), 'all', TODAY), true);
  });
  check('"completed" only matches completed tasks', () => {
    assert.equal(matchesFilterMode(task({ completed: true }), 'completed', TODAY), true);
    assert.equal(matchesFilterMode(task({ completed: false }), 'completed', TODAY), false);
  });
  check('a completed task never matches today/upcoming/overdue', () => {
    const t = task({ completed: true, dueDate: '2026-10-01' });
    assert.equal(matchesFilterMode(t, 'overdue', TODAY), false);
    assert.equal(matchesFilterMode(t, 'today', TODAY), false);
    assert.equal(matchesFilterMode(t, 'upcoming', TODAY), false);
  });
  check('"overdue" matches a past due date', () => {
    assert.equal(matchesFilterMode(task({ dueDate: '2026-10-01' }), 'overdue', TODAY), true);
  });
  check('"today" matches exactly today', () => {
    assert.equal(matchesFilterMode(task({ dueDate: TODAY }), 'today', TODAY), true);
    assert.equal(matchesFilterMode(task({ dueDate: '2026-10-05' }), 'today', TODAY), false);
  });
  check('"upcoming" matches a future due date, not today or overdue', () => {
    assert.equal(matchesFilterMode(task({ dueDate: '2026-10-05' }), 'upcoming', TODAY), true);
    assert.equal(matchesFilterMode(task({ dueDate: TODAY }), 'upcoming', TODAY), false);
    assert.equal(matchesFilterMode(task({ dueDate: '2026-10-01' }), 'upcoming', TODAY), false);
  });
  check('a task with no due date never matches today/upcoming/overdue', () => {
    const t = task({ dueDate: null });
    assert.equal(matchesFilterMode(t, 'overdue', TODAY), false);
    assert.equal(matchesFilterMode(t, 'today', TODAY), false);
    assert.equal(matchesFilterMode(t, 'upcoming', TODAY), false);
  });
  check('FILTER_MODES lists exactly the five supported modes', () => {
    assert.deepEqual(FILTER_MODES, ['all', 'today', 'upcoming', 'overdue', 'completed']);
  });
});

// ---------------------------------------------------------------------------
scenario('B. Priority / tag / subject filters', () => {
  check('no priority filter matches anything', () => assert.equal(matchesPriorityFilter(task(), null), true));
  check('priority filter matches only that priority', () => {
    assert.equal(matchesPriorityFilter(task({ priority: 'high' }), 'high'), true);
    assert.equal(matchesPriorityFilter(task({ priority: 'low' }), 'high'), false);
  });
  check('no tag filter matches anything', () => assert.equal(matchesTagFilter(task(), null), true));
  check('tag filter matches a task carrying that tag', () => {
    assert.equal(matchesTagFilter(task({ tags: ['Exam', 'Review'] }), 'Exam'), true);
    assert.equal(matchesTagFilter(task({ tags: ['Homework'] }), 'Exam'), false);
  });
  check('a task with no tags array never matches a tag filter', () => {
    assert.equal(matchesTagFilter({ id: 't2', name: 'x' }, 'Exam'), false);
  });
  check('subject filter matches the task name exactly', () => {
    assert.equal(matchesSubjectFilter(task({ name: 'Calculus' }), 'Calculus'), true);
    assert.equal(matchesSubjectFilter(task({ name: 'Calculus' }), 'Biology'), false);
  });
});

// ---------------------------------------------------------------------------
scenario('C. Search query', () => {
  check('empty query matches everything', () => assert.equal(matchesSearchQuery(task(), ''), true));
  check('matches by name, case-insensitively', () => assert.equal(matchesSearchQuery(task({ name: 'Biology Midterm' }), 'biology'), true));
  check('matches by notes', () => assert.equal(matchesSearchQuery(task({ notes: 'bring calculator' }), 'calculator'), true));
  check('matches by tag', () => assert.equal(matchesSearchQuery(task({ tags: ['Exam'] }), 'exam'), true));
  check('no match returns false', () => assert.equal(matchesSearchQuery(task({ name: 'Biology' }), 'chemistry'), false));
});

// ---------------------------------------------------------------------------
scenario('D. Distinct-value listings', () => {
  check('listDistinctSubjectNames is sorted and deduplicated', () => {
    const tasks = [task({ name: 'Biology' }), task({ name: 'Calculus' }), task({ name: 'Biology' })];
    assert.deepEqual(listDistinctSubjectNames(tasks), ['Biology', 'Calculus']);
  });
  check('listDistinctTags flattens and deduplicates across tasks', () => {
    const tasks = [task({ tags: ['Exam', 'Review'] }), task({ tags: ['Review', 'Homework'] })];
    assert.deepEqual(listDistinctTags(tasks), ['Exam', 'Homework', 'Review']);
  });
});

// ---------------------------------------------------------------------------
scenario('E. filterTasks (combined, never mutates input)', () => {
  const tasks = [
    task({ id: 'a', name: 'Biology', priority: 'high', dueDate: '2026-10-01', tags: ['Exam'] }),
    task({ id: 'b', name: 'Calculus', priority: 'low', dueDate: '2026-10-10', tags: ['Homework'] }),
    task({ id: 'c', name: 'History', priority: 'high', completed: true, tags: ['Exam'] }),
  ];
  const frozenCopy = JSON.parse(JSON.stringify(tasks));

  check('mode=overdue returns only the overdue task', () => {
    const result = filterTasks(tasks, { mode: 'overdue' }, TODAY);
    assert.deepEqual(result.map((t) => t.id), ['a']);
  });
  check('mode + tag combine with AND semantics', () => {
    const result = filterTasks(tasks, { mode: 'all', tag: 'Exam' }, TODAY);
    assert.deepEqual(result.map((t) => t.id).sort(), ['a', 'c']);
  });
  check('priority filter narrows further', () => {
    const result = filterTasks(tasks, { mode: 'all', tag: 'Exam', priority: 'high' }, TODAY);
    assert.deepEqual(result.map((t) => t.id).sort(), ['a', 'c']);
  });
  check('an empty filters object returns every task unchanged in order', () => {
    const result = filterTasks(tasks, {}, TODAY);
    assert.deepEqual(result.map((t) => t.id), ['a', 'b', 'c']);
  });
  check('the input array and its task objects are never mutated', () => {
    filterTasks(tasks, { mode: 'overdue', tag: 'Exam', priority: 'high', query: 'bio' }, TODAY);
    assert.deepEqual(tasks, frozenCopy);
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
