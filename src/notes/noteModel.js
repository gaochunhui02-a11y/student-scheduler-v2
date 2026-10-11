// Notes (V4-H), pure — no DOM, no Supabase.
// A note has an optional title (its first line stands in when empty), a
// body, up to 20 tags, pinned/archived flags and optional links to one
// course, project, goal, exam and/or task (migration 0025).

import { noteExcerpt } from './noteMarkdown.js';

export const NOTE_LIMITS = { title: 200, body: 50000, tags: 20, tag: 40 };
export const LINK_KINDS = ['course_id', 'project_id', 'goal_id', 'exam_id', 'task_id'];

export function cleanTags(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(',');
  return [...new Set(list.map((x) => String(x).trim().replace(/^#/, '').slice(0, NOTE_LIMITS.tag)).filter(Boolean))].slice(0, NOTE_LIMITS.tags);
}

export function validateNoteFields(input = {}) {
  const errors = {};
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title.length > NOTE_LIMITS.title) errors.title = 'notes.errTitleLong';
  const body = typeof input.body === 'string' ? input.body : '';
  if (body.length > NOTE_LIMITS.body) errors.body = 'notes.errBodyLong';
  if (!title && !body.trim()) errors.body = 'notes.errEmpty';
  const fields = { title: title.slice(0, NOTE_LIMITS.title), body: body.slice(0, NOTE_LIMITS.body), tags: cleanTags(input.tags) };
  LINK_KINDS.forEach((k) => { if (k in input) fields[k] = input[k] || null; });
  if ('space_id' in input) fields.space_id = input.space_id || null;
  if ('pinned' in input) fields.pinned = Boolean(input.pinned);
  if ('archived' in input) fields.archived = Boolean(input.archived);
  return { ok: Object.keys(errors).length === 0, errors, fields };
}

/** What to show as the note's name: its title, else its first line, else "Untitled". */
export function noteDisplayTitle(note, untitled = 'Untitled') {
  if (note && note.title && note.title.trim()) return note.title.trim();
  const first = String((note && note.body) || '').split('\n').map((l) => l.replace(/^#{1,3}\s+/, '').trim()).find(Boolean);
  return first ? noteExcerpt(first, 80) : untitled;
}

/**
 * @param {Array} notes
 * @param {{ view?: 'all'|'pinned'|'archived', search?: string, linkKind?: string, linkId?: string, tag?: string }} f
 * @param {(n) => boolean} [spaceMatch]
 */
export function filterNotes(notes = [], f = {}, spaceMatch = () => true) {
  const q = (f.search || '').trim().toLowerCase();
  const view = f.view || 'all';
  return notes.filter((n) => {
    if (view === 'archived' ? !n.archived : n.archived) return false;
    if (view === 'pinned' && !n.pinned) return false;
    if (f.linkKind && f.linkId && n[f.linkKind] !== f.linkId) return false;
    if (f.tag && !(n.tags || []).includes(f.tag)) return false;
    if (!spaceMatch(n)) return false;
    if (q && !`${n.title} ${n.body} ${(n.tags || []).join(' ')}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** Pinned first, then most recently edited. */
export function sortNotes(notes = []) {
  return notes.slice().sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
    || String(b.updated_at || '').localeCompare(String(a.updated_at || ''))
    || String(a.id).localeCompare(String(b.id)));
}

/** Note templates — the body is filled from translated strings by the UI. */
export const NOTE_TEMPLATES = ['blank', 'lecture', 'meeting', 'reading', 'weekly'];

/**
 * Builds a template body from a translate function so it's in the
 * student's language (keys notes.tpl_<id>_*).
 */
export function templateBody(id, t) {
  switch (id) {
    case 'lecture':
      return `# ${t('notes.tplLectureTitle')}\n\n## ${t('notes.tplKeyPoints')}\n- \n\n## ${t('notes.tplQuestions')}\n- [ ] \n\n## ${t('notes.tplToReview')}\n- `;
    case 'meeting':
      return `# ${t('notes.tplMeetingTitle')}\n\n## ${t('notes.tplAttendees')}\n- \n\n## ${t('notes.tplDiscussed')}\n- \n\n## ${t('notes.tplActions')}\n- [ ] `;
    case 'reading':
      return `# ${t('notes.tplReadingTitle')}\n\n## ${t('notes.tplSummary')}\n\n## ${t('notes.tplQuotes')}\n> \n\n## ${t('notes.tplThoughts')}\n- `;
    case 'weekly':
      return `# ${t('notes.tplWeeklyTitle')}\n\n## ${t('notes.tplPriorities')}\n1. \n2. \n3. \n\n## ${t('notes.tplChecklist')}\n- [ ] `;
    default:
      return '';
  }
}
