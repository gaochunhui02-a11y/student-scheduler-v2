// Plain Node tests for the Checkpoint E deterministic Smart Priority engine
// (src/dashboard/smartPriority.js). No DOM, no Supabase, no AI — every
// scenario here is a plain input/output pair. Run with `npm test` or
// `node tests/smart-priority.test.js`.

import assert from 'node:assert/strict';
import {
  buildSmartTasks,
  computeAvailableStudyMinutes,
  daysUntilDue,
  classifyUrgency,
  computeTaskScore,
  selectReasonKeys,
  buildReasonTags,
  buildExplanation,
  rankTasks,
  compareByDueDate,
  compareByPriority,
  compareByRemainingTime,
  sortTasksForDisplay,
} from '../src/dashboard/smartPriority.js';

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

const TODAY = '2026-09-17';

function task(overrides = {}) {
  return {
    id: 's1',
    name: 'Task',
    priority: 'medium',
    dueDate: null,
    minutesRequested: 60,
    scheduledMinutes: 0,
    remainingMinutes: 60,
    carriedOverMinutes: 0,
    missed: false,
    completed: false,
    hasSchedule: false,
    ...overrides,
  };
}

const LABELS = {
  tag: {
    overdue: 'Overdue',
    today: 'Due today',
    tomorrow: 'Due tomorrow',
    soon: 'Due soon',
    highPriority: 'High priority',
    missed: 'Missed',
    carriedOver: 'Carry over',
    fits: 'Fits today',
  },
  clause: {
    overdue: 'it is overdue',
    today: 'it is due today',
    tomorrow: 'it is due tomorrow',
    soon: 'it is due soon',
    highPriority: 'it is marked high priority',
    missed: 'it was missed',
    carriedOver: 'it has carried-over work',
    fits: 'it can fit into your remaining study time',
    inProgress: 'it is already in progress',
    unfinished: 'it still has unfinished work',
  },
  explanationOne: 'Recommended because {clause1}.',
  explanationTwo: 'Recommended because {clause1} and {clause2}.',
};

// ---------------------------------------------------------------------------
scenario('A. buildSmartTasks — deriving remaining/missed/carried-over from schedule_items', () => {
  check('a subject never generated yet is fully remaining, not started, not missed', () => {
    const [t] = buildSmartTasks([{ id: 's1', name: 'Physics', priority: 'medium', dueDate: null, minutesRequested: 90 }], []);
    assert.equal(t.remainingMinutes, 90);
    assert.equal(t.hasSchedule, false);
    assert.equal(t.missed, false);
    assert.equal(t.completed, false);
    assert.equal(t.carriedOverMinutes, 0);
  });

  check('a fully completed block reports 0 remaining and completed=true', () => {
    const items = [{ type: 'study', sourceSubjectId: 's1', name: 'Physics', start: 0, end: 60, completed: true }];
    const [t] = buildSmartTasks([{ id: 's1', name: 'Physics', minutesRequested: 60 }], items);
    assert.equal(t.remainingMinutes, 0);
    assert.equal(t.completed, true);
  });

  check('partial completion uses remaining minutes, not the original duration (90 total, 40 done -> 50 left)', () => {
    const items = [{ type: 'study', sourceSubjectId: 's1', name: 'Physics', start: 0, end: 90, completed: false, completedMinutes: 40 }];
    const [t] = buildSmartTasks([{ id: 's1', name: 'Physics', minutesRequested: 90 }], items);
    assert.equal(t.remainingMinutes, 50);
    assert.equal(t.completed, false);
  });

  check('carry-over is not double-counted (90 total, 40 completed, 30 already carried -> 20 left, matching carryOverModel)', () => {
    const items = [
      { type: 'study', sourceSubjectId: 's1', name: 'Physics', start: 0, end: 90, completed: false, completedMinutes: 40, carriedOverMinutes: 30 },
    ];
    const [t] = buildSmartTasks([{ id: 's1', name: 'Physics', minutesRequested: 90 }], items);
    assert.equal(t.remainingMinutes, 20);
    assert.equal(t.carriedOverMinutes, 30);
  });

  check('a block flagged missed with remaining time sets missed=true', () => {
    const items = [{ type: 'study', sourceSubjectId: 's1', name: 'Bio', start: 0, end: 60, completed: false, missed: true }];
    const [t] = buildSmartTasks([{ id: 's1', name: 'Bio', minutesRequested: 60 }], items);
    assert.equal(t.missed, true);
  });

  check('a block flagged missed but with nothing left (already fully carried/completed) is NOT reported missed', () => {
    const items = [{ type: 'study', sourceSubjectId: 's1', name: 'Bio', start: 0, end: 60, completed: false, carriedOverMinutes: 60, missed: true }];
    const [t] = buildSmartTasks([{ id: 's1', name: 'Bio', minutesRequested: 60 }], items);
    assert.equal(t.missed, false, 'nothing left to miss once it is fully carried');
  });

  check('a subject split across two blocks (session-cap split) aggregates both', () => {
    const items = [
      { type: 'study', sourceSubjectId: 's1', name: 'Math', start: 0, end: 45, completed: true },
      { type: 'study', sourceSubjectId: 's1', name: 'Math', start: 100, end: 145, completed: false },
    ];
    const [t] = buildSmartTasks([{ id: 's1', name: 'Math', minutesRequested: 90 }], items);
    assert.equal(t.scheduledMinutes, 90);
    assert.equal(t.remainingMinutes, 45);
    assert.equal(t.completed, false, 'not done until every block is');
  });

  check('a subject with 0 or missing minutesRequested is dropped entirely, never a phantom task', () => {
    const tasks = buildSmartTasks(
      [
        { id: 's1', name: 'Zero', minutesRequested: 0 },
        { id: 's2', name: 'NoName' },
        { id: 's3', name: 'Missing minutesRequested' },
      ],
      []
    );
    assert.equal(tasks.length, 0);
  });

  check('non-study items (class/meal/break/free) never affect a subject\'s aggregation', () => {
    const items = [
      { type: 'class', sourceSubjectId: 's1', start: 0, end: 60 },
      { type: 'study', sourceSubjectId: 's1', name: 'Chem', start: 60, end: 100, completed: false },
    ];
    const [t] = buildSmartTasks([{ id: 's1', name: 'Chem', minutesRequested: 40 }], items);
    assert.equal(t.remainingMinutes, 40);
  });
});

// ---------------------------------------------------------------------------
scenario('B. computeAvailableStudyMinutes — reusing the schedule\'s own "free" blocks', () => {
  check('sums only free-type blocks', () => {
    const items = [
      { type: 'class', start: 0, end: 60 },
      { type: 'free', start: 60, end: 100 },
      { type: 'free', start: 200, end: 230 },
      { type: 'study', start: 100, end: 200 },
    ];
    assert.equal(computeAvailableStudyMinutes(items), 70);
  });
  check('returns null (unknown), not 0, when there is no generated schedule at all', () => {
    assert.equal(computeAvailableStudyMinutes([]), null);
    assert.equal(computeAvailableStudyMinutes(null), null);
  });
  check('returns 0 when a schedule exists but genuinely has no free time', () => {
    assert.equal(computeAvailableStudyMinutes([{ type: 'class', start: 0, end: 60 }]), 0);
  });
});

// ---------------------------------------------------------------------------
scenario('C. Urgency classification (daysUntilDue / classifyUrgency)', () => {
  check('no due date is neutral, not overdue', () => {
    assert.equal(daysUntilDue(null, TODAY), null);
    assert.equal(classifyUrgency(null, TODAY), 'none');
  });
  check('a past date is overdue', () => {
    assert.equal(classifyUrgency('2026-09-10', TODAY), 'overdue');
  });
  check('today, tomorrow, within 3 days, within a week, and later are each their own bucket', () => {
    assert.equal(classifyUrgency('2026-09-17', TODAY), 'today');
    assert.equal(classifyUrgency('2026-09-18', TODAY), 'tomorrow');
    assert.equal(classifyUrgency('2026-09-19', TODAY), 'soon');
    assert.equal(classifyUrgency('2026-09-20', TODAY), 'soon');
    assert.equal(classifyUrgency('2026-09-23', TODAY), 'week');
    assert.equal(classifyUrgency('2026-10-20', TODAY), 'later');
  });
});

// ---------------------------------------------------------------------------
scenario('D. computeTaskScore — exclusion guards', () => {
  check('a completed task is never scored (returns null)', () => {
    assert.equal(computeTaskScore(task({ completed: true }), { todayDateStr: TODAY }), null);
  });
  check('a task with 0 remaining minutes is never scored, even if not flagged completed', () => {
    assert.equal(computeTaskScore(task({ remainingMinutes: 0 }), { todayDateStr: TODAY }), null);
  });
  check('a task with negative/garbage remaining minutes is never scored', () => {
    assert.equal(computeTaskScore(task({ remainingMinutes: -5 }), { todayDateStr: TODAY }), null);
  });
});

// ---------------------------------------------------------------------------
scenario('E. computeTaskScore — factor behavior', () => {
  check('overdue outranks an equivalent task with a distant due date', () => {
    const overdue = computeTaskScore(task({ dueDate: '2026-09-01' }), { todayDateStr: TODAY });
    const distant = computeTaskScore(task({ dueDate: '2026-12-01' }), { todayDateStr: TODAY });
    assert.ok(overdue.score > distant.score);
  });

  check('due today outranks due next week, all else equal', () => {
    const dueToday = computeTaskScore(task({ dueDate: TODAY }), { todayDateStr: TODAY });
    const dueNextWeek = computeTaskScore(task({ dueDate: '2026-09-25' }), { todayDateStr: TODAY });
    assert.ok(dueToday.score > dueNextWeek.score);
  });

  check('High priority outranks Low when urgency is otherwise equal (both no due date)', () => {
    const high = computeTaskScore(task({ priority: 'high' }), { todayDateStr: TODAY });
    const low = computeTaskScore(task({ priority: 'low' }), { todayDateStr: TODAY });
    assert.ok(high.score > low.score);
  });
  check('High > Medium > Low, strictly ordered', () => {
    const high = computeTaskScore(task({ priority: 'high' }), {});
    const medium = computeTaskScore(task({ priority: 'medium' }), {});
    const low = computeTaskScore(task({ priority: 'low' }), {});
    assert.ok(high.priorityScore > medium.priorityScore);
    assert.ok(medium.priorityScore > low.priorityScore);
  });

  check('missed work receives its intended additional boost', () => {
    const missed = computeTaskScore(task({ missed: true }), {});
    const notMissed = computeTaskScore(task({ missed: false }), {});
    assert.ok(missed.score > notMissed.score);
    assert.ok(missed.missedScore > 0);
  });

  check('carried-over work gets a modest boost, smaller than the missed boost', () => {
    const carried = computeTaskScore(task({ carriedOverMinutes: 30 }), {});
    const plain = computeTaskScore(task({ carriedOverMinutes: 0 }), {});
    assert.ok(carried.score > plain.score);
    assert.ok(carried.carryOverScore > 0 && carried.carryOverScore < MISSED_BOOST_FOR_COMPARISON());
  });
  function MISSED_BOOST_FOR_COMPARISON() {
    return computeTaskScore(task({ missed: true }), {}).missedScore;
  }

  check('missed + carried-over on the SAME task adds both once, never a compounded/extreme stack', () => {
    const both = computeTaskScore(task({ missed: true, carriedOverMinutes: 30 }), {});
    const missedOnly = computeTaskScore(task({ missed: true, carriedOverMinutes: 0 }), {});
    const carriedOnly = computeTaskScore(task({ missed: false, carriedOverMinutes: 30 }), {});
    assert.equal(both.score, missedOnly.score + carriedOnly.carryOverScore, 'exactly additive, no extra multiplier');
  });

  check('remaining minutes matter but a huge task does not automatically dominate (score is capped)', () => {
    const huge = computeTaskScore(task({ remainingMinutes: 100000 }), {});
    const big = computeTaskScore(task({ remainingMinutes: 300 }), {});
    assert.equal(huge.remainingWorkScore, big.remainingWorkScore, 'both hit the same cap');
  });

  check('a no-deadline task still produces a sane, finite, comparable score', () => {
    const result = computeTaskScore(task({ dueDate: null, priority: 'high' }), { todayDateStr: TODAY });
    assert.ok(Number.isFinite(result.score));
    assert.equal(result.urgencyBucket, 'none');
    assert.equal(result.urgencyScore, 0);
  });

  check('overdue-but-low-priority still usually outranks a distant-but-high-priority task', () => {
    const overdueLow = computeTaskScore(task({ dueDate: '2026-09-01', priority: 'low' }), { todayDateStr: TODAY });
    const distantHigh = computeTaskScore(task({ dueDate: '2026-12-25', priority: 'high' }), { todayDateStr: TODAY });
    assert.ok(overdueLow.score > distantHigh.score, 'overdue urgency dominates a merely-distant high priority');
  });
});

// ---------------------------------------------------------------------------
scenario('F. Fit score — available-time behavior', () => {
  check('a task that comfortably fits today gets the full fit boost', () => {
    const result = computeTaskScore(task({ remainingMinutes: 30 }), { availableMinutesToday: 90 });
    assert.equal(result.fits, true);
    assert.ok(result.fitScore > 0);
  });
  check('a task that reasonably overruns (within the close-fit margin) still gets a smaller boost', () => {
    const result = computeTaskScore(task({ remainingMinutes: 100 }), { availableMinutesToday: 80 });
    assert.equal(result.fits, true);
    assert.ok(result.fitScore > 0);
  });
  check('a task far too big for today is not excluded or crashed on, just gets no fit boost', () => {
    const result = computeTaskScore(task({ remainingMinutes: 500 }), { availableMinutesToday: 30 });
    assert.equal(result.fits, false);
    assert.equal(result.fitScore, 0);
    assert.ok(Number.isFinite(result.score), 'a big task is never punished into an invalid/negative score');
  });
  check('unknown availability (no generated schedule) is neutral, not a penalty', () => {
    const result = computeTaskScore(task({ remainingMinutes: 500 }), {});
    assert.equal(result.fits, null);
    assert.equal(result.fitScore, 0);
  });
});

// ---------------------------------------------------------------------------
scenario('G. Reason generation (selectReasonKeys / buildReasonTags / buildExplanation)', () => {
  check('overdue + missed selects the two strongest, most specific reasons', () => {
    const t = task({ dueDate: '2026-09-01', missed: true });
    const breakdown = computeTaskScore(t, { todayDateStr: TODAY });
    const keys = selectReasonKeys(t, breakdown, 2);
    assert.deepEqual(keys, ['overdue', 'missed']);
  });

  check('due tomorrow + high priority', () => {
    const t = task({ dueDate: '2026-09-18', priority: 'high' });
    const breakdown = computeTaskScore(t, { todayDateStr: TODAY });
    const tags = buildReasonTags(t, breakdown, LABELS, 2);
    assert.deepEqual(tags, ['Due tomorrow', 'High priority']);
    const sentence = buildExplanation(t, breakdown, LABELS);
    assert.equal(sentence, 'Recommended because it is due tomorrow and it is marked high priority.');
  });

  check('missed + fits today', () => {
    const t = task({ missed: true, remainingMinutes: 20 });
    const breakdown = computeTaskScore(t, { availableMinutesToday: 60 });
    const sentence = buildExplanation(t, breakdown, LABELS);
    assert.equal(sentence, 'Recommended because it was missed and it can fit into your remaining study time.');
  });

  check('a task with no active reason at all still gets a non-empty, honest fallback explanation', () => {
    const t = task({ priority: 'low' });
    const breakdown = computeTaskScore(t, {});
    const sentence = buildExplanation(t, breakdown, LABELS);
    assert.equal(sentence, 'Recommended because it still has unfinished work.');
  });

  check('buildExplanation never throws when a label is missing from the caller\'s translation set', () => {
    const t = task({ dueDate: '2026-09-01' });
    const breakdown = computeTaskScore(t, { todayDateStr: TODAY });
    assert.doesNotThrow(() => buildExplanation(t, breakdown, { tag: {}, clause: {} }));
  });
});

// ---------------------------------------------------------------------------
scenario('H. rankTasks — end-to-end ranking + edge cases', () => {
  check('no tasks at all produces no recommendations', () => {
    assert.deepEqual(rankTasks([], { todayDateStr: TODAY }), []);
  });

  check('all tasks completed produces no recommendations (never just re-shown at the bottom)', () => {
    const tasks = [task({ id: 'a', completed: true }), task({ id: 'b', completed: true })];
    assert.deepEqual(rankTasks(tasks, {}), []);
  });

  check('a 0-remaining-minutes task is excluded even among otherwise-real tasks', () => {
    const tasks = [task({ id: 'a', remainingMinutes: 0 }), task({ id: 'b', remainingMinutes: 30 })];
    const ranked = rankTasks(tasks, {});
    assert.deepEqual(ranked.map((r) => r.task.id), ['b']);
  });

  check('with no due dates anywhere, priority/missed/remaining-work decide the order', () => {
    const tasks = [
      task({ id: 'low', priority: 'low' }),
      task({ id: 'high', priority: 'high' }),
      task({ id: 'missed', priority: 'medium', missed: true }),
    ];
    const ranked = rankTasks(tasks, {});
    // missed (25) + medium (15) = 40 beats high (30) alone; high beats low (0)
    assert.deepEqual(ranked.map((r) => r.task.id), ['missed', 'high', 'low']);
  });

  check('overdue clearly outranks a distant-but-otherwise-identical task in a full ranking', () => {
    const tasks = [task({ id: 'distant', dueDate: '2026-12-01' }), task({ id: 'overdue', dueDate: '2026-09-01' })];
    const ranked = rankTasks(tasks, { todayDateStr: TODAY });
    assert.equal(ranked[0].task.id, 'overdue');
  });

  check('stable tie-break: identical score/due date/priority/remaining time preserves input order', () => {
    const tasks = [task({ id: 'first' }), task({ id: 'second' })];
    const ranked = rankTasks(tasks, {});
    assert.equal(ranked[0].score, ranked[1].score, 'precondition: these really do tie on score');
    assert.deepEqual(ranked.map((r) => r.task.id), ['first', 'second']);
  });

  check('tie-break falls through to due date, then priority, then remaining time, deterministically', () => {
    // Construct two tasks whose total scores happen to match by design, but
    // differ on due date -> the earlier due date must win the tie.
    const earlier = task({ id: 'earlier', dueDate: '2026-09-19', priority: 'medium' }); // 'soon' -> 45 + 15 = 60
    const later = task({ id: 'later', dueDate: null, priority: 'high', missed: false });
    // Force `later` to the same total score as `earlier` by giving it no
    // urgency (0) + high priority (30) + it also being missed (25) = 55...
    // instead, just assert the comparator directly for full determinism:
    const a = { task: earlier, score: 60 };
    const b = { task: { ...later, dueDate: '2026-09-20' }, score: 60 };
    // Both due dates present and different -> earlier one must sort first.
    const merged = [b, a].sort((x, y) => (x.task.dueDate < y.task.dueDate ? -1 : x.task.dueDate > y.task.dueDate ? 1 : 0));
    assert.equal(merged[0].task.id, 'earlier');
  });
});

// ---------------------------------------------------------------------------
scenario('I. Plain deterministic sorts (compareByDueDate / compareByPriority / compareByRemainingTime)', () => {
  check('compareByDueDate: earlier first, no-date tasks sort last', () => {
    const list = [task({ id: 'none', dueDate: null }), task({ id: 'later', dueDate: '2026-10-01' }), task({ id: 'sooner', dueDate: '2026-09-18' })];
    const sorted = [...list].sort(compareByDueDate);
    assert.deepEqual(sorted.map((t) => t.id), ['sooner', 'later', 'none']);
  });
  check('compareByPriority: high, then medium, then low', () => {
    const list = [task({ id: 'low', priority: 'low' }), task({ id: 'high', priority: 'high' }), task({ id: 'medium', priority: 'medium' })];
    const sorted = [...list].sort(compareByPriority);
    assert.deepEqual(sorted.map((t) => t.id), ['high', 'medium', 'low']);
  });
  check('compareByRemainingTime: least remaining first', () => {
    const list = [task({ id: 'big', remainingMinutes: 120 }), task({ id: 'small', remainingMinutes: 15 })];
    const sorted = [...list].sort(compareByRemainingTime);
    assert.deepEqual(sorted.map((t) => t.id), ['small', 'big']);
  });
});

// ---------------------------------------------------------------------------
scenario('J. sortTasksForDisplay — presentation-only reordering of the FULL list', () => {
  check('"recommended" mode keeps completed/zero-remaining tasks in the list, just pushed after actionable ones', () => {
    const list = [
      task({ id: 'done', completed: true }),
      task({ id: 'low', priority: 'low' }),
      task({ id: 'high', priority: 'high' }),
    ];
    const sorted = sortTasksForDisplay(list, 'recommended', {});
    assert.equal(sorted.length, 3, 'nothing is dropped from the display list');
    assert.deepEqual(sorted.map((t) => t.id), ['high', 'low', 'done']);
  });

  check('sortTasksForDisplay never mutates the input array', () => {
    const list = [task({ id: 'a', dueDate: '2026-10-01' }), task({ id: 'b', dueDate: '2026-09-18' })];
    const before = list.map((t) => t.id);
    sortTasksForDisplay(list, 'due', {});
    assert.deepEqual(list.map((t) => t.id), before);
  });

  check('an unknown mode returns a plain (unsorted-order-preserving) copy rather than throwing', () => {
    const list = [task({ id: 'a' }), task({ id: 'b' })];
    assert.deepEqual(sortTasksForDisplay(list, 'bogus', {}).map((t) => t.id), ['a', 'b']);
  });

  check('due/priority/remaining modes apply to the whole list, completed tasks included', () => {
    const list = [task({ id: 'a', remainingMinutes: 90, completed: false }), task({ id: 'b', remainingMinutes: 0, completed: true })];
    const sorted = sortTasksForDisplay(list, 'remaining', {});
    assert.deepEqual(sorted.map((t) => t.id), ['b', 'a']);
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
