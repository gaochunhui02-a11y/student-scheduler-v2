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

// Checkpoint D: a gentle quadratic-bezier bow instead of a dead-straight
// line, without touching computeEdgeGeometry's anchor math (still the exact
// same node-center x1/y1/x2/y2 every other caller — the delete button,
// hit-testing bounds — already relies on). The control point is offset
// perpendicular to the line by a fraction of its length, capped so long
// edges don't bow absurdly far and a same-point edge (zero length) never
// divides by zero.
const EDGE_CURVE_BOW = 0.12;
const EDGE_CURVE_BOW_MAX = 40;

export function computeEdgeControlPoint(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (!(length > 0)) return { x: x1, y: y1 };
  const bow = Math.min(EDGE_CURVE_BOW_MAX, length * EDGE_CURVE_BOW);
  // Perpendicular unit vector (-dy, dx)/length, applied to the midpoint.
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  return { x: mx + (-dy / length) * bow, y: my + (dx / length) * bow };
}

// SVG path `d` string for the same edge, drawn as a single quadratic curve
// through computeEdgeControlPoint — used for both the visible line and its
// (invisible, wide-stroke) hit-test twin, so a click anywhere along the
// visual curve — not just a straight-line approximation of it — selects it.
export function computeEdgeCurvePath(x1, y1, x2, y2) {
  const c = computeEdgeControlPoint(x1, y1, x2, y2);
  return `M ${x1} ${y1} Q ${c.x} ${c.y} ${x2} ${y2}`;
}

// The point at parameter t (0..1) along that same quadratic curve — used to
// place the edge-delete button at the curve's actual midpoint (t=0.5)
// instead of the straight-line midpoint, which would sit visibly off the
// bowed line.
export function computeQuadraticPoint(x1, y1, x2, y2, t = 0.5) {
  const c = computeEdgeControlPoint(x1, y1, x2, y2);
  const mt = 1 - t;
  return {
    x: mt * mt * x1 + 2 * mt * t * c.x + t * t * x2,
    y: mt * mt * y1 + 2 * mt * t * c.y + t * t * y2,
  };
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

// ---------------------------------------------------------------------------
// Pan/zoom, fit-to-board, search, duplicate, collapse, auto-layout
// (Phase 6: Board usability and organization)
// ---------------------------------------------------------------------------

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;

// Rounds to the nearest 1% to avoid float drift accumulating across many
// small wheel-zoom steps, then clamps to [min, max]. Used by every zoom
// entry point (buttons, wheel/trackpad pinch) so the limit is enforced in
// exactly one place.
export function clampZoom(value, min = ZOOM_MIN, max = ZOOM_MAX) {
  const n = typeof value === 'string' ? Number(value) : value;
  const safe = typeof n === 'number' && Number.isFinite(n) ? n : 1;
  const rounded = Math.round(safe * 100) / 100;
  return Math.min(max, Math.max(min, rounded));
}

// The smallest canvas-local rectangle containing every node's card. Returns
// null for an empty node list (nothing to fit). Used by both "Fit to Board"
// and, indirectly, as a building block a future feature could reuse.
export function computeNodesBoundingBox(nodes, nodeWidth, nodeHeight) {
  if (!nodes || nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  nodes.forEach((node) => {
    const x = normalizePosition(node.x_position);
    const y = normalizePosition(node.y_position);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + nodeWidth);
    maxY = Math.max(maxY, y + nodeHeight);
  });
  return { minX, minY, maxX, maxY };
}

// Given the nodes' bounding box and the visible viewport (the scrollable
// canvas-wrap's clientWidth/clientHeight), returns the zoom level and
// scroll position that fits every node on screen with some padding. Zoom is
// clamped to the same [min,max] every other zoom control respects.
export function computeFitView({ bbox, viewportWidth, viewportHeight, zoomMin = ZOOM_MIN, zoomMax = ZOOM_MAX, padding = 60 }) {
  if (!bbox || !(viewportWidth > 0) || !(viewportHeight > 0)) {
    return { zoom: 1, scrollLeft: 0, scrollTop: 0 };
  }
  const bboxWidth = Math.max(1, bbox.maxX - bbox.minX);
  const bboxHeight = Math.max(1, bbox.maxY - bbox.minY);
  const zoomX = (viewportWidth - padding * 2) / bboxWidth;
  const zoomY = (viewportHeight - padding * 2) / bboxHeight;
  const fitted = Math.min(zoomX, zoomY);
  const zoom = clampZoom(Number.isFinite(fitted) && fitted > 0 ? fitted : 1, zoomMin, zoomMax);

  const centerX = (bbox.minX + bbox.maxX) / 2;
  const centerY = (bbox.minY + bbox.maxY) / 2;
  const scrollLeft = Math.max(0, centerX * zoom - viewportWidth / 2);
  const scrollTop = Math.max(0, centerY * zoom - viewportHeight / 2);
  return { zoom, scrollLeft, scrollTop };
}

// Scroll position (at the CURRENT zoom — unlike computeFitView, this never
// changes zoom) that centers one node in the viewport. Used by search's
// "center the Board on that node."
export function computeCenterOnNodeScroll({ node, nodeWidth, nodeHeight, viewportWidth, viewportHeight, zoom = 1 }) {
  const center = nodeCenter(node, nodeWidth, nodeHeight);
  const z = safeZoom(zoom);
  return {
    scrollLeft: Math.max(0, center.x * z - viewportWidth / 2),
    scrollTop: Math.max(0, center.y * z - viewportHeight / 2),
  };
}

// Case-insensitive substring match on node title, never touching the node
// itself — search is read-only.
export function filterNodesByQuery(nodes, query) {
  const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (!q) return [];
  return nodes.filter((n) => normalizeNodeTitle(n.title).toLowerCase().includes(q));
}

// Field set for a duplicate of `node`, offset so the copy doesn't sit
// exactly on top of the original. Deliberately excludes
// linked_study_subject_id (a duplicate is a brand-new, unconverted node)
// and never touches edges — the caller is responsible for not copying any.
export function duplicateNodeFields(node, offset = 24) {
  return {
    node_type: isValidNodeType(node?.node_type) ? node.node_type : 'note',
    title: normalizeNodeTitle(node?.title),
    x_position: normalizePosition(node?.x_position) + offset,
    y_position: normalizePosition(node?.y_position) + offset,
    color: node && node.color !== undefined ? node.color : null,
  };
}

// True if `nodeId` has at least one outgoing edge (i.e. is a parent of
// something) — used to decide whether a node's card shows a collapse/expand
// control at all.
export function hasChildren(edges, nodeId) {
  return edges.some((e) => e.source_node_id === nodeId);
}

// Every node transitively reachable by following source -> target edges
// from `rootId` (parent -> child, per Phase 4's directed-edge convention).
// Guards against a cycle (two nodes connected in both directions is legal —
// duplicate-edge prevention only blocks the exact same direction twice) by
// never revisiting a node already in the result.
export function getDescendantNodeIds(edges, rootId) {
  const result = new Set();
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift();
    edges.forEach((e) => {
      if (e.source_node_id === current && e.target_node_id !== rootId && !result.has(e.target_node_id)) {
        result.add(e.target_node_id);
        queue.push(e.target_node_id);
      }
    });
  }
  return Array.from(result);
}

// The full set of node ids hidden by the current collapse state — the union
// of every collapsed node's descendants. A node collapsed while already
// hidden (nested collapses) contributes nothing new, which is correct: it's
// already invisible.
export function computeHiddenNodeIds(edges, collapsedNodeIds) {
  const hidden = new Set();
  (collapsedNodeIds || []).forEach((rootId) => {
    getDescendantNodeIds(edges, rootId).forEach((id) => hidden.add(id));
  });
  return hidden;
}

// Simple deterministic tree layout from the existing parent -> child edges.
// No relationships change — only x_position/y_position. Disconnected nodes
// (no edges at all) become their own single-node "root" rather than
// crashing or being skipped. Cycle-safe via the same visited-set guard as
// getDescendantNodeIds. Intentionally simple (no external graph-layout
// library): leaves are placed left-to-right in a strictly increasing
// column counter; a parent is centered over the average column of its
// children. Rows are BFS depth from whichever root reaches a node first.
export function computeAutoLayout(nodes, edges, { columnWidth = 220, rowHeight = 150, marginX = 40, marginY = 40 } = {}) {
  const positions = {};
  if (!nodes || nodes.length === 0) return positions;

  const nodeIds = new Set(nodes.map((n) => n.id));
  const childrenOf = new Map(nodes.map((n) => [n.id, []]));
  const hasIncoming = new Set();
  edges.forEach((e) => {
    if (nodeIds.has(e.source_node_id) && nodeIds.has(e.target_node_id) && e.source_node_id !== e.target_node_id) {
      childrenOf.get(e.source_node_id).push(e.target_node_id);
      hasIncoming.add(e.target_node_id);
    }
  });

  // Deterministic root order: nodes with no parent, left-to-right by their
  // current x position (stable tie-break by id) — so re-running Auto
  // Arrange on an already-tidy board doesn't shuffle top-level order.
  const roots = nodes
    .filter((n) => !hasIncoming.has(n.id))
    .sort((a, b) => normalizePosition(a.x_position) - normalizePosition(b.x_position) || String(a.id).localeCompare(String(b.id)));

  const visited = new Set();
  const columns = new Map();
  const depths = new Map();
  let nextColumn = 0;

  function layout(nodeId, depth) {
    if (visited.has(nodeId)) return columns.get(nodeId);
    visited.add(nodeId);
    depths.set(nodeId, depth);
    const children = (childrenOf.get(nodeId) || []).filter((id) => !visited.has(id));
    let column;
    if (children.length === 0) {
      column = nextColumn;
      nextColumn += 1;
    } else {
      const childColumns = children.map((childId) => layout(childId, depth + 1));
      column = childColumns.reduce((sum, c) => sum + c, 0) / childColumns.length;
    }
    columns.set(nodeId, column);
    return column;
  }

  roots.forEach((root) => layout(root.id, 0));
  // Any node not reachable from a root (shouldn't happen — every node is
  // either a root or has an incoming edge from something) is still given a
  // position rather than silently omitted.
  nodes.forEach((n) => {
    if (!visited.has(n.id)) layout(n.id, 0);
  });

  nodes.forEach((n) => {
    positions[n.id] = {
      x_position: marginX + columns.get(n.id) * columnWidth,
      y_position: marginY + depths.get(n.id) * rowHeight,
    };
  });
  return positions;
}

// ---------------------------------------------------------------------------
// Multiple Boards / Projects (Phase 7)
// ---------------------------------------------------------------------------

// Which board to open when the Board section is shown: the remembered
// (last-opened, from localStorage) board if it still exists among the
// user's current boards, otherwise the first board in the list (whatever
// order boardData.listBoards returned — most-recently-updated first).
// Returns null only when the user has no boards at all.
export function selectBoardId(boards, rememberedId) {
  if (!boards || boards.length === 0) return null;
  if (rememberedId && boards.some((b) => b.id === rememberedId)) return rememberedId;
  return boards[0].id;
}

// Defensive client-side scoping — boardData.loadBoard already filters by
// board_id (and RLS scopes by user) server-side, so in correct operation
// these are no-ops; they exist so a bug can never let one board's nodes
// render while another board is "current."
export function filterNodesByBoard(nodes, boardId) {
  return (nodes || []).filter((n) => n.board_id === boardId);
}

export function filterEdgesByBoard(edges, boardId) {
  return (edges || []).filter((e) => e.board_id === boardId);
}

// The exact clean-slate shape the canvas is reset to at the START of every
// board switch (before the new board's data has even loaded) — this is
// what keeps a fast switch from ever showing the previous board's nodes or
// edges, even briefly. A fresh Set is returned every call (never a shared
// reference) so two switches in a row can never share collapse state.
export function clearedBoardViewState() {
  return { nodes: [], edges: [], collapsedNodeIds: new Set(), selectedEdgeId: null, connectingFromNodeId: null };
}

// ---------------------------------------------------------------------------
// Board Templates (Checkpoint D)
//
// Deterministic, local, non-AI starter content — no network call, no new
// table. Every string here is an i18n KEY, not display text: this module
// stays translation-agnostic (no import of shared/i18n.js, consistent with
// the rest of this file), and board.js resolves each key with t() only at
// the moment it actually calls createBoard/createNode/createEdge. A
// template only ever uses node_type values already in NODE_TYPES and the
// existing 'parent' edge relationship — no new node/edge shape.
// ---------------------------------------------------------------------------

export const BOARD_TEMPLATES = [
  {
    key: 'examPrep',
    titleKey: 'board.templateExamPrepTitle',
    root: { nodeType: 'goal', titleKey: 'board.templateExamPrepRoot' },
    children: [
      { nodeType: 'task', titleKey: 'board.templateExamPrepStep1' },
      { nodeType: 'task', titleKey: 'board.templateExamPrepStep2' },
      { nodeType: 'task', titleKey: 'board.templateExamPrepStep3' },
      { nodeType: 'task', titleKey: 'board.templateExamPrepStep4' },
    ],
  },
  {
    key: 'essay',
    titleKey: 'board.templateEssayTitle',
    root: { nodeType: 'goal', titleKey: 'board.templateEssayRoot' },
    children: [
      { nodeType: 'task', titleKey: 'board.templateEssayStep1' },
      { nodeType: 'task', titleKey: 'board.templateEssayStep2' },
      { nodeType: 'task', titleKey: 'board.templateEssayStep3' },
      { nodeType: 'task', titleKey: 'board.templateEssayStep4' },
      { nodeType: 'task', titleKey: 'board.templateEssayStep5' },
    ],
  },
  {
    key: 'project',
    titleKey: 'board.templateProjectTitle',
    root: { nodeType: 'goal', titleKey: 'board.templateProjectRoot' },
    children: [
      { nodeType: 'task', titleKey: 'board.templateProjectStep1' },
      { nodeType: 'task', titleKey: 'board.templateProjectStep2' },
      { nodeType: 'task', titleKey: 'board.templateProjectStep3' },
      { nodeType: 'task', titleKey: 'board.templateProjectStep4' },
      { nodeType: 'task', titleKey: 'board.templateProjectStep5' },
    ],
  },
];

export function getBoardTemplate(key) {
  return BOARD_TEMPLATES.find((tpl) => tpl.key === key) || null;
}

// Flattens a template into the exact, generic shape board.js turns into
// real createNode/createEdge calls: an ordered node-spec list (index 0 is
// always the root) and an edge-spec list referencing those indices. Kept
// generic (fromIndex/toIndex) rather than hardcoded "root+children" so it's
// provably correct for any future template shape, and so it's testable here
// without Supabase, the DOM, or i18n.
export function buildTemplateStructure(template) {
  if (!template || !template.root || !Array.isArray(template.children)) return null;
  return {
    boardTitleKey: template.titleKey,
    nodes: [template.root, ...template.children],
    edges: template.children.map((_, i) => ({ fromIndex: 0, toIndex: i + 1, relationship: 'parent' })),
  };
}
