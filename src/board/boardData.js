// Supabase I/O for the Visual Board feature (boards / board_nodes / board_edges).
//
// Isolated from src/dashboard/data.js on purpose — the Board is a separate
// feature with its own tables (see supabase/migrations/0002_boards.sql) and
// must never be able to affect scheduling reads/writes. Follows the same
// conventions as src/dashboard/data.js: throw on error, return the row(s),
// and set updated_at explicitly on every update (this project has no DB
// trigger for it).

import { supabase } from '../lib/supabaseClient.js';
import { isValidNodeType, normalizeNodePosition, normalizeNodeTitle, validateNewEdge } from './boardModel.js';

// ---------------------------------------------------------------------------
// boards
// ---------------------------------------------------------------------------

export async function listBoards(userId) {
  const { data, error } = await supabase
    .from('boards')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function createBoard(userId, title = 'Untitled board') {
  const { data, error } = await supabase
    .from('boards')
    .insert({ user_id: userId, title })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Loads a board plus all of its nodes and edges in one call, the shape the
// canvas will need once it exists. Returns null if the board doesn't exist
// (or isn't the caller's — RLS makes those indistinguishable, which is the
// correct behavior).
export async function loadBoard(userId, boardId) {
  const { data: board, error: boardError } = await supabase
    .from('boards')
    .select('*')
    .eq('user_id', userId)
    .eq('id', boardId)
    .maybeSingle();
  if (boardError) throw boardError;
  if (!board) return null;

  const [{ data: nodes, error: nodesError }, { data: edges, error: edgesError }] = await Promise.all([
    supabase.from('board_nodes').select('*').eq('board_id', boardId).order('created_at', { ascending: true }),
    supabase.from('board_edges').select('*').eq('board_id', boardId).order('created_at', { ascending: true }),
  ]);
  if (nodesError) throw nodesError;
  if (edgesError) throw edgesError;

  return { board, nodes, edges };
}

export async function renameBoard(userId, boardId, title) {
  const { data, error } = await supabase
    .from('boards')
    .update({ title, updated_at: new Date().toISOString() })
    .eq('id', boardId)
    .eq('user_id', userId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Deletes the board and, via the migration's ON DELETE CASCADE, all of its
// nodes and edges.
export async function deleteBoard(userId, boardId) {
  const { error } = await supabase.from('boards').delete().eq('id', boardId).eq('user_id', userId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// board_nodes
// ---------------------------------------------------------------------------

export async function createNode(userId, boardId, { nodeType, title = '', x = 0, y = 0, color = null, linkedStudySubjectId = null } = {}) {
  if (!isValidNodeType(nodeType)) {
    throw new Error(`Invalid node_type: ${nodeType}`);
  }
  const { x_position, y_position } = normalizeNodePosition(x, y);
  const { data, error } = await supabase
    .from('board_nodes')
    .insert({
      board_id: boardId,
      user_id: userId,
      node_type: nodeType,
      title: normalizeNodeTitle(title),
      x_position,
      y_position,
      color,
      linked_study_subject_id: linkedStudySubjectId,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Partial update — pass only the fields that changed (e.g. just x/y while
// dragging, or just title after an edit). Mirrors updateScheduleItemTime's
// targeted-update shape in src/dashboard/data.js.
export async function updateNode(userId, nodeId, fields) {
  const patch = { updated_at: new Date().toISOString() };
  if (fields.nodeType !== undefined) {
    if (!isValidNodeType(fields.nodeType)) throw new Error(`Invalid node_type: ${fields.nodeType}`);
    patch.node_type = fields.nodeType;
  }
  if (fields.title !== undefined) patch.title = normalizeNodeTitle(fields.title);
  if (fields.x !== undefined || fields.y !== undefined) {
    const { x_position, y_position } = normalizeNodePosition(fields.x, fields.y);
    if (fields.x !== undefined) patch.x_position = x_position;
    if (fields.y !== undefined) patch.y_position = y_position;
  }
  if (fields.color !== undefined) patch.color = fields.color;
  if (fields.linkedStudySubjectId !== undefined) patch.linked_study_subject_id = fields.linkedStudySubjectId;

  const { data, error } = await supabase
    .from('board_nodes')
    .update(patch)
    .eq('id', nodeId)
    .eq('user_id', userId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Deletes the node; via the migration's ON DELETE CASCADE on
// board_edges.source_node_id/target_node_id, every edge touching it is
// deleted too.
export async function deleteNode(userId, nodeId) {
  const { error } = await supabase.from('board_nodes').delete().eq('id', nodeId).eq('user_id', userId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// board_edges
// ---------------------------------------------------------------------------

export async function createEdge(userId, boardId, sourceNodeId, targetNodeId, relationship = 'related') {
  const { data: existingEdges, error: fetchError } = await supabase
    .from('board_edges')
    .select('*')
    .eq('board_id', boardId);
  if (fetchError) throw fetchError;

  const { valid, error: validationError } = validateNewEdge(existingEdges, sourceNodeId, targetNodeId);
  if (!valid) throw new Error(validationError);

  const { data, error } = await supabase
    .from('board_edges')
    .insert({ board_id: boardId, user_id: userId, source_node_id: sourceNodeId, target_node_id: targetNodeId, relationship })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteEdge(userId, edgeId) {
  const { error } = await supabase.from('board_edges').delete().eq('id', edgeId).eq('user_id', userId);
  if (error) throw error;
}
