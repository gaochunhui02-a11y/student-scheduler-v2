// Pure, DOM-free, network-free logic for the AI Student Advisor (Phase 9).
//
// Mirrors src/board/aiBreakdownModel.js's philosophy exactly: no Supabase,
// no AI provider, no fetch — just sanitizing what goes TO the AI and
// validating/mapping what comes back FROM it. The network call lives in
// src/advisor/advisorClient.js; the chat UI lives in src/advisor/advisor.js.
// This file is what unit tests exercise (mocking the provider boundary —
// never a real paid API call).
//
// Trust boundary: nothing the AI returns is ever used to create a study
// task or a Board node until it has passed validateAdvisorResponse here
// AND the user has explicitly clicked an action for that specific
// suggestion. There is no path from a raw AI response straight to
// insertStudySubject or boardData.createNode.
//
// Reuse, not duplication: suggestion -> Planner mapping goes through
// src/board/boardModel.js's buildStudyTaskFields/isStudyTaskFieldsValid —
// the exact same mapping/validation the Board's "Add to Planner" (Phase 5)
// already uses — rather than a second Planner-field mapper. Suggestion ->
// Board mapping only ever produces a title; the rest of a new node's
// fields (type, position) are the existing board.js node-creation
// defaults, unchanged.

import { buildStudyTaskFields, isStudyTaskFieldsValid, normalizeNodeTitle } from '../board/boardModel.js';

export { isStudyTaskFieldsValid };

const MAX_SUGGESTIONS = 10;
const MAX_TITLE_LENGTH = 120;
const MAX_REASON_LENGTH = 300;
const MAX_MESSAGE_LENGTH = 600;
const MAX_CONTEXT_LIST_LENGTH = 30;
const MAX_STRING_FIELD_LENGTH = 200;
const PRIORITIES = ['low', 'medium', 'high'];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function safeString(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

// ---------------------------------------------------------------------------
// Context sent TO the AI — only planning-relevant fields, never a raw
// Supabase row, never an id, never anything from auth/profile.
// ---------------------------------------------------------------------------

// `scheduleItems` is expected in the same shape dashboard.js already keeps
// in memory (currentScheduleItems): {..., completed, sourceSubjectId}. A
// subject with no scheduled blocks yet gets completed:null ("not started"
// is different from "started but unfinished").
function subjectCompletionStatus(subjectId, scheduleItems) {
  const items = (scheduleItems || []).filter((item) => item.sourceSubjectId === subjectId);
  if (items.length === 0) return null;
  return items.every((item) => item.completed);
}

export function buildAdvisorContext({ currentDate, schedule, studySubjects, classes, scheduleItems, boardGoals } = {}) {
  return {
    currentDate: safeString(currentDate, 10),
    availableWindow: {
      wakeTime: schedule && typeof schedule.wake_time === 'string' ? schedule.wake_time : null,
      sleepTime: schedule && typeof schedule.sleep_time === 'string' ? schedule.sleep_time : null,
    },
    preferredStudyPeriod: (schedule && schedule.preferred_study_period) || 'none',
    earliestStudyTime: (schedule && schedule.earliest_study_time) || null,
    latestStudyTime: (schedule && schedule.latest_study_time) || null,
    classes: (classes || []).slice(0, MAX_CONTEXT_LIST_LENGTH).map((c) => ({
      name: safeString(c.name, MAX_STRING_FIELD_LENGTH),
      start: c.start_time || null,
      end: c.end_time || null,
    })),
    tasks: (studySubjects || []).slice(0, MAX_CONTEXT_LIST_LENGTH).map((s) => ({
      title: safeString(s.name, MAX_STRING_FIELD_LENGTH),
      minutes: Number.isFinite(s.minutes_requested) ? s.minutes_requested : null,
      priority: PRIORITIES.includes(s.priority) ? s.priority : 'medium',
      dueDate: s.due_date || null,
      notes: safeString(s.notes, MAX_STRING_FIELD_LENGTH),
      completed: subjectCompletionStatus(s.id, scheduleItems),
    })),
    boardGoals: (boardGoals || []).slice(0, MAX_CONTEXT_LIST_LENGTH).map((g) => ({
      title: safeString(g.title, MAX_STRING_FIELD_LENGTH),
      type: g.nodeType || g.node_type || 'goal',
    })),
  };
}

// ---------------------------------------------------------------------------
// Response FROM the AI — the real trust boundary.
// ---------------------------------------------------------------------------

function normalizeMinutes(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function normalizeDueDate(value) {
  return typeof value === 'string' && DATE_PATTERN.test(value) ? value : null;
}

// A suggestion missing a usable title or a positive minute estimate isn't
// actionable as a study task, so it's dropped from the list rather than
// invalidating the whole response — one bad suggestion among several good
// ones shouldn't throw the useful ones away too.
function normalizeAdvisorSuggestion(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = safeString(raw.title, MAX_TITLE_LENGTH);
  if (!title) return null;
  const minutes = normalizeMinutes(raw.minutes);
  if (!minutes) return null;
  return {
    title,
    minutes,
    priority: PRIORITIES.includes(raw.priority) ? raw.priority : 'medium',
    dueDate: normalizeDueDate(raw.dueDate),
    reason: safeString(raw.reason, MAX_REASON_LENGTH),
  };
}

// Validates the Edge Function's response before anything from it is ever
// rendered, let alone used to create a study task or Board node. Unlike
// aiBreakdownModel's validateBreakdownResponse, a message with ZERO
// suggestions is still a valid response here — "What should I study
// today?" can reasonably get a text-only answer ("You're all caught up!")
// with nothing actionable to add.
export function validateAdvisorResponse(raw) {
  if (!raw || typeof raw !== 'object') {
    return { valid: false, error: 'malformed', message: '', suggestions: [] };
  }
  if (typeof raw.error === 'string') {
    return { valid: false, error: raw.error, message: '', suggestions: [] };
  }
  if (raw.suggestions !== undefined && !Array.isArray(raw.suggestions)) {
    return { valid: false, error: 'malformed', message: '', suggestions: [] };
  }

  const suggestions = Array.isArray(raw.suggestions)
    ? raw.suggestions.map(normalizeAdvisorSuggestion).filter((s) => s !== null).slice(0, MAX_SUGGESTIONS)
    : [];
  const message = safeString(raw.message, MAX_MESSAGE_LENGTH);

  if (!message && suggestions.length === 0) {
    return { valid: false, error: 'empty', message: '', suggestions: [] };
  }
  return { valid: true, error: null, message, suggestions };
}

// ---------------------------------------------------------------------------
// Suggestion -> existing data-layer mappings
// ---------------------------------------------------------------------------

// Reuses the EXACT mapping/validation Board's "Add to Planner" already
// uses (src/board/boardModel.js, Phase 5) — no second Planner-field
// mapper. suggestion.reason becomes the study task's notes.
export function mapSuggestionToStudyTaskFields(suggestion) {
  return buildStudyTaskFields({
    name: suggestion && suggestion.title,
    minutes: suggestion && suggestion.minutes,
    priority: suggestion && suggestion.priority,
    dueDate: suggestion && suggestion.dueDate,
    notes: suggestion && suggestion.reason,
  });
}

// Board nodes in this app are title-only entities (type/position/color are
// the existing node-creation defaults, unchanged) — so the only mapping
// needed here is sanitizing the title, same normalization boardModel.js
// already applies to every node title.
export function mapSuggestionToBoardNodeTitle(suggestion) {
  return normalizeNodeTitle(suggestion && suggestion.title);
}

// Filters a validated suggestions list down to just the ones the user
// checked (by index) — used by both a single-suggestion action and the
// bulk "Add selected" button.
export function selectSuggestions(suggestions, selectedIndexes) {
  const selected = new Set(selectedIndexes || []);
  return (suggestions || []).filter((_, i) => selected.has(i));
}

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

const ERROR_MESSAGE_KEYS = {
  network_error: 'advisor.networkError',
  rate_limited: 'advisor.rateLimited',
  provider_error: 'advisor.providerError',
};

// Same pattern as aiBreakdownModel.breakdownErrorMessageKey: every
// unrecognized code (unauthorized, not_configured, invalid_request,
// malformed, empty, or anything the provider invents) collapses to one
// generic, always-safe message rather than leaking an internal code.
export function advisorErrorMessageKey(errorCode) {
  return ERROR_MESSAGE_KEYS[errorCode] || 'advisor.genericError';
}
