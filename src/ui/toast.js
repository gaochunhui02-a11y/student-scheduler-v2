// Non-blocking status messages ("Saved", "Moved 2 sessions", errors with
// a plain-language explanation). Announced politely to screen readers via
// the #toastRegion aria-live container in dashboard.html.

import { h } from './dom.js';
import { icon } from './icons.js';

export function toast(message, { kind = 'info', actionLabel = '', onAction = null, timeout = 4200 } = {}) {
  const region = document.getElementById('toastRegion');
  if (!region) return () => {};
  const iconEl = h('span', { class: 'toast-icon', 'aria-hidden': 'true' });
  iconEl.innerHTML = kind === 'error' ? icon('alert') : kind === 'success' ? icon('check') : icon('info');
  iconEl.style.display = 'inline-flex';
  iconEl.style.width = '18px';
  const el = h('div', { class: `toast toast--${kind}`, role: kind === 'error' ? 'alert' : 'status' }, iconEl, h('span', { class: 'toast-text' }, message));
  if (actionLabel && typeof onAction === 'function') {
    const btn = h('button', { type: 'button', class: 'toast-action' }, actionLabel);
    btn.addEventListener('click', () => {
      onAction();
      dismiss();
    });
    el.appendChild(btn);
  }
  region.appendChild(el);
  while (region.children.length > 3) region.firstElementChild.remove();
  let timer = setTimeout(dismiss, kind === 'error' ? Math.max(timeout, 7000) : timeout);
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => { timer = setTimeout(dismiss, 2000); });
  function dismiss() {
    clearTimeout(timer);
    el.remove();
  }
  return dismiss;
}
