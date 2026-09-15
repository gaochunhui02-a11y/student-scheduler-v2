// Pure, DOM-free, Supabase-free model logic for the Visual Board.
//
// Kept completely isolated from src/dashboard/* — nothing here is imported
// by scheduler.js and nothing in scheduler.js is imported here. These
// functions operate on plain node/edge-shaped objects only, so they're
// testable with plain Node the same way scheduler.js is.

export const NODE_TYPES = ['goal', 'subject', 'task', 'note'];

export function isValidNodeType(nodeType) {
  return NODE_TYPES.includes(nodeType);
}

// Coerces a position to a finite number, defaulting to 0 for anything that
// isn't one (undefined, null, NaN, Infinity, a string that doesn't parse).
// Keeps a bad/missing coordinate from ever reaching the database as NaN
// (which postgres's double precision column would reject) or as a string.
export function normalizePosition(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

export function normalizeNodePosition(x, y) {
  return { x_position: normalizePosition(x), y_position: normalizePosition(y) };
}

// A node's title is optional at the model level (new nodes can start blank
// and be named after creation) but is always stored as a string, never null.
export function normalizeNodeTitle(title) {
  return typeof title === 'string' ? title : '';
}

export function isSelfEdge(sourceNodeId, targetNodeId) {
  return sourceNodeId === targetNodeId;
}

export function isDuplicateEdge(existingEdges, sourceNodeId, targetNodeId) {
  return existingEdges.some((e) => e.source_node_id === sourceNodeId && e.target_node_id === targetNodeId);
}

// Same validation the 0002 migration enforces at the database level
// (board_edges_no_self_edge, board_edges_unique_pair) surfaced as a pure
// function so the UI can reject an invalid edge before ever calling
// Supabase, and so it's testable without a live project.
export function validateNewEdge(existingEdges, sourceNodeId, targetNodeId) {
  if (!sourceNodeId || !targetNodeId) {
    return { valid: false, error: 'Both a source and a target node are required.' };
  }
  if (isSelfEdge(sourceNodeId, targetNodeId)) {
    return { valid: false, error: 'A node cannot connect to itself.' };
  }
  if (isDuplicateEdge(existingEdges, sourceNodeId, targetNodeId)) {
    return { valid: false, error: 'These two nodes are already connected in that direction.' };
  }
  return { valid: true, error: null };
}

// Model-level cascade: given all of a board's edges and a node id being
// deleted, returns the edges that would remain (i.e. every edge NOT
// touching that node as source or target) — mirrors the ON DELETE CASCADE
// behavior board_edges has on both source_node_id and target_node_id, so
// client-side state can be kept in sync without a full re-fetch.
export function removeEdgesForNode(edges, nodeId) {
  return edges.filter((e) => e.source_node_id !== nodeId && e.target_node_id !== nodeId);
}

export function edgesTouchingNode(edges, nodeId) {
  return edges.filter((e) => e.source_node_id === nodeId || e.target_node_id === nodeId);
}

// Removing a single edge by id (used when the user explicitly deletes a
// connection, as opposed to removeEdgesForNode's cascade-on-node-delete).
export function removeEdgeById(edges, edgeId) {
  return edges.filter((e) => e.id !== edgeId);
}

// ---------------------------------------------------------------------------
// Node creation defaults (Phase 3: canvas + draggable nodes)
// ---------------------------------------------------------------------------

const NODE_GRID_COLUMNS = 4;
const NODE_GRID_COL_SPACING = 220;
const NODE_GRID_ROW_SPACING = 150;
const NODE_GRID_MARGIN = 40;

// Deterministic staggered placement for a newly created node, so "+ Add
// node" clicked repeatedly doesn't stack every card exactly on top of the
// last one. Purely a function of how many nodes already exist — no random
// numbers, so it's testable and reproducible.
export function nextNodePosition(existingNodeCount) {
  const count = Number.isFinite(existingNodeCount) && existingNodeCount > 0 ? Math.floor(existingNodeCount) : 0;
  const col = count % NODE_GRID_COLUMNS;
  const row = Math.floor(count / NODE_GRID_COLUMNS);
  return {
    x_position: NODE_GRID_MARGIN + col * NODE_GRID_COL_SPACING,
    y_position: NODE_GRID_MARGIN + row * NODE_GRID_ROW_SPACING,
  };
}

// A brand-new node's full default field set, before it's sent to
// boardData.createNode. node_type defaults to 'note' — the lowest-commitment
// type, since the user hasn't chosen one yet.
export function createNodeDefaults(existingNodeCount, nodeType = 'note') {
  return { node_type: isValidNodeType(nodeType) ? nodeType : 'note', title: '', ...nextNodePosition(existingNodeCount) };
}

// ---------------------------------------------------------------------------
// Drag-end position calculation (Phase 3)
// ---------------------------------------------------------------------------

// Shared by computeDragPosition and screenToCanvasPoint: a zoom factor of 0
// (or anything non-finite) is treated as 1x rather than causing a
// divide-by-zero.
function safeZoom(zoom) {
  return typeof zoom === 'number' && Number.isFinite(zoom) && zoom !== 0 ? zoom : 1;
}

// Pure math behind dragging a node: given where the node started, where the
// pointer started, and where the pointer is now, returns the node's new
// position. Dividing the pointer delta by `zoom` is what keeps dragging
// accurate when the canvas is zoomed in/out (a screen-pixel pointer move of
// 10px is only a 5px move in canvas space at 2x zoom). The result is run
// through normalizeNodePosition so a drag can never persist NaN/Infinity.
export function computeDragPosition({ nodeStartX, nodeStartY, pointerStartX, pointerStartY, pointerCurrentX, pointerCurrentY, zoom = 1 }) {
  const z = safeZoom(zoom);
  const dx = (pointerCurrentX - pointerStartX) / z;
  const dy = (pointerCurrentY - pointerStartY) / z;
  return normalizeNodePosition(nodeStartX + dx, nodeStartY + dy);
}

// ---------------------------------------------------------------------------
// Edge geometry (Phase 4: node connections)
// ---------------------------------------------------------------------------

// The center point of a node card in canvas-local coordinates, given its
// stored top-left position and its on-screen card size. Used for both the
// permanent edge lines and the temporary "drag to connect" preview line, so
// every line in the system anchors the same way.
export function nodeCenter(node, nodeWidth, nodeHeight) {
  return {
    x: normalizePosition(node?.x_position) + nodeWidth / 2,
    y: normalizePosition(node?.y_position) + nodeHeight / 2,
  };
}

// A straight center-to-center line between two nodes. Deliberately simple —
// no box/edge intersection math — because the node cards are rendered on
// top of the SVG edge layer (see main.css), so the visible line is already
// clipped at each card's opaque boundary without any extra geometry.
export function computeEdgeGeometry(sourceNode, targetNode, nodeWidth, nodeHeight) {
  const from = nodeCenter(sourceNode, nodeWidth, nodeHeight);
  const to = nodeCenter(targetNode, nodeWidth, nodeHeight);
  return { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
}

export function edgeMidpoint(x1, y1, x2, y2) {
  return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
}

// Converts a pointer's viewport (clientX/clientY) position into canvas-local
// coordinates — the same space node.x_position/y_position live in — given
// the canvas element's own on-screen origin (its getBoundingClientRect's
// top-left, which tracks scroll position) and the current zoom. Used while
// dragging from a node's connection handle to draw the temporary preview
// line under the pointer.
export function screenToCanvasPoint({ canvasLeft, canvasTop, clientX, clientY, zoom = 1 }) {
  const z = safeZoom(zoom);
  return {
    x: (clientX - canvasLeft) / z,
    y: (clientY - canvasTop) / z,
  };
}

// ---------------------------------------------------------------------------
// Convert node to study task (Phase 5)
//
// This module never talks to Supabase and never imports src/dashboard/data.js
// — the actual write goes through the EXISTING study_subjects data layer
// (src/dashboard/data.js: insertStudySubject), called from src/board/board.js
// via a small host-provided callback. These functions only do the pure
// field mapping/validation the conversion form needs, so that mapping is
// testable without a live project, same as the rest of this file.
// ---------------------------------------------------------------------------

const STUDY_PRIORITIES = ['low', 'medium', 'high'];

// Pre-fills the conversion form from a Board node. Only `name` has a
// meaningful source (the node's title) — study_subjects has no board-node
// equivalent for minutes/priority/due date/notes, so those start at the
// same defaults a manually-created study task row would have.
export function studyTaskDefaultsFromNode(node) {
  return {
    name: normalizeNodeTitle(node?.title),
    minutes_requested: null,
    priority: 'medium',
    due_date: null,
    notes: '',
  };
}

function normalizeStudyMinutes(value) {
  const n = typeof value === 'string' ? parseInt(value, 10) : value;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function normalizeStudyPriority(value) {
  return STUDY_PRIORITIES.includes(value) ? value : 'medium';
}

// Maps the conversion form's raw field values onto exactly the shape
// src/dashboard/data.js's insertStudySubject expects (the same fields
// object a manually-typed study-task row already builds in dashboard.js) —
// this is the mapping the form submits, never a second data model.
export function buildStudyTaskFields({ name, minutes, priority, dueDate, notes } = {}) {
  return {
    name: typeof name === 'string' ? name.trim() : '',
    minutes_requested: normalizeStudyMinutes(minutes),
    priority: normalizeStudyPriority(priority),
    due_date: dueDate || null,
    notes: typeof notes === 'string' ? notes.trim() : '',
  };
}

// Mirrors the same completeness check dashboard.js's manual study-row save
// already applies (a name and a positive whole-number minute count) before
// insertStudySubject is ever called — the conversion form must not create
// an incomplete/invalid study_subjects row either.
export function isStudyTaskFieldsValid(fields) {
  return Boolean(fields && fields.name) && Number.isFinite(fields.minutes_requested) && fields.minutes_requested > 0;
}

export function isNodeConverted(node) {
  return Boolean(node && node.linked_study_subject_id);
}

// A node that's already linked must not be converted again — this is the
// single source of truth the UI checks before ever opening the conversion
// form, so a duplicate study_subjects row can't be created for the same
// node.
export function canConvertNode(node) {
  return !isNodeConverted(node);
}

// Returns a NEW node object with the link set — used right after a
// successful insertStudySubject call to update local Board state (never
// mutates the node passed in).
export function linkNodeToStudyTask(node, studyTaskId) {
  return { ...node, linked_study_subject_id: studyTaskId };
}

// The inverse — documents/models what a node looks like once its linked
// study task has been deleted elsewhere (the 0002 migration's
// ON DELETE SET NULL already enforces this at the database level; the next
// Board load reflects it automatically). Not required by any board.js code
// path today, but kept and tested because it's the exact contract that
// deleting a study task must never delete or corrupt the Board node itself.
export function unlinkNodeFromStudyTask(node) {
  return { ...node, linked_study_subject_id: null };
}
