// Pure, DOM-free, Supabase-free model logic for Study Task subtasks (V2-A).
// Mirrors the rest of this codebase's split: src/dashboard/data.js owns the
// actual study_subject_subtasks reads/writes, dashboard.js owns rendering
// the checklist UI, and this file only ever transforms plain data.

const MAX_SUBTASK_TITLE_LENGTH = 200;

export function normalizeSubtaskTitle(title) {
  const str = typeof title === 'string' ? title.trim() : '';
  return str.slice(0, MAX_SUBTASK_TITLE_LENGTH);
}

export function isValidSubtaskTitle(title) {
  return normalizeSubtaskTitle(title).length > 0;
}

// The exact field shape src/dashboard/data.js's insertSubtask expects —
// the only mapping this form's "add subtask" submit needs.
export function buildSubtaskFields(title) {
  return { title: normalizeSubtaskTitle(title), completed: false };
}

// Deterministic append-at-the-end placement, same convention as
// src/board/boardModel.js's nextNodePosition (a pure function of how many
// subtasks already exist, not a value read back from the database).
export function nextSubtaskSortOrder(existingCount) {
  return Number.isFinite(existingCount) && existingCount > 0 ? Math.floor(existingCount) : 0;
}

// How many of a task's subtasks are done, out of how many exist — the
// "✓ 2 / 3" readout on a task card. {completed: 0, total: 0} for a task
// with no subtasks at all, never null, so the caller never has to
// special-case "no subtasks" separately from "subtasks, none done yet."
export function computeSubtaskProgress(subtasks) {
  const list = Array.isArray(subtasks) ? subtasks : [];
  const completed = list.filter((s) => s && s.completed === true).length;
  return { completed, total: list.length };
}

// A task is only considered "fully done via subtasks" once it HAS at least
// one subtask and every one of them is completed — a task with zero
// subtasks is neither done nor not-done by this measure (the caller should
// fall back to the task's own completion state instead).
export function isSubtasksFullyComplete(subtasks) {
  const { completed, total } = computeSubtaskProgress(subtasks);
  return total > 0 && completed === total;
}
