// Renders the keyboard-shortcut reference (used by "?" and Settings → Keyboard).

import { t } from './i18n.js';
import { h } from '../ui/dom.js';
import { SHORTCUTS } from './keyboard.js';

export function buildShortcutList() {
  const isMac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
  const list = h('dl', { class: 'kbd-list' });
  SHORTCUTS.forEach((s) => {
    const keys = h('dt', {});
    s.keys.forEach((k, i) => {
      if (i > 0) keys.appendChild(h('span', { class: 'kbd-then' }, s.then ? t('kbd.then') : '+'));
      keys.appendChild(h('kbd', { class: 'kbd' }, k === 'Ctrl/⌘' ? (isMac ? '⌘' : 'Ctrl') : k));
    });
    list.appendChild(h('div', { class: 'kbd-row' }, keys, h('dd', {}, t(s.labelKey))));
  });
  return list;
}
