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
