// "Showing: School · Show all" — shown on pages filtered by the sidebar's
// space switcher, so a filtered list never looks like missing data.

import { t } from '../shared/i18n.js';
import { html, safeColor } from '../ui/dom.js';
import { app } from '../app/context.js';
import { NO_SPACE } from './spacesModel.js';

export function currentSpaceFilter() {
  const fn = app().spaceFilter;
  return typeof fn === 'function' ? fn() : null;
}

export function spaceScopeNote() {
  const filter = currentSpaceFilter();
  if (!filter) return '';
  const space = filter === NO_SPACE ? null : (app().spaces() || []).find((s) => s.id === filter);
  const name = filter === NO_SPACE ? t('spaces.none') : space ? space.name : '';
  if (!name) return '';
  return html`<p class="space-scope" role="status">
    <span class="space-scope-dot" style="--c:${safeColor(space && space.color, '#8a91a0')}" aria-hidden="true"></span>
    <span>${t('spaces.showing').replace('{name}', name)}</span>
    <button type="button" class="btn btn--ghost btn--sm" data-space-clear>${t('spaces.showAll')}</button>
  </p>`;
}
