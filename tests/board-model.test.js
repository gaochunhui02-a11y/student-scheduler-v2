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
  removeEdgeById,
  nodeCenter,
  computeEdgeGeometry,
  edgeMidpoint,
  screenToCanvasPoint,
  studyTaskDefaultsFromNode,
  buildStudyTaskFields,
  isStudyTaskFieldsValid,
  isNodeConverted,
  canConvertNode,
  linkNodeToStudyTask,
  unlinkNodeFromStudyTask,
  ZOOM_MIN,
  ZOOM_MAX,
  clampZoom,
  computeNodesBoundingBox,
  computeFitView,
  computeCenterOnNodeScroll,
  filterNodesByQuery,
  duplicateNodeFields,
  hasChildren,
  getDescendantNodeIds,
  computeHiddenNodeIds,
  computeAutoLayout,
  selectBoardId,
  filterNodesByBoard,
  filterEdgesByBoard,
  clearedBoardViewState,
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
scenario('J. Deleting a single connection (removeEdgeById)', () => {
  const edges = [
    { id: 'e1', source_node_id: 'n1', target_node_id: 'n2' },
    { id: 'e2', source_node_id: 'n2', target_node_id: 'n3' },
  ];

  check('the targeted edge is removed, the other is untouched', () => {
    const remaining = removeEdgeById(edges, 'e1');
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, 'e2');
  });
  check('deleting a connection never removes either of its nodes (nodes are a separate array)', () => {
    const nodes = [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }];
    removeEdgeById(edges, 'e1');
    assert.equal(nodes.length, 3);
  });
  check('deleting an id that is not present leaves every edge intact', () => {
    const remaining = removeEdgeById(edges, 'e999');
    assert.equal(remaining.length, 2);
  });
  check('the original array is not mutated (a fresh array is returned)', () => {
    const before = edges.length;
    removeEdgeById(edges, 'e1');
    assert.equal(edges.length, before);
  });
});

// ---------------------------------------------------------------------------
scenario('K. Edge geometry (nodeCenter / computeEdgeGeometry / edgeMidpoint / screenToCanvasPoint)', () => {
  const width = 200;
  const height = 100;
  const source = { id: 'n1', x_position: 0, y_position: 0 };
  const target = { id: 'n2', x_position: 400, y_position: 200 };

  check('nodeCenter is the node\'s top-left position offset by half its size', () => {
    assert.deepEqual(nodeCenter(source, width, height), { x: 100, y: 50 });
    assert.deepEqual(nodeCenter(target, width, height), { x: 500, y: 250 });
  });
  check('nodeCenter normalizes a missing/invalid position rather than producing NaN', () => {
    const center = nodeCenter({ x_position: undefined, y_position: NaN }, width, height);
    assert.deepEqual(center, { x: 100, y: 50 });
  });

  check('computeEdgeGeometry connects the two nodes\' centers', () => {
    const geo = computeEdgeGeometry(source, target, width, height);
    assert.deepEqual(geo, { x1: 100, y1: 50, x2: 500, y2: 250 });
  });
  check('computeEdgeGeometry is direction-sensitive (source/target order matters for x1,y1 vs x2,y2)', () => {
    const forward = computeEdgeGeometry(source, target, width, height);
    const reverse = computeEdgeGeometry(target, source, width, height);
    assert.equal(forward.x1, reverse.x2);
    assert.equal(forward.x2, reverse.x1);
  });

  check('edgeMidpoint is the arithmetic midpoint of the two endpoints', () => {
    assert.deepEqual(edgeMidpoint(100, 50, 500, 250), { x: 300, y: 150 });
  });
  check('edgeMidpoint of a zero-length line is that same point', () => {
    assert.deepEqual(edgeMidpoint(20, 20, 20, 20), { x: 20, y: 20 });
  });

  check('screenToCanvasPoint subtracts the canvas origin and divides by zoom', () => {
    const point = screenToCanvasPoint({ canvasLeft: 50, canvasTop: 30, clientX: 150, clientY: 130, zoom: 1 });
    assert.deepEqual(point, { x: 100, y: 100 });
  });
  check('screenToCanvasPoint at 2x zoom halves the on-screen offset', () => {
    const point = screenToCanvasPoint({ canvasLeft: 0, canvasTop: 0, clientX: 200, clientY: 100, zoom: 2 });
    assert.deepEqual(point, { x: 100, y: 50 });
  });
  check('screenToCanvasPoint treats a zoom of 0 as 1x rather than dividing by zero', () => {
    const point = screenToCanvasPoint({ canvasLeft: 0, canvasTop: 0, clientX: 40, clientY: 40, zoom: 0 });
    assert.deepEqual(point, { x: 40, y: 40 });
  });
});

// ---------------------------------------------------------------------------
scenario('L. Convert node to study task — field mapping', () => {
  check('the node title maps to the study task name', () => {
    const defaults = studyTaskDefaultsFromNode({ title: 'Finish Python Assignment' });
    assert.equal(defaults.name, 'Finish Python Assignment');
  });
  check('a missing/blank node title maps to an empty name, never null/undefined', () => {
    assert.equal(studyTaskDefaultsFromNode({ title: undefined }).name, '');
    assert.equal(studyTaskDefaultsFromNode({}).name, '');
  });
  check('defaults leave minutes/due date unset and priority at medium, same as a manual row', () => {
    const defaults = studyTaskDefaultsFromNode({ title: 'x' });
    assert.equal(defaults.minutes_requested, null);
    assert.equal(defaults.due_date, null);
    assert.equal(defaults.priority, 'medium');
    assert.equal(defaults.notes, '');
  });

  check('minutes map correctly: a valid whole number passes through', () => {
    assert.equal(buildStudyTaskFields({ name: 'x', minutes: 45 }).minutes_requested, 45);
  });
  check('minutes map correctly: a numeric string is parsed', () => {
    assert.equal(buildStudyTaskFields({ name: 'x', minutes: '30' }).minutes_requested, 30);
  });
  check('minutes map correctly: zero, negative, non-numeric, or missing all map to null (invalid)', () => {
    assert.equal(buildStudyTaskFields({ name: 'x', minutes: 0 }).minutes_requested, null);
    assert.equal(buildStudyTaskFields({ name: 'x', minutes: -10 }).minutes_requested, null);
    assert.equal(buildStudyTaskFields({ name: 'x', minutes: 'abc' }).minutes_requested, null);
    assert.equal(buildStudyTaskFields({ name: 'x' }).minutes_requested, null);
  });

  check('priority maps correctly: low/medium/high pass through unchanged', () => {
    assert.equal(buildStudyTaskFields({ name: 'x', priority: 'low' }).priority, 'low');
    assert.equal(buildStudyTaskFields({ name: 'x', priority: 'high' }).priority, 'high');
  });
  check('priority maps correctly: anything else falls back to medium, matching the study_subjects check constraint', () => {
    assert.equal(buildStudyTaskFields({ name: 'x', priority: 'urgent' }).priority, 'medium');
    assert.equal(buildStudyTaskFields({ name: 'x', priority: undefined }).priority, 'medium');
  });

  check('due date maps correctly: a provided date passes through', () => {
    assert.equal(buildStudyTaskFields({ name: 'x', dueDate: '2026-01-15' }).due_date, '2026-01-15');
  });
  check('due date maps correctly: blank/missing maps to null, not an empty string', () => {
    assert.equal(buildStudyTaskFields({ name: 'x', dueDate: '' }).due_date, null);
    assert.equal(buildStudyTaskFields({ name: 'x' }).due_date, null);
  });

  check('notes map correctly: trimmed, defaulting to an empty string', () => {
    assert.equal(buildStudyTaskFields({ name: 'x', notes: '  bring textbook  ' }).notes, 'bring textbook');
    assert.equal(buildStudyTaskFields({ name: 'x' }).notes, '');
  });

  check('the task name is trimmed and required', () => {
    assert.equal(buildStudyTaskFields({ name: '  Physics  ', minutes: 30 }).name, 'Physics');
    assert.equal(isStudyTaskFieldsValid(buildStudyTaskFields({ name: '   ', minutes: 30 })), false);
  });

  check('a complete, valid field set passes isStudyTaskFieldsValid', () => {
    const fields = buildStudyTaskFields({ name: 'Physics', minutes: 30, priority: 'high', dueDate: '2026-02-01', notes: 'ch.4' });
    assert.equal(isStudyTaskFieldsValid(fields), true);
  });
  check('a field set missing minutes fails isStudyTaskFieldsValid', () => {
    const fields = buildStudyTaskFields({ name: 'Physics' });
    assert.equal(isStudyTaskFieldsValid(fields), false);
  });
});

// ---------------------------------------------------------------------------
scenario('M. Convert node to study task — linking, duplicate prevention, deletion safety', () => {
  check('a fresh node is not converted and can be converted', () => {
    const node = { id: 'n1', linked_study_subject_id: null };
    assert.equal(isNodeConverted(node), false);
    assert.equal(canConvertNode(node), true);
  });
  check('linkNodeToStudyTask stores the id and returns a NEW object (does not mutate the input)', () => {
    const node = { id: 'n1', title: 'Finish Python Assignment', linked_study_subject_id: null };
    const linked = linkNodeToStudyTask(node, 'study-123');
    assert.equal(linked.linked_study_subject_id, 'study-123');
    assert.equal(node.linked_study_subject_id, null, 'the original node object must be untouched');
    assert.equal(linked.title, node.title, 'unrelated fields are preserved');
  });
  check('once linked, the node is considered converted and cannot be converted again', () => {
    const linked = linkNodeToStudyTask({ id: 'n1', linked_study_subject_id: null }, 'study-123');
    assert.equal(isNodeConverted(linked), true);
    assert.equal(canConvertNode(linked), false, 'this is the guard that prevents a duplicate study_subjects row');
  });
  check('unlinkNodeFromStudyTask models what happens if the linked study task is deleted elsewhere', () => {
    const linked = linkNodeToStudyTask({ id: 'n1', linked_study_subject_id: null }, 'study-123');
    const unlinked = unlinkNodeFromStudyTask(linked);
    assert.equal(unlinked.linked_study_subject_id, null);
    assert.equal(canConvertNode(unlinked), true, 'a node whose study task was deleted elsewhere becomes convertible again');
  });

  // FakeStore: a Board node store and a completely separate study-task
  // store, mirroring the real architecture (board_nodes vs study_subjects
  // are different tables). Deleting a node must only ever touch the first.
  check('deleting a Board node does not delete its linked study task', () => {
    let boardNodes = [
      { id: 'n1', title: 'Finish Python Assignment', linked_study_subject_id: 'study-1' },
      { id: 'n2', title: 'Read chapter 3', linked_study_subject_id: null },
    ];
    const studyTasks = [{ id: 'study-1', name: 'Finish Python Assignment', minutes_requested: 60 }];

    // fakeDeleteNode — exactly what board.js's deleteNode click handler
    // does at the model level: remove the node from the local node array.
    // It never reads or writes `studyTasks` at all.
    function fakeDeleteNode(nodeId) {
      boardNodes = boardNodes.filter((n) => n.id !== nodeId);
    }

    fakeDeleteNode('n1');

    assert.equal(boardNodes.length, 1, 'the node itself is gone');
    assert.equal(studyTasks.length, 1, 'the study task it was linked to still exists, untouched');
    assert.equal(studyTasks[0].id, 'study-1');
    assert.equal(studyTasks[0].name, 'Finish Python Assignment');
  });
});

// ---------------------------------------------------------------------------
scenario('N. Zoom clamping (clampZoom)', () => {
  check('a value inside the range passes through (rounded to the nearest 1%)', () => {
    assert.equal(clampZoom(1.234), 1.23);
  });
  check('a value above the max is clamped to ZOOM_MAX', () => {
    assert.equal(clampZoom(5), ZOOM_MAX);
  });
  check('a value below the min is clamped to ZOOM_MIN', () => {
    assert.equal(clampZoom(0.01), ZOOM_MIN);
  });
  check('a non-numeric value falls back to 1x rather than NaN', () => {
    assert.equal(clampZoom('abc'), 1);
    assert.equal(clampZoom(undefined), 1);
    assert.equal(clampZoom(NaN), 1);
  });
  check('custom min/max are respected', () => {
    assert.equal(clampZoom(10, 0.25, 4), 4);
    assert.equal(clampZoom(-1, 0.25, 4), 0.25);
  });
});

// ---------------------------------------------------------------------------
scenario('O. Pan/zoom coordinate conversion — bounding box, fit-to-board, center-on-node', () => {
  const width = 200;
  const height = 100;

  check('computeNodesBoundingBox returns null for an empty board', () => {
    assert.equal(computeNodesBoundingBox([], width, height), null);
  });
  check('computeNodesBoundingBox wraps every node card exactly', () => {
    const nodes = [
      { id: 'a', x_position: 0, y_position: 0 },
      { id: 'b', x_position: 400, y_position: 300 },
    ];
    const bbox = computeNodesBoundingBox(nodes, width, height);
    assert.deepEqual(bbox, { minX: 0, minY: 0, maxX: 600, maxY: 400 });
  });
  check('computeNodesBoundingBox handles a single node', () => {
    const bbox = computeNodesBoundingBox([{ id: 'a', x_position: 50, y_position: 20 }], width, height);
    assert.deepEqual(bbox, { minX: 50, minY: 20, maxX: 250, maxY: 120 });
  });

  check('computeFitView degrades to a safe default with no bbox/viewport', () => {
    assert.deepEqual(computeFitView({ bbox: null, viewportWidth: 800, viewportHeight: 600 }), { zoom: 1, scrollLeft: 0, scrollTop: 0 });
    assert.deepEqual(computeFitView({ bbox: { minX: 0, minY: 0, maxX: 100, maxY: 100 }, viewportWidth: 0, viewportHeight: 0 }), {
      zoom: 1,
      scrollLeft: 0,
      scrollTop: 0,
    });
  });
  check('computeFitView picks the more constraining axis and clamps to the zoom limits', () => {
    // A very wide, short bbox in a roughly square viewport is width-constrained.
    const wide = computeFitView({ bbox: { minX: 0, minY: 0, maxX: 2000, maxY: 100 }, viewportWidth: 1000, viewportHeight: 1000 });
    assert.ok(wide.zoom < 1, 'must shrink to fit the very wide box');
    assert.ok(wide.zoom >= ZOOM_MIN && wide.zoom <= ZOOM_MAX);

    // A tiny bbox in a huge viewport would compute a huge zoom — must clamp.
    const tiny = computeFitView({ bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, viewportWidth: 2000, viewportHeight: 2000 });
    assert.equal(tiny.zoom, ZOOM_MAX);
  });
  check('computeFitView centers the bbox in the viewport (never a negative scroll)', () => {
    const view = computeFitView({ bbox: { minX: 100, minY: 100, maxX: 300, maxY: 300 }, viewportWidth: 1000, viewportHeight: 1000 });
    assert.ok(view.scrollLeft >= 0 && view.scrollTop >= 0);
  });

  check('computeCenterOnNodeScroll centers the node without changing zoom', () => {
    const node = { x_position: 500, y_position: 500 };
    const result = computeCenterOnNodeScroll({ node, nodeWidth: width, nodeHeight: height, viewportWidth: 800, viewportHeight: 600, zoom: 1 });
    // node center = (600, 550); centered scroll = center*zoom - viewport/2
    assert.deepEqual(result, { scrollLeft: 600 - 400, scrollTop: 550 - 300 });
  });
  check('computeCenterOnNodeScroll accounts for the current zoom level', () => {
    const node = { x_position: 100, y_position: 100 };
    const result = computeCenterOnNodeScroll({ node, nodeWidth: width, nodeHeight: height, viewportWidth: 400, viewportHeight: 400, zoom: 2 });
    // node center = (200, 150); at 2x, rendered position = (400, 300); scroll = rendered - viewport/2
    assert.deepEqual(result, { scrollLeft: 400 - 200, scrollTop: 300 - 200 });
  });
  check('computeCenterOnNodeScroll never returns a negative scroll (near the origin)', () => {
    const node = { x_position: 0, y_position: 0 };
    const result = computeCenterOnNodeScroll({ node, nodeWidth: width, nodeHeight: height, viewportWidth: 800, viewportHeight: 600, zoom: 1 });
    assert.ok(result.scrollLeft >= 0 && result.scrollTop >= 0);
  });
});

// ---------------------------------------------------------------------------
scenario('P. Search nodes (filterNodesByQuery) — read-only', () => {
  const nodes = [
    { id: 'a', title: 'Finish Python Assignment' },
    { id: 'b', title: 'Read chapter 3' },
    { id: 'c', title: 'Practice problems' },
    { id: 'd', title: '' },
  ];

  check('matches are case-insensitive substring matches on the title', () => {
    const matches = filterNodesByQuery(nodes, 'python');
    assert.deepEqual(matches.map((n) => n.id), ['a']);
  });
  check('a broader query can match multiple nodes', () => {
    const matches = filterNodesByQuery(nodes, 'r'); // "Read chapteR" and "PRactice pRoblems", not "Finish Python Assignment"
    assert.deepEqual(matches.map((n) => n.id).sort(), ['b', 'c']);
  });
  check('an empty/blank query returns no results (not every node)', () => {
    assert.deepEqual(filterNodesByQuery(nodes, ''), []);
    assert.deepEqual(filterNodesByQuery(nodes, '   '), []);
  });
  check('a query matching nothing returns an empty array', () => {
    assert.deepEqual(filterNodesByQuery(nodes, 'zzz-no-match'), []);
  });
  check('search never mutates any node in the list', () => {
    const before = JSON.stringify(nodes);
    filterNodesByQuery(nodes, 'python');
    assert.equal(JSON.stringify(nodes), before);
  });
});

// ---------------------------------------------------------------------------
scenario('Q. Duplicate node defaults', () => {
  const original = {
    id: 'n1',
    node_type: 'subject',
    title: 'Physics',
    x_position: 100,
    y_position: 60,
    color: '#ffcc00',
    linked_study_subject_id: 'study-1',
  };

  check('the copy preserves title, type, and color', () => {
    const copy = duplicateNodeFields(original);
    assert.equal(copy.title, 'Physics');
    assert.equal(copy.node_type, 'subject');
    assert.equal(copy.color, '#ffcc00');
  });
  check('the copy is offset from the original, never placed exactly on top of it', () => {
    const copy = duplicateNodeFields(original, 24);
    assert.equal(copy.x_position, 124);
    assert.equal(copy.y_position, 84);
  });
  check('the copy never carries the linked study-task relationship', () => {
    const copy = duplicateNodeFields(original);
    assert.equal('linked_study_subject_id' in copy, false);
  });
  check('an invalid node_type falls back to "note" rather than saving garbage', () => {
    const copy = duplicateNodeFields({ ...original, node_type: 'bogus' });
    assert.equal(copy.node_type, 'note');
  });
  check('a missing/invalid position defaults to 0 before the offset is applied', () => {
    const copy = duplicateNodeFields({ id: 'n2', node_type: 'note', title: '' }, 10);
    assert.equal(copy.x_position, 10);
    assert.equal(copy.y_position, 10);
  });
});

// ---------------------------------------------------------------------------
scenario('R. Descendant discovery for collapse/expand', () => {
  // Midterm Prep -> Calculus -> Chapter 4
  //              -> CS       -> Lab
  const edges = [
    { source_node_id: 'midterm', target_node_id: 'calc' },
    { source_node_id: 'calc', target_node_id: 'ch4' },
    { source_node_id: 'midterm', target_node_id: 'cs' },
    { source_node_id: 'cs', target_node_id: 'lab' },
  ];

  check('hasChildren is true for any node with at least one outgoing edge', () => {
    assert.equal(hasChildren(edges, 'midterm'), true);
    assert.equal(hasChildren(edges, 'calc'), true);
  });
  check('hasChildren is false for a leaf node', () => {
    assert.equal(hasChildren(edges, 'ch4'), false);
    assert.equal(hasChildren(edges, 'lab'), false);
  });

  check('getDescendantNodeIds finds every transitively reachable child, not just direct children', () => {
    const descendants = getDescendantNodeIds(edges, 'midterm').sort();
    assert.deepEqual(descendants, ['calc', 'ch4', 'cs', 'lab']);
  });
  check('getDescendantNodeIds of a leaf is empty', () => {
    assert.deepEqual(getDescendantNodeIds(edges, 'ch4'), []);
  });
  check('collapsing a middle node only hides its own subtree, not siblings', () => {
    assert.deepEqual(getDescendantNodeIds(edges, 'calc'), ['ch4']);
  });

  check('a 2-node cycle (A connects to B and B connects to A) does not infinite-loop', () => {
    const cyclicEdges = [
      { source_node_id: 'a', target_node_id: 'b' },
      { source_node_id: 'b', target_node_id: 'a' },
    ];
    const descendants = getDescendantNodeIds(cyclicEdges, 'a');
    assert.deepEqual(descendants, ['b']); // 'a' itself is excluded, per rootId exclusion
  });

  check('computeHiddenNodeIds unions the descendants of every collapsed node', () => {
    const hidden = computeHiddenNodeIds(edges, ['calc']);
    assert.deepEqual(Array.from(hidden).sort(), ['ch4']);
  });
  check('computeHiddenNodeIds with nothing collapsed hides nothing', () => {
    assert.equal(computeHiddenNodeIds(edges, []).size, 0);
  });
  check('collapsing the root hides the entire subtree', () => {
    const hidden = computeHiddenNodeIds(edges, ['midterm']);
    assert.deepEqual(Array.from(hidden).sort(), ['calc', 'ch4', 'cs', 'lab']);
  });
});

// ---------------------------------------------------------------------------
scenario('S. Auto layout (computeAutoLayout)', () => {
  check('an empty board produces no positions and does not crash', () => {
    assert.deepEqual(computeAutoLayout([], []), {});
  });

  check('a simple parent/children tree is laid out in rows by depth, columns left to right', () => {
    // A -> B, A -> C, C -> D  (matches the Midterm Prep -> Calculus -> Chapter 4 example)
    const nodes = [
      { id: 'A', x_position: 0, y_position: 0 },
      { id: 'B', x_position: 0, y_position: 0 },
      { id: 'C', x_position: 0, y_position: 0 },
      { id: 'D', x_position: 0, y_position: 0 },
    ];
    const edges = [
      { source_node_id: 'A', target_node_id: 'B' },
      { source_node_id: 'A', target_node_id: 'C' },
      { source_node_id: 'C', target_node_id: 'D' },
    ];
    const layout = computeAutoLayout(nodes, edges, { columnWidth: 220, rowHeight: 150, marginX: 40, marginY: 40 });

    // B and D are leaves at different depths but different columns; C sits
    // above D (same column); A is centered over the average of its
    // children's columns.
    assert.equal(layout.B.y_position, 40 + 150, 'B is one row below the root');
    assert.equal(layout.D.y_position, 40 + 300, 'D is two rows below the root');
    assert.equal(layout.C.x_position, layout.D.x_position, 'C sits directly above its only child, D');
    assert.notEqual(layout.B.x_position, layout.C.x_position, 'siblings B and C get different columns');
    assert.equal(layout.A.y_position, 40, 'the root is at depth 0');
  });

  check('relationships are unchanged by auto-layout — it only returns positions', () => {
    const nodes = [{ id: 'A' }, { id: 'B' }];
    const edges = [{ id: 'e1', source_node_id: 'A', target_node_id: 'B' }];
    const before = JSON.stringify(edges);
    computeAutoLayout(nodes, edges);
    assert.equal(JSON.stringify(edges), before, 'computeAutoLayout must never modify the edges array');
  });

  check('a disconnected (edge-less) node still gets a valid, finite position', () => {
    const nodes = [
      { id: 'A', x_position: 0, y_position: 0 },
      { id: 'ISO', x_position: 999, y_position: 999 },
    ];
    const edges = [];
    const layout = computeAutoLayout(nodes, edges);
    assert.ok(Number.isFinite(layout.A.x_position) && Number.isFinite(layout.A.y_position));
    assert.ok(Number.isFinite(layout.ISO.x_position) && Number.isFinite(layout.ISO.y_position));
    assert.notEqual(layout.A.x_position, layout.ISO.x_position, 'two independent roots get different columns');
  });

  check('a 2-node cycle does not crash and both nodes get finite positions', () => {
    const nodes = [{ id: 'A' }, { id: 'B' }];
    const edges = [
      { source_node_id: 'A', target_node_id: 'B' },
      { source_node_id: 'B', target_node_id: 'A' },
    ];
    const layout = computeAutoLayout(nodes, edges);
    assert.ok(Number.isFinite(layout.A.x_position) && Number.isFinite(layout.A.y_position));
    assert.ok(Number.isFinite(layout.B.x_position) && Number.isFinite(layout.B.y_position));
  });

  check('the algorithm is deterministic — running it twice on the same input gives the same result', () => {
    const nodes = [{ id: 'A', x_position: 0 }, { id: 'B', x_position: 0 }, { id: 'C', x_position: 0 }];
    const edges = [
      { source_node_id: 'A', target_node_id: 'B' },
      { source_node_id: 'A', target_node_id: 'C' },
    ];
    assert.deepEqual(computeAutoLayout(nodes, edges), computeAutoLayout(nodes, edges));
  });

  check('root order is stable, based on each root\'s current x position', () => {
    const nodes = [
      { id: 'RIGHT', x_position: 500 },
      { id: 'LEFT', x_position: 0 },
    ];
    const layout = computeAutoLayout(nodes, []);
    assert.ok(layout.LEFT.x_position < layout.RIGHT.x_position, 'the root that was already further left stays further left');
  });
});

// ---------------------------------------------------------------------------
scenario('T. Selecting a Board to open (selectBoardId)', () => {
  const boards = [
    { id: 'b1', title: 'Fall Semester' },
    { id: 'b2', title: 'Personal' },
    { id: 'b3', title: 'Internship' },
  ];

  check('the remembered board is reopened when it still exists', () => {
    assert.equal(selectBoardId(boards, 'b2'), 'b2');
  });
  check('falls back to the first board when nothing was remembered', () => {
    assert.equal(selectBoardId(boards, null), 'b1');
    assert.equal(selectBoardId(boards, undefined), 'b1');
    assert.equal(selectBoardId(boards, ''), 'b1');
  });
  check('falls back to the first board when the remembered board no longer exists (e.g. it was deleted)', () => {
    assert.equal(selectBoardId(boards, 'deleted-board-id'), 'b1');
  });
  check('returns null when the user has no boards at all, remembered or not', () => {
    assert.equal(selectBoardId([], 'b2'), null);
    assert.equal(selectBoardId(null, 'b2'), null);
  });
});

// ---------------------------------------------------------------------------
scenario('U. Board-specific node/edge filtering (filterNodesByBoard / filterEdgesByBoard)', () => {
  const nodes = [
    { id: 'n1', board_id: 'boardA', title: 'A1' },
    { id: 'n2', board_id: 'boardA', title: 'A2' },
    { id: 'n3', board_id: 'boardB', title: 'B1' },
  ];
  const edges = [
    { id: 'e1', board_id: 'boardA', source_node_id: 'n1', target_node_id: 'n2' },
    { id: 'e2', board_id: 'boardB', source_node_id: 'n3', target_node_id: 'n3' },
  ];

  check('filterNodesByBoard returns only nodes belonging to the given board', () => {
    assert.deepEqual(filterNodesByBoard(nodes, 'boardA').map((n) => n.id).sort(), ['n1', 'n2']);
    assert.deepEqual(filterNodesByBoard(nodes, 'boardB').map((n) => n.id), ['n3']);
  });
  check('filterEdgesByBoard returns only edges belonging to the given board', () => {
    assert.deepEqual(filterEdgesByBoard(edges, 'boardA').map((e) => e.id), ['e1']);
    assert.deepEqual(filterEdgesByBoard(edges, 'boardB').map((e) => e.id), ['e2']);
  });
  check('a board id with nothing in it returns an empty array, not everything', () => {
    assert.deepEqual(filterNodesByBoard(nodes, 'boardC'), []);
    assert.deepEqual(filterEdgesByBoard(edges, 'boardC'), []);
  });
  check('null/undefined input lists are handled without throwing', () => {
    assert.deepEqual(filterNodesByBoard(null, 'boardA'), []);
    assert.deepEqual(filterEdgesByBoard(undefined, 'boardA'), []);
  });
});

// ---------------------------------------------------------------------------
scenario('V. Switching Boards clears previous rendered state (clearedBoardViewState)', () => {
  check('returns a fully empty slate', () => {
    const state = clearedBoardViewState();
    assert.deepEqual(state.nodes, []);
    assert.deepEqual(state.edges, []);
    assert.equal(state.collapsedNodeIds.size, 0);
    assert.equal(state.selectedEdgeId, null);
    assert.equal(state.connectingFromNodeId, null);
  });
  check('every call returns independent objects — no leakage between two consecutive switches', () => {
    const first = clearedBoardViewState();
    const second = clearedBoardViewState();
    assert.notEqual(first.nodes, second.nodes);
    assert.notEqual(first.collapsedNodeIds, second.collapsedNodeIds, 'each switch gets its own Set, never a shared reference');
    first.collapsedNodeIds.add('leaked-from-board-A');
    assert.equal(second.collapsedNodeIds.size, 0, 'mutating one switch\'s state must never affect another\'s');
  });
});

// ---------------------------------------------------------------------------
scenario('W. FakeStore: deleting a Board does not delete Planner tasks', () => {
  // Mirrors the architecture: boards/board_nodes are one store, study_subjects
  // (the Planner's tasks) is a completely separate one with no reference
  // back to boards — deleting a board can only ever touch the first.
  let boards = [{ id: 'board1', title: 'Fall Semester' }];
  let boardNodes = [
    { id: 'n1', board_id: 'board1', title: 'Finish Python Assignment', linked_study_subject_id: 'study-1' },
    { id: 'n2', board_id: 'board1', title: 'Read chapter 3', linked_study_subject_id: null },
  ];
  const studyTasks = [{ id: 'study-1', name: 'Finish Python Assignment', minutes_requested: 60 }];

  // fakeDeleteBoard — exactly what boardData.deleteBoard + the database's
  // ON DELETE CASCADE do at the model level: remove the board and every
  // board_node scoped to it. It never reads or writes `studyTasks`.
  function fakeDeleteBoard(boardId) {
    boards = boards.filter((b) => b.id !== boardId);
    boardNodes = boardNodes.filter((n) => n.board_id !== boardId);
  }

  fakeDeleteBoard('board1');

  check('the board and all of its nodes are gone', () => {
    assert.equal(boards.length, 0);
    assert.equal(boardNodes.length, 0);
  });
  check('the study task that had been linked from this board still exists, completely untouched', () => {
    assert.equal(studyTasks.length, 1);
    assert.equal(studyTasks[0].id, 'study-1');
    assert.equal(studyTasks[0].name, 'Finish Python Assignment');
    assert.equal(studyTasks[0].minutes_requested, 60);
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
