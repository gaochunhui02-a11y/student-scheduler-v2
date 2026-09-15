// Pure, DOM-free, network-free logic for "Break down with AI" (Phase 8).
//
// Mirrors src/board/boardModel.js's philosophy exactly: no Supabase, no AI
// provider, no fetch — just sanitizing what goes TO the AI and validating/
// mapping what comes back FROM it. The actual network call lives in
// src/board/aiBreakdownClient.js; this file is what makes that call's
// input and output safe to trust, and it's what unit tests exercise
// (mocking the provider boundary — never a real paid API call).
//
// Trust boundary: nothing the AI returns is ever used to create a Board
// node until it has passed validateBreakdownResponse here AND the user has
// explicitly selected it in the confirmation UI. There is no path from a
// raw AI response straight to boardData.createNode.

import { isValidNodeType, normalizeNodeTitle, normalizePosition } from './boardModel.js';

const MAX_SUGGESTIONS = 8;
const MAX_TITLE_LENGTH = 120;
const MAX_MESSAGE_LENGTH = 500;

// The ONLY thing sent to the AI about a node: its title and type. No node
// id, no board id, no other nodes, no user id, no edges, nothing from
// study_subjects/schedules — there is nothing else for this feature to
// leak, by construction.
export function buildBreakdownContext(node) {
  return {
    title: normalizeNodeTitle(node?.title).slice(0, MAX_TITLE_LENGTH),
    nodeType: isValidNodeType(node?.node_type) ? node.node_type : 'goal',
  };
}

function normalizeSuggestion(raw) {
  const title = typeof raw === 'string' ? raw : typeof raw?.title === 'string' ? raw.title : '';
  const trimmed = title.trim().slice(0, MAX_TITLE_LENGTH);
  return trimmed ? { title: trimmed } : null;
}

// Validates an AI provider response before anything from it is ever shown
// to the user, let alone used to create a Board node. Handles every
// malformed-response shape a network/provider failure could plausibly
// produce: not an object at all, an explicit {error} from the Edge
// Function, a missing/non-array suggestions field, an empty list after
// filtering, non-string or blank titles, and an oversized list (capped
// rather than rejected outright, since a slightly-too-generous response is
// still useful).
export function validateBreakdownResponse(raw) {
  if (!raw || typeof raw !== 'object') {
    return { valid: false, error: 'malformed', message: '', suggestions: [] };
  }
  if (typeof raw.error === 'string') {
    return { valid: false, error: raw.error, message: '', suggestions: [] };
  }
  if (!Array.isArray(raw.suggestions)) {
    return { valid: false, error: 'malformed', message: '', suggestions: [] };
  }

  const suggestions = raw.suggestions
    .map(normalizeSuggestion)
    .filter((s) => s !== null)
    .slice(0, MAX_SUGGESTIONS);

  if (suggestions.length === 0) {
    return { valid: false, error: 'empty', message: '', suggestions: [] };
  }

  const message = typeof raw.message === 'string' ? raw.message.trim().slice(0, MAX_MESSAGE_LENGTH) : '';
  return { valid: true, error: null, message, suggestions };
}

// Deterministic placement for the new child nodes: a row directly beneath
// the parent, left to right. Purely a function of the parent's current
// position and how many children are being added — no randomness, so it's
// testable and reproducible, same approach as boardModel.js's
// nextNodePosition.
export function layoutChildSuggestions(parentNode, count, { columnWidth = 220, rowOffset = 160 } = {}) {
  const baseX = normalizePosition(parentNode?.x_position);
  const baseY = normalizePosition(parentNode?.y_position) + rowOffset;
  const positions = [];
  for (let i = 0; i < count; i += 1) {
    positions.push({ x_position: baseX + i * columnWidth, y_position: baseY });
  }
  return positions;
}

const ERROR_MESSAGE_KEYS = {
  network_error: 'board.breakdownNetworkError',
  rate_limited: 'board.breakdownRateLimited',
  provider_error: 'board.breakdownProviderError',
};

// Maps an error code (from aiBreakdownClient's network layer, or from
// validateBreakdownResponse above) to a translation key for a user-facing
// message. Everything not explicitly listed — unauthorized, not_configured,
// invalid_request, malformed, empty, or anything unrecognized — collapses
// to one generic, always-safe message rather than surfacing an internal
// error code to the user. Returns a KEY, not translated text: this file
// stays free of any i18n/UI dependency, same as boardModel.js.
export function breakdownErrorMessageKey(errorCode) {
  return ERROR_MESSAGE_KEYS[errorCode] || 'board.breakdownGenericError';
}

// Maps only the SELECTED suggestions (by index into `suggestions`) onto
// board_node creation fields — the same shape boardData.createNode expects
// (nodeType/title/x/y/color), laid out under the parent. Never includes
// linked_study_subject_id (a fresh subtask is never pre-linked to a
// Planner task) and returns no edge data itself — the caller decides
// whether/how to connect each new node to its parent.
export function mapSuggestionsToChildNodes(suggestions, selectedIndexes, parentNode) {
  const selected = new Set(selectedIndexes || []);
  const chosen = (suggestions || []).filter((_, i) => selected.has(i));
  const positions = layoutChildSuggestions(parentNode, chosen.length);
  return chosen.map((s, i) => ({
    node_type: 'task',
    title: s.title,
    x_position: positions[i].x_position,
    y_position: positions[i].y_position,
    color: null,
  }));
}
