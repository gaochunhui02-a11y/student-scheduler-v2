// Product tour overlay (V5-A). Dims the page, cuts a highlight around the
// real element, and shows a small card with Back / Next / Skip / Done.
//
// Accessibility: the card is a modal dialog (focus moves into it, Tab is
// trapped, Escape skips, ←/→ move between steps), each step is announced,
// focus returns to whatever opened the tour. Reduced motion: no transitions
// and instant scrolling. Targets are looked up when a step is shown; a
// missing / hidden element is skipped (tourModel.nextVisibleStep).

import { t } from '../shared/i18n.js';
import { h } from '../ui/dom.js';
import { prefersReducedMotion } from '../shared/motion.js';
import { TOURS, nextVisibleStep, visibleSteps, stepPosition, placeCard, stepTitleKey, stepBodyKey } from './tourModel.js';

let active = null;

export function isTourOpen() {
  return Boolean(active);
}

function isShown(el) {
  if (!el || !el.isConnected) return false;
  if (el.closest('[hidden]')) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

/** The element to highlight for a step, or null (centred step / missing). */
export function findTarget(step) {
  if (!step.target) return null;
  for (const sel of step.target) {
    let el = null;
    try {
      el = [...document.querySelectorAll(sel)].find(isShown) || null;
    } catch {
      el = null; // a bad selector must never break the app
    }
    if (el) return (step.area && el.closest(step.area)) || el;
  }
  return null;
}

function canShow(step) {
  return !step.target || Boolean(findTarget(step));
}

function focusables(root) {
  return [...root.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')];
}

/**
 * Starts a tour on the current page.
 * @param {string} tourId
 * @param {{ onEnd?: (status: 'done'|'skipped') => void }} [opts]
 * @returns {boolean} false when nothing on this page can be shown
 */
export function startTour(tourId, { onEnd } = {}) {
  const steps = TOURS[tourId];
  if (!steps) return false;
  if (active) active.end('skipped', { silent: true });
  const first = nextVisibleStep(steps, -1, 1, canShow);
  if (first < 0) return false;

  const reduced = prefersReducedMotion();
  const opener = document.activeElement;
  const titleId = 'tourTitle';
  const bodyId = 'tourBody';
  const spot = h('div', { class: 'tour-spot', 'aria-hidden': 'true' });
  const blocker = h('div', { class: 'tour-blocker', 'aria-hidden': 'true' });
  const count = h('p', { class: 'tour-count' });
  const title = h('h2', { class: 'tour-title', id: titleId });
  const body = h('p', { class: 'tour-text', id: bodyId });
  const skipBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm tour-skip' }, t('tour.skip'));
  const backBtn = h('button', { type: 'button', class: 'btn btn--secondary btn--sm' }, t('tour.back'));
  const nextBtn = h('button', { type: 'button', class: 'btn btn--primary btn--sm tour-next' }, t('tour.next'));
  const dots = h('div', { class: 'tour-dots', 'aria-hidden': 'true' });
  const card = h('div', { class: 'tour-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'aria-describedby': bodyId, tabindex: '-1' },
    count, title, body,
    h('div', { class: 'tour-foot' }, skipBtn, dots, h('span', { class: 'tour-nav' }, backBtn, nextBtn)));
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  const root = h('div', { class: `tour-root${reduced ? ' is-reduced' : ''}` }, blocker, spot, card, live);
  document.body.appendChild(root);
  document.body.classList.add('tour-open');

  let index = first;
  let target = null;
  let raf = 0;

  function position() {
    raf = 0;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const sheet = vw < 640;
    card.classList.toggle('is-sheet', sheet);
    let rect = null;
    if (target && target.isConnected) {
      const r = target.getBoundingClientRect();
      const pad = 6;
      rect = { top: r.top - pad, left: r.left - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
      // Very tall targets: keep the highlight within the viewport.
      rect.top = Math.max(rect.top, 4);
      rect.height = Math.min(rect.height, vh - rect.top - 4);
      Object.assign(spot.style, { top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      spot.hidden = false;
      root.classList.remove('is-centered');
    } else {
      spot.hidden = true;
      root.classList.add('is-centered');
    }
    if (sheet) {
      card.style.top = '';
      card.style.left = '';
      card.dataset.placement = 'sheet';
      return;
    }
    const size = { width: card.offsetWidth, height: card.offsetHeight };
    const p = placeCard(rect, size, { width: vw, height: vh });
    card.style.top = `${Math.round(p.top)}px`;
    card.style.left = `${Math.round(p.left)}px`;
    card.dataset.placement = p.placement;
  }
  function schedule() {
    if (!raf) raf = requestAnimationFrame(position);
  }

  function show(i) {
    index = i;
    const step = steps[i];
    target = findTarget(step);
    const visible = visibleSteps(steps, canShow);
    const pos = stepPosition(visible, i);
    count.textContent = t('tour.stepOf').replace('{n}', String(pos.n)).replace('{total}', String(pos.total));
    title.textContent = t(stepTitleKey(tourId, step));
    body.textContent = t(stepBodyKey(tourId, step));
    dots.innerHTML = visible.map((v) => `<span class="${v === i ? 'is-on' : ''}"></span>`).join('');
    const isFirst = nextVisibleStep(steps, i, -1, canShow) < 0;
    const isLast = nextVisibleStep(steps, i, 1, canShow) < 0;
    backBtn.hidden = isFirst;
    nextBtn.textContent = isLast ? t('tour.done') : t('tour.next');
    skipBtn.hidden = isLast;
    if (target) {
      const r = target.getBoundingClientRect();
      const offscreen = r.top < 0 || r.bottom > window.innerHeight || r.left < 0 || r.right > window.innerWidth;
      if (offscreen) target.scrollIntoView({ block: r.height > window.innerHeight * 0.6 ? 'start' : 'center', inline: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
    }
    position();
    // Smooth scrolling moves the target after we measured it; follow it.
    if (!reduced) setTimeout(schedule, 380);
    live.textContent = `${count.textContent}. ${title.textContent}. ${body.textContent}`;
    (nextBtn.hidden ? card : nextBtn).focus({ preventScroll: true });
  }

  function go(dir) {
    const i = nextVisibleStep(steps, index, dir, canShow);
    if (i < 0) {
      if (dir > 0) end('done');
      return;
    }
    show(i);
  }

  function onKey(e) {
    // The page's own shortcuts (palette, quick add…) stay quiet during a tour;
    // default actions (Enter/Space on the focused button) still happen.
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); end('skipped'); return; }
    if (e.key === 'ArrowRight' && !e.altKey) { e.preventDefault(); go(1); return; }
    if (e.key === 'ArrowLeft' && !e.altKey) { e.preventDefault(); go(-1); return; }
    if (e.key === 'Tab') {
      const list = focusables(card).filter((el) => !el.hidden);
      if (!list.length) return;
      const firstEl = list[0];
      const lastEl = list[list.length - 1];
      if (e.shiftKey && (document.activeElement === firstEl || !card.contains(document.activeElement))) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && (document.activeElement === lastEl || !card.contains(document.activeElement))) { e.preventDefault(); firstEl.focus(); }
    }
  }

  function end(status, { silent = false } = {}) {
    if (!active || active.root !== root) return;
    active = null;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', schedule);
    window.removeEventListener('scroll', schedule, true);
    if (raf) cancelAnimationFrame(raf);
    root.remove();
    document.body.classList.remove('tour-open');
    if (opener && typeof opener.focus === 'function' && opener.isConnected) opener.focus({ preventScroll: true });
    if (!silent && typeof onEnd === 'function') onEnd(status);
  }

  nextBtn.addEventListener('click', () => go(1));
  backBtn.addEventListener('click', () => go(-1));
  skipBtn.addEventListener('click', () => end('skipped'));
  blocker.addEventListener('click', () => card.focus());
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', schedule);
  window.addEventListener('scroll', schedule, true);

  active = { root, end };
  show(first);
  return true;
}

export function endTour() {
  if (active) active.end('skipped');
}
