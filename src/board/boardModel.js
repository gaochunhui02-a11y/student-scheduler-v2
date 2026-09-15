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
