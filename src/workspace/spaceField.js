// The Space <select> used by the course and task editors (V4-A). Returns
// null when spaces aren't available (database without 0018, or no spaces
// yet), so editors look exactly like V3 until the student creates a space.

import { t } from '../shared/i18n.js';
import { h } from '../ui/dom.js';
import { app } from '../app/context.js';
import { has } from '../shared/capabilities.js';
import { sortSpaces, NO_SPACE } from './spacesModel.js';

export function spacesEnabled() {
  return has('spaces') && has('spaceLinks') && (app().spaces() || []).some((s) => !s.archived);
}

/** Space to preselect for something new: the space being viewed, else the default space. */
export function defaultSpaceForNew() {
  const filter = app().spaceFilter();
  if (filter && filter !== NO_SPACE) return filter;
  const ws = app().workspace();
  return (ws && ws.defaultSpaceId) || '';
}

/**
 * @param {string} id          element id
 * @param {string|null} value  current space id
 * @param {string} emptyKey    label for "no space"
 */
export function spaceSelect(id, value, emptyKey = 'spaces.noneOption') {
  if (!spacesEnabled()) return null;
  const spaces = sortSpaces(app().spaces() || []).filter((s) => !s.archived || s.id === value);
  const sel = h('select', { id }, h('option', { value: '' }, t(emptyKey)));
  spaces.forEach((s) => sel.appendChild(h('option', { value: s.id }, s.archived ? `${s.name} (${t('spaces.archived')})` : s.name)));
  sel.value = value || '';
  return sel;
}
