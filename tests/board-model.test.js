// Plain Node tests for the pure Visual Board model logic in
// src/board/boardModel.js. No DOM, no Supabase. Run with `npm test` or
// `node tests/board-model.test.js`.
//
// A second block of scenarios simulates the Supabase-backed create/delete
// flow with a small in-memory FakeStore (same technique used in
// lock-regenerate.test.js / copy-schedule.test.js) so the cascade behavior
// documented in supabase/migrations/0002_boards.sql (deleting a node
// removes its edges) is verified at the model level without a live project.

import assert from 'node:assert/strict';
import {
  NODE_TYPES,
  isValidNodeType,
  normalizePosition,
  normalizeNodePosition,
  normalizeNodeTitle,
  isSelfEdge,
  isDuplicateEdge,
  validateNewEdge,
  removeEdgesForNode,
  edgesTouchingNode,
  nextNodePosition,
  createNodeDefaults,
  computeDragPosition,
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

// ---------------------------------------------------------------------------
scenario('A. Node type validation', () => {
  check('goal/subject/task/note are all valid', () => {
    for (const t of NODE_TYPES) assert.equal(isValidNodeType(t), true);
  });
  check('an unknown type is rejected', () => assert.equal(isValidNodeType('project'), false));
  check('empty string is rejected', () => assert.equal(isValidNodeType(''), false));
  check('undefined is rejected', () => assert.equal(isValidNodeType(undefined), false));
});

// ---------------------------------------------------------------------------
scenario('B. Node position normalization', () => {
  check('a normal number passes through unchanged', () => assert.equal(normalizePosition(120.5), 120.5));
  check('a numeric string is parsed', () => assert.equal(normalizePosition('84'), 84));
  check('undefined defaults to 0', () => assert.equal(normalizePosition(undefined), 0));
  check('null defaults to 0', () => assert.equal(normalizePosition(null), 0));
  check('NaN defaults to 0', () => assert.equal(normalizePosition(NaN), 0));
  check('Infinity defaults to 0', () => assert.equal(normalizePosition(Infinity), 0));
  check('a non-numeric string defaults to 0', () => assert.equal(normalizePosition('abc'), 0));
  check('negative coordinates are allowed (board can extend left/up of origin)', () => assert.equal(normalizePosition(-40), -40));

  check('normalizeNodePosition returns both axes normalized together', () => {
    assert.deepEqual(normalizeNodePosition('10', undefined), { x_position: 10, y_position: 0 });
  });
});

// ---------------------------------------------------------------------------
scenario('C. Node title normalization', () => {
  check('a string passes through', () => assert.equal(normalizeNodeTitle('Physics'), 'Physics'));
  check('undefined becomes an empty string, never null', () => assert.equal(normalizeNodeTitle(undefined), ''));
  check('null becomes an empty string', () => assert.equal(normalizeNodeTitle(null), ''));
});

// ---------------------------------------------------------------------------
scenario('D. Self-edge prevention', () => {
  check('a node connecting to itself is a self-edge', () => assert.equal(isSelfEdge('n1', 'n1'), true));
  check('two different nodes are not a self-edge', () => assert.equal(isSelfEdge('n1', 'n2'), false));

  check('validateNewEdge rejects a self-edge', () => {
    const result = validateNewEdge([], 'n1', 'n1');
    assert.equal(result.valid, false);
    assert.match(result.error, /cannot connect to itself/i);
  });
});

// ---------------------------------------------------------------------------
scenario('E. Duplicate edge prevention', () => {
  const edges = [{ id: 'e1', source_node_id: 'n1', target_node_id: 'n2' }];

  check('the same source/target pair is flagged as a duplicate', () => assert.equal(isDuplicateEdge(edges, 'n1', 'n2'), true));
  check('the reverse direction is NOT flagged (parent/child direction matters)', () => assert.equal(isDuplicateEdge(edges, 'n2', 'n1'), false));
  check('a different pair is not a duplicate', () => assert.equal(isDuplicateEdge(edges, 'n1', 'n3'), false));

  check('validateNewEdge rejects an exact duplicate', () => {
    const result = validateNewEdge(edges, 'n1', 'n2');
    assert.equal(result.valid, false);
    assert.match(result.error, /already connected/i);
  });
  check('validateNewEdge accepts the reverse direction', () => {
    const result = validateNewEdge(edges, 'n2', 'n1');
    assert.equal(result.valid, true);
  });
  check('validateNewEdge accepts a brand-new pair', () => {
    const result = validateNewEdge(edges, 'n1', 'n3');
    assert.equal(result.valid, true);
    assert.equal(result.error, null);
  });
  check('validateNewEdge rejects a missing source or target', () => {
    assert.equal(validateNewEdge(edges, '', 'n2').valid, false);
    assert.equal(validateNewEdge(edges, 'n1', '').valid, false);
  });
});

// ---------------------------------------------------------------------------
scenario('F. Deleting a node invalidates its edges at the model level', () => {
  const edges = [
    { id: 'e1', source_node_id: 'n1', target_node_id: 'n2' }, // touches n2
    { id: 'e2', source_node_id: 'n3', target_node_id: 'n1' }, // touches n1
    { id: 'e3', source_node_id: 'n2', target_node_id: 'n3' }, // untouched by n1
  ];

  check('edgesTouchingNode finds edges where the node is source OR target', () => {
    const touching = edgesTouchingNode(edges, 'n1');
    assert.equal(touching.length, 2);
    assert.deepEqual(touching.map((e) => e.id).sort(), ['e1', 'e2']);
  });

  check('removeEdgesForNode drops every edge touching the deleted node', () => {
    const remaining = removeEdgesForNode(edges, 'n1');
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, 'e3');
  });

  check('deleting a node with no edges leaves every edge intact', () => {
    const remaining = removeEdgesForNode(edges, 'n999');
    assert.equal(remaining.length, 3);
  });
});

// ---------------------------------------------------------------------------
scenario('G. New-node placement (nextNodePosition / createNodeDefaults)', () => {
  check('the first node (count 0) lands at the grid origin/margin', () => {
    assert.deepEqual(nextNodePosition(0), { x_position: 40, y_position: 40 });
  });
  check('the second node is placed one column over, same row', () => {
    const first = nextNodePosition(0);
    const second = nextNodePosition(1);
    assert.equal(second.y_position, first.y_position);
    assert.notEqual(second.x_position, first.x_position);
  });
  check('the 5th node (count 4) wraps to a new row, back to the first column', () => {
    const wrapped = nextNodePosition(4);
    const first = nextNodePosition(0);
    assert.equal(wrapped.x_position, first.x_position);
    assert.notEqual(wrapped.y_position, first.y_position);
  });
  check('positions are deterministic — the same count always gives the same spot', () => {
    assert.deepEqual(nextNodePosition(7), nextNodePosition(7));
  });
  check('a negative or non-finite count falls back to the first slot', () => {
    assert.deepEqual(nextNodePosition(-3), nextNodePosition(0));
    assert.deepEqual(nextNodePosition(NaN), nextNodePosition(0));
  });

  check('createNodeDefaults defaults to node_type "note" and an empty title', () => {
    const node = createNodeDefaults(0);
    assert.equal(node.node_type, 'note');
    assert.equal(node.title, '');
    assert.deepEqual({ x_position: node.x_position, y_position: node.y_position }, nextNodePosition(0));
  });
  check('createNodeDefaults honors a valid requested type', () => {
    assert.equal(createNodeDefaults(0, 'goal').node_type, 'goal');
  });
  check('createNodeDefaults falls back to "note" for an invalid type rather than saving garbage', () => {
    assert.equal(createNodeDefaults(0, 'project').node_type, 'note');
  });
});

// ---------------------------------------------------------------------------
scenario('H. Drag-end position calculation (computeDragPosition)', () => {
  check('no pointer movement means no position change', () => {
    const result = computeDragPosition({
      nodeStartX: 100, nodeStartY: 60,
      pointerStartX: 300, pointerStartY: 200,
      pointerCurrentX: 300, pointerCurrentY: 200,
      zoom: 1,
    });
    assert.deepEqual(result, { x_position: 100, y_position: 60 });
  });
  check('a pointer move at 1x zoom translates the node by the same amount', () => {
    const result = computeDragPosition({
      nodeStartX: 100, nodeStartY: 60,
      pointerStartX: 300, pointerStartY: 200,
      pointerCurrentX: 350, pointerCurrentY: 180,
      zoom: 1,
    });
    assert.deepEqual(result, { x_position: 150, y_position: 40 });
  });
  check('at 2x zoom, a screen-pixel move covers half as much canvas distance', () => {
    const result = computeDragPosition({
      nodeStartX: 100, nodeStartY: 60,
      pointerStartX: 300, pointerStartY: 200,
      pointerCurrentX: 340, pointerCurrentY: 200,
      zoom: 2,
    });
    assert.deepEqual(result, { x_position: 120, y_position: 60 });
  });
  check('at 0.5x zoom, a screen-pixel move covers double the canvas distance', () => {
    const result = computeDragPosition({
      nodeStartX: 100, nodeStartY: 60,
      pointerStartX: 300, pointerStartY: 200,
      pointerCurrentX: 320, pointerCurrentY: 200,
      zoom: 0.5,
    });
    assert.deepEqual(result, { x_position: 140, y_position: 60 });
  });
  check('dragging left/up of the start point produces negative-going coordinates correctly', () => {
    const result = computeDragPosition({
      nodeStartX: 100, nodeStartY: 60,
      pointerStartX: 300, pointerStartY: 200,
      pointerCurrentX: 260, pointerCurrentY: 150,
      zoom: 1,
    });
    assert.deepEqual(result, { x_position: 60, y_position: 10 });
  });
  check('a zoom of 0 is treated as 1x rather than dividing by zero', () => {
    const result = computeDragPosition({
      nodeStartX: 0, nodeStartY: 0,
      pointerStartX: 0, pointerStartY: 0,
      pointerCurrentX: 10, pointerCurrentY: 10,
      zoom: 0,
    });
    assert.deepEqual(result, { x_position: 10, y_position: 10 });
  });
  check('a non-finite pointer value normalizes to 0 rather than producing NaN', () => {
    const result = computeDragPosition({
      nodeStartX: 100, nodeStartY: 60,
      pointerStartX: 300, pointerStartY: 200,
      pointerCurrentX: NaN, pointerCurrentY: 200,
      zoom: 1,
    });
    assert.equal(result.x_position, 0);
    assert.equal(Number.isFinite(result.x_position), true);
  });
});

// ---------------------------------------------------------------------------
// FakeStore simulation: a minimal in-memory stand-in for the Supabase tables
// created by migration 0002, reusing the real pure model functions to
// mirror the ON DELETE CASCADE behavior board_edges has on
// source_node_id/target_node_id. Documented here rather than exercised
// against a live project, same rationale as the other *-navigation/
// *-schedule test files: src/board/boardData.js imports the real Supabase
// client and needs live Vite env vars, so it isn't importable from plain
// Node.
scenario('I. FakeStore: create nodes + edges, then delete a node', () => {
  const store = { nodes: [], edges: [] };
  let nextId = 1;

  function fakeCreateNode(nodeType, title) {
    assert.equal(isValidNodeType(nodeType), true, 'FakeStore only accepts valid node types, same guard as boardData.createNode');
    const node = { id: `n${nextId++}`, node_type: nodeType, title: normalizeNodeTitle(title), ...normalizeNodePosition(0, 0) };
    store.nodes.push(node);
    return node;
  }

  function fakeCreateEdge(sourceId, targetId, relationship = 'related') {
    const { valid, error } = validateNewEdge(store.edges, sourceId, targetId);
    if (!valid) throw new Error(error);
    const edge = { id: `e${nextId++}`, source_node_id: sourceId, target_node_id: targetId, relationship };
    store.edges.push(edge);
    return edge;
  }

  function fakeDeleteNode(nodeId) {
    store.nodes = store.nodes.filter((n) => n.id !== nodeId);
    store.edges = removeEdgesForNode(store.edges, nodeId); // mirrors the DB's ON DELETE CASCADE
  }

  const goal = fakeCreateNode('goal', 'Pass finals');
  const subject = fakeCreateNode('subject', 'Physics');
  const task = fakeCreateNode('task', 'Finish problem set 3');
  fakeCreateEdge(goal.id, subject.id, 'parent');
  fakeCreateEdge(subject.id, task.id, 'parent');

  check('three nodes and two edges exist before deletion', () => {
    assert.equal(store.nodes.length, 3);
    assert.equal(store.edges.length, 2);
  });

  check('creating a duplicate edge is rejected before it reaches the store', () => {
    assert.throws(() => fakeCreateEdge(goal.id, subject.id), /already connected/i);
    assert.equal(store.edges.length, 2, 'the rejected edge must not have been added');
  });

  fakeDeleteNode(subject.id);

  check('deleting the middle node removes it from the store', () => {
    assert.equal(store.nodes.length, 2);
    assert.ok(!store.nodes.some((n) => n.id === subject.id));
  });
  check('both edges touching the deleted node are gone, none dangling', () => {
    assert.equal(store.edges.length, 0);
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
