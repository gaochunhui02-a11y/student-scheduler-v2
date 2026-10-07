// Applies the workspace to the sidebar (V4-A): hides switched-off modules and
// empty sections, and renders the space switcher. The nav buttons themselves
// are static HTML (dashboard.html, data-module=…) so every existing click
// handler keeps working; this only toggles `hidden`.

import { t } from '../shared/i18n.js';
import { h } from '../ui/dom.js';
import { visibleModules } from './modules.js';
import { sortSpaces, NO_SPACE } from './spacesModel.js';

export function applyNavigation(ws) {
  const visible = new Set(visibleModules(ws));
  document.querySelectorAll('[data-module]').forEach((btn) => {
    btn.hidden = !visible.has(btn.dataset.module);
  });
  document.querySelectorAll('[data-nav-section]').forEach((sec) => {
    const items = sec.querySelectorAll('.nav-item');
    sec.hidden = items.length > 0 && [...items].every((b) => b.hidden);
  });
}

/**
 * @param {HTMLElement} root  #spaceSwitcher
 * @param {Array} spaces
 * @param {string|null} current  null = all, NO_SPACE, or a space id
 * @param {(value: string|null) => void} onSelect
 */
export function renderSpaceSwitcher(root, spaces, current, onSelect) {
  if (!root) return;
  const active = sortSpaces(spaces).filter((s) => !s.archived);
  root.innerHTML = '';
  root.hidden = active.length === 0;
  if (!active.length) return;
  const select = h('select', { id: 'spaceSwitcherSelect', class: 'space-switcher-select' });
  const opt = (value, label) => {
    const o = h('option', { value }, label);
    if ((value || null) === (current || null) || (!value && !current)) o.selected = true;
    return o;
  };
  select.appendChild(opt('', t('spaces.all')));
  active.forEach((s) => select.appendChild(opt(s.id, s.name)));
  select.appendChild(opt(NO_SPACE, t('spaces.none')));
  // Updates in place (never re-renders the select, so keyboard focus stays).
  const paint = (value) => {
    const sp = active.find((s) => s.id === value);
    root.style.setProperty('--space-c', sp && sp.color ? sp.color : 'transparent');
    root.classList.toggle('has-space', Boolean(sp));
  };
  paint(current);
  select.addEventListener('change', () => {
    paint(select.value);
    onSelect(select.value || null);
  });
  root.append(
    h('label', { for: 'spaceSwitcherSelect', class: 'sr-only' }, t('spaces.label')),
    h('span', { class: 'space-switcher-dot', 'aria-hidden': 'true' }),
    select,
  );
}
