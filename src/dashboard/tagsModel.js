// Pure, DOM-free, Supabase-free model logic for Study Task tags (V2-A).
// Tags live in study_subjects.tags (a jsonb array of plain strings — see
// migration 0005). This module only ever transforms a plain string array;
// dashboard.js owns rendering the chip UI and persisting the result via
// the existing updateStudySubject/insertStudySubject functions (tags is
// just one more field in that same fields object, nothing new to wire on
// the data-layer side).

export const PRESET_TASK_TAGS = ['Exam', 'Homework', 'Reading', 'Project', 'Review'];

const MAX_TAG_LENGTH = 30;
const MAX_TAGS_PER_TASK = 12;

export function normalizeTag(tag) {
  const str = typeof tag === 'string' ? tag.trim() : '';
  return str.slice(0, MAX_TAG_LENGTH);
}

export function isValidTag(tag) {
  return normalizeTag(tag).length > 0;
}

// Tolerates anything that isn't actually a plain array of strings (a stray
// null from an old row, a malformed value) by just treating it as "no
// tags" rather than throwing — the same defensive style
// computeAvailableStudyMinutes/computeSubtaskProgress already use.
export function normalizeTagList(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const result = [];
  for (const raw of tags) {
    const tag = normalizeTag(raw);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
    if (result.length >= MAX_TAGS_PER_TASK) break;
  }
  return result;
}

export function hasTag(tags, tag) {
  return normalizeTagList(tags).includes(normalizeTag(tag));
}

// Returns a NEW array with `tag` added if absent or removed if present —
// never mutates the array passed in, same immutable-update convention as
// src/board/boardModel.js's linkNodeToStudyTask.
export function toggleTag(tags, tag) {
  const normalized = normalizeTag(tag);
  if (!normalized) return normalizeTagList(tags);
  const list = normalizeTagList(tags);
  return list.includes(normalized) ? list.filter((t) => t !== normalized) : normalizeTagList([...list, normalized]);
}

// A custom tag is added the same way a preset one is toggled on — this is
// really just toggleTag with a validity guard for an empty/whitespace-only
// custom input, kept as its own named function since "add a custom tag"
// and "toggle a preset chip" are different user actions even though the
// underlying operation is identical.
export function addCustomTag(tags, tag) {
  if (!isValidTag(tag)) return normalizeTagList(tags);
  return toggleTag(tags, tag);
}
