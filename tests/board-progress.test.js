// Tests for V2-D Board status / Planner reflection / progress. Plain Node,
// no DOM, no Supabase — boardModel.js's pure functions only. Run with
// `npm test` or `node tests/board-progress.test.js`.

import assert from 'node:assert/strict';
import {
  NODE_TYPES,
  isValidNodeType,
  NODE_STATUSES,
  isValidNodeStatus,
  normalizeNodeStatus,
  normalizeNodeDueDate,
  normalizeNodeEstimate,
  derivePlannerStatus,
  buildPlannerStatusMap,
  effectiveNodeStatus,
  computeProgress,
  computeNodeProgress,
  classifyNodeDue,
  studyTaskDefaultsFromNode,
} from '../src/board/boardModel.js';

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

const block = (subjectId, start, end, extra = {}) => ({
  item_type: 'study',
  source_subject_id: subjectId,
  start_minutes: start,
  end_minutes: end,
  completed: false,
  completed_minutes: 0,
  ...extra,
});

// ---------------------------------------------------------------------------
scenario('A. Types, statuses, field normalization', () => {
  check('milestone is a valid node type; existing types still valid', () => {
    assert.equal(isValidNodeType('milestone'), true);
    ['goal', 'subject', 'task', 'note'].forEach((t) => assert.equal(isValidNodeType(t), true));
    assert.equal(NODE_TYPES.length, 5);
  });
  check('statuses', () => {
    assert.deepEqual(NODE_STATUSES, ['planned', 'in_progress', 'done']);
    assert.equal(isValidNodeStatus('done'), true);
    assert.equal(isValidNodeStatus('blocked'), false);
    assert.equal(normalizeNodeStatus(undefined), 'planned'); // pre-migration rows
    assert.equal(normalizeNodeStatus('nonsense'), 'planned');
  });
  check('due date: real dates pass, everything else is null', () => {
    assert.equal(normalizeNodeDueDate('2026-10-15'), '2026-10-15');
    assert.equal(normalizeNodeDueDate('2026-02-30'), null);
    assert.equal(normalizeNodeDueDate('10/15/2026'), null);
    assert.equal(normalizeNodeDueDate(''), null);
    assert.equal(normalizeNodeDueDate(null), null);
  });
  check('estimate: positive whole minutes, capped, else null', () => {
    assert.equal(normalizeNodeEstimate('90'), 90);
    assert.equal(normalizeNodeEstimate(44.6), 45);
    assert.equal(normalizeNodeEstimate(0), null);
    assert.equal(normalizeNodeEstimate(-10), null);
    assert.equal(normalizeNodeEstimate(''), null);
    assert.equal(normalizeNodeEstimate('  '), null);
    assert.equal(normalizeNodeEstimate('abc'), null);
    assert.equal(normalizeNodeEstimate(999999), 10080);
  });
});

// ---------------------------------------------------------------------------
scenario('B. Planner status derived from schedule_items', () => {
  check('no link -> null; no blocks -> not_scheduled', () => {
    assert.equal(derivePlannerStatus(null, []), null);
    assert.equal(derivePlannerStatus('s1', [block('other', 0, 60)]), 'not_scheduled');
  });
  // V2-G: the Board now uses the shared status model (statusModel.js), so a
  // linked node reads exactly like the same task in the Planner/Tasks list.
  check('blocks, nothing logged -> planned', () => {
    assert.equal(derivePlannerStatus('s1', [block('s1', 0, 60), block('s1', 100, 160)]), 'planned');
  });
  check('partial minutes or one block done -> partial', () => {
    assert.equal(derivePlannerStatus('s1', [block('s1', 0, 60, { completed_minutes: 20 }), block('s1', 100, 160)]), 'partial');
    assert.equal(derivePlannerStatus('s1', [block('s1', 0, 60, { completed: true }), block('s1', 100, 160)]), 'partial');
  });
  check("a block of today's happening now -> in_progress (same as the Planner)", () => {
    const blocks = [block('s1', 600, 660, { isToday: true }), block('s1', 900, 960)];
    assert.equal(derivePlannerStatus('s1', blocks, { nowMinutes: 630 }), 'in_progress');
    assert.equal(derivePlannerStatus('s1', blocks, { nowMinutes: 700 }), 'planned');
    // the same clock time on a NON-today block never counts as in progress
    assert.equal(derivePlannerStatus('s1', [block('s1', 600, 660)], { nowMinutes: 630 }), 'planned');
  });
  check('missed and carried-over blocks surface on the Board too', () => {
    assert.equal(derivePlannerStatus('s1', [block('s1', 0, 60, { missed: true }), block('s1', 100, 160, { completed: true })]), 'missed');
    assert.equal(derivePlannerStatus('s1', [block('s1', 0, 60, { missed: true, carried_over_minutes: 60 })]), 'carried_over');
  });
  check('every block fully completed -> done (by flag or by minutes)', () => {
    assert.equal(
      derivePlannerStatus('s1', [block('s1', 0, 60, { completed: true }), block('s1', 100, 160, { completed_minutes: 60 })]),
      'done'
    );
  });
  check('Focus Mode "complete early" (completed=true, fewer minutes) still reads done', () => {
    assert.equal(derivePlannerStatus('s1', [block('s1', 0, 90, { completed: true, completed_minutes: 72 })]), 'done');
  });
  check('non-study items are ignored', () => {
    assert.equal(derivePlannerStatus('s1', [{ ...block('s1', 0, 60), item_type: 'break', completed: true }]), 'not_scheduled');
  });
  check('status map covers each linked node once', () => {
    const map = buildPlannerStatusMap(
      [{ id: 'n1', linked_study_subject_id: 's1' }, { id: 'n2', linked_study_subject_id: 's1' }, { id: 'n3' }],
      [block('s1', 0, 60, { completed: true })]
    );
    assert.equal(map.size, 1);
    assert.equal(map.get('s1'), 'done');
  });
});

// ---------------------------------------------------------------------------
scenario('C. Effective status: linked follows Planner, unlinked follows student', () => {
  const map = new Map([['s1', 'done'], ['s2', 'in_progress'], ['s3', 'planned'], ['s4', 'not_scheduled'], ['s5', 'missed'], ['s6', 'bogus']]);
  check('unlinked node shows its stored status', () => {
    assert.equal(effectiveNodeStatus({ status: 'in_progress' }, map), 'in_progress');
    assert.equal(effectiveNodeStatus({}, map), 'planned');
  });
  check('linked node shows the Planner status, overriding stored', () => {
    assert.equal(effectiveNodeStatus({ status: 'planned', linked_study_subject_id: 's1' }, map), 'done');
    assert.equal(effectiveNodeStatus({ status: 'done', linked_study_subject_id: 's2' }, map), 'in_progress');
    assert.equal(effectiveNodeStatus({ status: 'done', linked_study_subject_id: 's3' }, map), 'planned');
    assert.equal(effectiveNodeStatus({ status: 'done', linked_study_subject_id: 's4' }, map), 'planned');
    assert.equal(effectiveNodeStatus({ status: 'planned', linked_study_subject_id: 's5' }, map), 'missed');
  });
  check('an unrecognized Planner status falls back to the stored one', () => {
    assert.equal(effectiveNodeStatus({ status: 'in_progress', linked_study_subject_id: 's6' }, map), 'in_progress');
  });
  check('linked node with unknown Planner status falls back to stored (no guessing)', () => {
    assert.equal(effectiveNodeStatus({ status: 'in_progress', linked_study_subject_id: 'missing' }, map), 'in_progress');
    assert.equal(effectiveNodeStatus({ status: 'done', linked_study_subject_id: 's1' }, null), 'done');
  });
  check('effectiveNodeStatus never mutates the node (display-only)', () => {
    const node = Object.freeze({ status: 'planned', linked_study_subject_id: 's1' });
    effectiveNodeStatus(node, map);
    assert.equal(node.status, 'planned');
  });
});

// ---------------------------------------------------------------------------
scenario('D. Progress', () => {
  // CS Project goal -> 7 tasks/milestones (4 done), plus a note and a sub-goal
  const nodes = [
    { id: 'g', node_type: 'goal' },
    { id: 't1', node_type: 'task', status: 'done' },
    { id: 't2', node_type: 'task', status: 'done' },
    { id: 't3', node_type: 'task', status: 'in_progress' },
    { id: 't4', node_type: 'task', linked_study_subject_id: 's1' }, // Planner says done
    { id: 't5', node_type: 'task', linked_study_subject_id: 's2', status: 'done' }, // Planner says planned
    { id: 'm1', node_type: 'milestone', status: 'done' },
    { id: 'm2', node_type: 'milestone' },
    { id: 'n', node_type: 'note', status: 'done' },
    { id: 'other', node_type: 'task', status: 'done' }, // not under g
  ];
  const edges = [
    { source_node_id: 'g', target_node_id: 't1' },
    { source_node_id: 'g', target_node_id: 't2' },
    { source_node_id: 'g', target_node_id: 't3' },
    { source_node_id: 'g', target_node_id: 't4' },
    { source_node_id: 'g', target_node_id: 't5' },
    { source_node_id: 'g', target_node_id: 'm1' },
    { source_node_id: 'm1', target_node_id: 'm2' }, // nested — still counted
    { source_node_id: 'g', target_node_id: 'n' },
  ];
  const map = new Map([['s1', 'done'], ['s2', 'planned']]);

  check('goal progress: 4 / 7, 57% (notes and outside nodes excluded)', () => {
    assert.deepEqual(computeNodeProgress(nodes, edges, 'g', map), { done: 4, total: 7, percent: 57 });
  });
  check('board progress counts every task/milestone on the board', () => {
    assert.deepEqual(computeProgress(nodes, map), { done: 5, total: 8, percent: 63 });
  });
  check('a Planner completion changes progress without any node write', () => {
    const before = computeNodeProgress(nodes, edges, 'g', map);
    const after = computeNodeProgress(nodes, edges, 'g', new Map([['s1', 'done'], ['s2', 'done']]));
    assert.equal(after.done, before.done + 1);
    assert.equal(nodes.find((n) => n.id === 't5').status, 'done'); // stored value untouched
  });
  check('nothing to count -> percent null, not 0', () => {
    assert.deepEqual(computeProgress([{ id: 'n', node_type: 'note' }], map), { done: 0, total: 0, percent: null });
    assert.deepEqual(computeNodeProgress(nodes, null, 'g', map), { done: 0, total: 0, percent: null });
    assert.deepEqual(computeProgress(null), { done: 0, total: 0, percent: null });
  });
});

// ---------------------------------------------------------------------------
scenario('E. Due state and Send-to-Planner prefill', () => {
  const today = '2026-10-06';
  check('overdue / today / upcoming / none', () => {
    assert.equal(classifyNodeDue({ due_date: '2026-10-01' }, today), 'overdue');
    assert.equal(classifyNodeDue({ due_date: today }, today), 'today');
    assert.equal(classifyNodeDue({ due_date: '2026-10-20' }, today), 'upcoming');
    assert.equal(classifyNodeDue({}, today), null);
    assert.equal(classifyNodeDue({ due_date: 'garbage' }, today), null);
  });
  check('a done node is never overdue (incl. done via Planner)', () => {
    assert.equal(classifyNodeDue({ due_date: '2026-10-01', status: 'done' }, today), 'done');
    assert.equal(
      classifyNodeDue({ due_date: '2026-10-01', linked_study_subject_id: 's1' }, today, new Map([['s1', 'done']])),
      'done'
    );
  });
  check('conversion form prefills minutes and due date from the node', () => {
    const d = studyTaskDefaultsFromNode({ title: 'CS Project', estimated_minutes: 120, due_date: '2026-10-15' });
    assert.equal(d.minutes_requested, 120);
    assert.equal(d.due_date, '2026-10-15');
  });
  check('unset or invalid node fields prefill nothing', () => {
    const d = studyTaskDefaultsFromNode({ title: 'x', estimated_minutes: 0, due_date: 'nope' });
    assert.equal(d.minutes_requested, null);
    assert.equal(d.due_date, null);
  });
});

console.log('\n------------------------');
if (totalFailures > 0) {
  console.log(`${totalFailures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
