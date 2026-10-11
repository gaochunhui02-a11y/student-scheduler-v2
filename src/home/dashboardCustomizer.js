// "Customize dashboard" drawer (V4-D): show/hide each widget and move it up
// or down (buttons, so it works with a keyboard and a screen reader — no
// drag needed). Nothing is saved until Save; Reset returns to the default
// for the workspace mode.

import { openDrawer } from '../ui/drawer.js';
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { t } from '../shared/i18n.js';
import { app } from '../app/context.js';
import { resolveDashboard, setWidget, moveWidget, widgetById, isDefaultDashboard } from './dashboardLayout.js';
import { saveDashboardLayout } from './dashboardPrefs.js';

export function openDashboardCustomizer({ layout, mode, isAvailable = () => true, onSaved } = {}) {
  let draft = layout;
  let list = null;

  function paint(focus = null) {
    list.innerHTML = '';
    const items = resolveDashboard(draft, mode);
    items.forEach((x, i) => {
      const w = widgetById(x.id);
      const label = t(w.labelKey);
      const available = isAvailable(w);
      const cbId = `dash-w-${x.id}`;
      const cb = h('input', { type: 'checkbox', id: cbId, 'data-widget': x.id });
      cb.checked = x.on;
      cb.addEventListener('change', () => { draft = setWidget(draft, mode, x.id, cb.checked); paint(`#${cbId}`); });
      const up = h('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm', 'data-move': 'up', 'aria-label': t('dash.moveUp').replace('{name}', label) });
      up.innerHTML = icon('chevronUp');
      up.disabled = i === 0;
      up.addEventListener('click', () => { draft = moveWidget(draft, mode, x.id, 'up'); paint(`[data-row="${x.id}"] [data-move="up"]`); });
      const down = h('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm', 'data-move': 'down', 'aria-label': t('dash.moveDown').replace('{name}', label) });
      down.innerHTML = icon('chevronDown');
      down.disabled = i === items.length - 1;
      down.addEventListener('click', () => { draft = moveWidget(draft, mode, x.id, 'down'); paint(`[data-row="${x.id}"] [data-move="down"]`); });
      const text = h('label', { for: cbId, class: 'dash-cust-label' }, h('span', {}, label));
      if (!available) text.appendChild(h('span', { class: 'dash-cust-note' }, t('dash.unavailable')));
      list.appendChild(h('li', { class: `dash-cust-row${x.on ? '' : ' is-off'}`, 'data-row': x.id }, cb, text, h('span', { class: 'dash-cust-move' }, up, down)));
    });
    if (focus) {
      const el = list.querySelector(focus);
      // A disabled button can't take focus (top/bottom reached): focus the other one.
      if (el && !el.disabled) el.focus();
      else list.querySelector(focus.replace(/"(up|down)"/, (m, d) => (d === 'up' ? '"down"' : '"up"')))?.focus();
    }
  }

  openDrawer({
    title: t('dash.customizeTitle'),
    subtitle: t('dash.customizeSub'),
    size: 'narrow',
    render: (body) => {
      list = h('ul', { class: 'dash-cust-list', 'aria-label': t('dash.widgetsLabel') });
      body.appendChild(list);
      paint();
    },
    actions: [
      {
        label: t('dash.reset'),
        variant: 'secondary',
        start: true,
        onClick: () => { draft = null; paint(); toast(t('dash.resetPreview')); },
      },
      { label: t('common.cancel'), variant: 'secondary', onClick: (api) => api.close() },
      {
        label: t('common.save'),
        variant: 'primary',
        onClick: async (api) => {
          api.setBusy(true);
          try {
            const value = draft && !isDefaultDashboard(draft, mode) ? draft : null;
            const saved = await saveDashboardLayout(app().userId, value);
            api.close(true);
            toast(t('dash.saved'), { kind: 'success' });
            if (onSaved) onSaved(saved);
          } catch (err) {
            console.error(err);
            api.setBusy(false);
            toast(t('v3.saveError'), { kind: 'error' });
          }
        },
      },
    ],
  });
}
