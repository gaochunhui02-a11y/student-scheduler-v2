// One status system for the whole app (V2-G). Pure: no DOM, no i18n, no
// clock — "now" is always passed in.
//
//   planned       scheduled, nothing logged yet
//   in_progress   happening right now (today, block spans now) — DERIVED
//                 from the clock, never stored, so it can't go stale
//   done          completed
//   partial       some time logged, not finished
//   missed        flagged missed, still unresolved
//   carried_over  leftover time moved to a later day
//
// When several apply, the most decisive one wins:
//   done > carried_over > missed > partial > in_progress > planned
// (a missed block whose time was carried forward reads as resolved, i.e.
// carried over; a block worked on partly and then flagged missed reads as
// missed, because that's what still needs attention).
//
// Every page (Home, Planner, Week, Tasks, Board, History, Insights,
// Calendar) renders statuses through statusBadgeHtml/statusBadgeEl below
// with the same label key, icon and color class.

export const STATUS_KEYS = ['planned', 'in_progress', 'done', 'partial', 'missed', 'carried_over'];

// Glyphs are decorative (aria-hidden) — the text label always carries the
// meaning, so color and icon are never the only signal.
export const STATUS_ICONS = {
  planned: '○',
  in_progress: '▶',
  done: '✓',
  partial: '◐',
  missed: '!',
  carried_over: '↷',
};

export function isValidStatus(status) {
  return STATUS_KEYS.includes(status);
}

export function statusLabelKey(status) {
  return `status.${isValidStatus(status) ? status : 'planned'}`;
}

function num(v) {
  return Number.isFinite(v) ? v : 0;
}

// Accepts either schedule_items' raw shape (item_type/start_minutes/
// end_minutes/completed_minutes/carried_over_minutes) or dashboard.js's
// in-memory camelCase shape (type/start/end/completedMinutes/...).
export function normalizeBlock(block) {
  if (!block) return null;
  return {
    type: block.type ?? block.item_type,
    start: block.start ?? block.start_minutes,
    end: block.end ?? block.end_minutes,
    completed: Boolean(block.completed),
    missed: Boolean(block.missed),
    completedMinutes: num(block.completedMinutes ?? block.completed_minutes),
    carriedOverMinutes: num(block.carriedOverMinutes ?? block.carried_over_minutes),
  };
}

// Status of one study block. null for anything that isn't a study block
// (classes, meals, breaks have no status).
// @param {{nowMinutes?:number, isToday?:boolean}} context
export function deriveBlockStatus(block, { nowMinutes = null, isToday = false } = {}) {
  const b = normalizeBlock(block);
  if (!b || b.type !== 'study') return null;
  if (b.completed) return 'done';
  // Logged minutes covering the whole block count as done even if the flag
  // wasn't set (the app always sets both, but older/imported rows may not).
  if (Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start && b.completedMinutes >= b.end - b.start) return 'done';
  if (b.carriedOverMinutes > 0) return 'carried_over';
  if (b.missed) return 'missed';
  if (b.completedMinutes > 0) return 'partial';
  if (isToday && Number.isFinite(nowMinutes) && Number.isFinite(b.start) && Number.isFinite(b.end) && nowMinutes >= b.start && nowMinutes < b.end) {
    return 'in_progress';
  }
  return 'planned';
}

// Status of a study task from all of its study blocks:
//   no blocks -> planned; every block done -> done; otherwise the most
//   pressing state among its blocks: missed > in_progress > carried_over >
//   partial (some done/partly done) > planned.
export function deriveTaskStatus(blocks, context = {}) {
  return combineTaskStatuses((blocks || []).map((b) => deriveBlockStatus(b, context)));
}

// The same rule from already-derived block statuses — for callers whose
// blocks don't share one context (e.g. the Board, where only some of a
// linked task's blocks fall on today).
export function combineTaskStatuses(blockStatuses) {
  const statuses = (blockStatuses || []).filter(Boolean);
  if (statuses.length === 0) return 'planned';
  if (statuses.every((s) => s === 'done')) return 'done';
  if (statuses.includes('missed')) return 'missed';
  if (statuses.includes('in_progress')) return 'in_progress';
  if (statuses.includes('carried_over')) return 'carried_over';
  if (statuses.some((s) => s === 'done' || s === 'partial')) return 'partial';
  return 'planned';
}

// { planned:n, in_progress:n, done:n, partial:n, missed:n, carried_over:n }
export function countStatuses(statuses) {
  const counts = Object.fromEntries(STATUS_KEYS.map((k) => [k, 0]));
  (statuses || []).forEach((s) => {
    if (isValidStatus(s)) counts[s] += 1;
  });
  return counts;
}

// Counts for a list of blocks, study blocks only.
export function countBlockStatuses(blocks, context = {}) {
  return countStatuses((blocks || []).map((b) => deriveBlockStatus(b, context)).filter(Boolean));
}

// The statuses worth surfacing in a compact summary (History rows, Week
// cards): anything that isn't plain "planned", in display order.
export const SUMMARY_ORDER = ['done', 'partial', 'missed', 'carried_over', 'in_progress'];

// ---------------------------------------------------------------------------
// Rendering (string/DOM helpers — the only part that touches the page)
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// <span class="status-badge status-done"><span aria-hidden>✓</span>Done</span>
// `label` is the already-translated text; `count` (optional) prefixes a
// number ("3 Done") for summary rows.
export function statusBadgeHtml(status, label, { count = null, compact = false } = {}) {
  const key = isValidStatus(status) ? status : 'planned';
  const text = count === null ? label : `${count} ${label}`;
  return `<span class="status-badge status-${key}${compact ? ' status-badge-compact' : ''}"><span class="status-icon" aria-hidden="true">${STATUS_ICONS[key]}</span><span class="status-label">${escapeHtml(text)}</span></span>`;
}

export function statusBadgeEl(status, label, options = {}) {
  const wrap = document.createElement('span');
  wrap.innerHTML = statusBadgeHtml(status, label, options);
  return wrap.firstElementChild;
}
