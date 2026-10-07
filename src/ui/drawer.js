// Accessible side drawer (bottom sheet on phones). Used instead of modals
// for editing records: the page behind stays visible, focus is trapped
// inside while open, Escape / backdrop / Close all dismiss it, and focus
// returns to whatever opened it.

import { h } from './dom.js';
import { icon } from './icons.js';
import { t } from '../shared/i18n.js';

let openStack = [];

function focusables(root) {
  return Array.from(root.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
    .filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.subtitle]
 * @param {'wide'|'narrow'} [opts.size]
 * @param {(body: HTMLElement, api: object) => void} opts.render  fills the body
 * @param {Array<{label:string, variant?:string, onClick:Function, start?:boolean, id?:string}>} [opts.actions]
 * @param {() => (boolean|void)} [opts.onClose] return false to keep it open
 */
export function openDrawer({ title, subtitle = '', size = '', render, actions = [], onClose, labelledBy } = {}) {
  const opener = document.activeElement;
  const titleId = labelledBy || `drawer-title-${Math.random().toString(36).slice(2, 8)}`;
  const backdrop = h('div', { class: 'drawer-backdrop' });
  const closeBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm', 'aria-label': t('common.close') });
  closeBtn.innerHTML = icon('close');
  const titleEl = h('h2', { class: 'drawer-title', id: titleId }, title);
  const head = h('div', { class: 'drawer-head' }, h('div', {}, titleEl, subtitle ? h('p', { class: 'drawer-sub' }, subtitle) : null), closeBtn);
  const body = h('div', { class: 'drawer-body' });
  const foot = h('div', { class: 'drawer-foot' });
  const panel = h('div', { class: `drawer${size ? ` drawer--${size}` : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, head, body, foot);

  let closed = false;
  const api = {
    panel,
    body,
    setTitle(text) { titleEl.textContent = text; },
    setActions(list) { renderActions(list); },
    setBusy(busy) {
      foot.querySelectorAll('button').forEach((b) => { b.disabled = Boolean(busy); });
    },
    close(force = false) {
      if (closed) return;
      if (!force && typeof onClose === 'function' && onClose() === false) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      panel.remove();
      openStack = openStack.filter((d) => d !== api);
      if (openStack.length === 0) document.body.style.overflow = '';
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
    },
  };

  function renderActions(list) {
    foot.innerHTML = '';
    (list || []).forEach((a) => {
      const btn = h('button', { type: 'button', class: `btn btn--${a.variant || 'secondary'}${a.start ? ' drawer-foot-start' : ''}`, id: a.id || null }, a.label);
      btn.addEventListener('click', () => a.onClick(api, btn));
      foot.appendChild(btn);
    });
    foot.hidden = !list || list.length === 0;
  }

  function onKey(e) {
    if (openStack[openStack.length - 1] !== api) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      api.close();
      return;
    }
    if (e.key === 'Tab') {
      const items = focusables(panel);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  closeBtn.addEventListener('click', () => api.close());
  backdrop.addEventListener('click', () => api.close());
  document.addEventListener('keydown', onKey, true);
  renderActions(actions);
  if (typeof render === 'function') render(body, api);
  document.body.appendChild(backdrop);
  document.body.appendChild(panel);
  document.body.style.overflow = 'hidden';
  openStack.push(api);

  requestAnimationFrame(() => {
    const preferred = panel.querySelector('[data-autofocus]') || focusables(body)[0] || closeBtn;
    preferred.focus();
  });
  return api;
}

export function closeAllDrawers() {
  openStack.slice().reverse().forEach((d) => d.close(true));
}

// Simple confirmation sheet. Resolves true/false.
export function confirmAction({ title, message, confirmLabel, danger = false, cancelLabel }) {
  return new Promise((resolve) => {
    let decided = false;
    openDrawer({
      title,
      size: 'narrow',
      render: (body) => {
        body.appendChild(h('p', { class: 'muted', style: { margin: 0 } }, message));
      },
      actions: [
        { label: cancelLabel || t('common.cancel'), variant: 'secondary', onClick: (api) => { decided = true; resolve(false); api.close(true); } },
        { label: confirmLabel || t('common.confirm'), variant: danger ? 'danger' : 'primary', onClick: (api) => { decided = true; resolve(true); api.close(true); } },
      ],
      onClose: () => {
        if (!decided) resolve(false);
      },
    });
  });
}
