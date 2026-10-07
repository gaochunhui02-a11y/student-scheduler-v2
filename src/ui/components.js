// Reusable V3 view fragments, returned as html`` fragments (escaped by
// default — see dom.js). Keeping these in one place is what makes every
// page share the same empty states, chips, headers and progress visuals.

import { html, raw, safeColor, escapeHtml } from './dom.js';
import { icon } from './icons.js';
import { t } from '../shared/i18n.js';
import { FEATURE_MIGRATIONS } from '../shared/capabilities.js';

export function pageHead({ eyebrow, title, subtitle = '', actions = '' }) {
  return html`<header class="page-head">
    <div class="page-head-text">
      ${eyebrow ? html`<p class="page-eyebrow">${eyebrow}</p>` : ''}
      <h1 class="page-heading">${title}</h1>
      ${subtitle ? html`<p class="page-subtitle">${subtitle}</p>` : ''}
    </div>
    ${actions ? html`<div class="page-head-actions">${actions}</div>` : ''}
  </header>`;
}

export function emptyState({ iconName = 'sparkle', title, body = '', actions = '', compact = false }) {
  return html`<div class="empty${compact ? ' empty--compact' : ''}">
    <span class="empty-icon">${raw(icon(iconName))}</span>
    <p class="empty-title">${title}</p>
    ${body ? html`<p class="empty-body">${body}</p>` : ''}
    ${actions ? html`<div class="empty-actions">${actions}</div>` : ''}
  </div>`;
}

export function button(label, { variant = 'secondary', size = '', action = '', id = '', iconName = '', attrs = '' } = {}) {
  const cls = `btn btn--${variant}${size ? ` btn--${size}` : ''}`;
  return html`<button type="button" class="${cls}"${action ? raw(` data-action="${escapeHtml(action)}"`) : ''}${id ? raw(` id="${escapeHtml(id)}"`) : ''}${raw(attrs ? ` ${attrs}` : '')}>${iconName ? raw(icon(iconName)) : ''}<span>${label}</span></button>`;
}

export function courseChip(course) {
  if (!course) return '';
  const label = course.code || course.name;
  return html`<span class="course-chip" style="--c:${safeColor(course.color)}" title="${course.name}"><span class="course-dot"></span>${label}</span>`;
}

export function courseDot(course) {
  return html`<span class="course-dot" style="--c:${safeColor(course && course.color)}"></span>`;
}

export function badge(text, kind = '') {
  return html`<span class="badge${kind ? ` badge--${kind}` : ''}">${text}</span>`;
}

export function progressBar(fraction, { color = '', thin = false, label = '' } = {}) {
  const pct = Math.max(0, Math.min(100, Math.round((Number(fraction) || 0) * 100)));
  return html`<div class="bar${thin ? ' bar--thin' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"${label ? raw(` aria-label="${escapeHtml(label)}"`) : ''}><span style="width:${pct}%;${color ? `--c:${safeColor(color)}` : ''}"></span></div>`;
}

export function ring(fraction, { size = 56, stroke = 6, color = '', label = '' } = {}) {
  const f = Math.max(0, Math.min(1, Number(fraction) || 0));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return html`<span class="ring-wrap">
    <svg class="ring" style="--size:${size}px;--stroke:${stroke};${color ? `--c:${safeColor(color)}` : ''}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
      <circle class="ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}"></circle>
      <circle class="ring-fill" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - f)).toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})"></circle>
    </svg>
    ${label ? html`<span class="ring-label">${label}</span>` : ''}
  </span>`;
}

export function skeletonRows(n = 3, height = 44) {
  return html`<div class="skeleton-stack" aria-busy="true" aria-label="${t('common.loading')}">${Array.from({ length: n }, () => html`<span class="skeleton" style="height:${height}px"></span>`)}</div>`;
}

// Shown in place of a feature whose database migration isn't applied yet.
export function migrationNotice(feature) {
  const file = FEATURE_MIGRATIONS[feature] || '';
  return html`<div class="notice notice--info">
    ${raw(icon('info'))}
    <div>
      <p class="notice-title">${t('v3.needsUpdateTitle')}</p>
      <p>${t('v3.needsUpdateBody').replace('{file}', file)}</p>
    </div>
  </div>`;
}

export function errorNotice(message, { retryAction = '' } = {}) {
  return html`<div class="notice notice--danger" role="alert">
    ${raw(icon('alert'))}
    <div style="flex:1">
      <p class="notice-title">${t('v3.loadErrorTitle')}</p>
      <p>${message || t('v3.loadErrorBody')}</p>
    </div>
    ${retryAction ? button(t('common.retry'), { size: 'sm', action: retryAction }) : ''}
  </div>`;
}

// Keyboard-friendly segmented control. `options` = [{value, label}].
export function segmented(name, options, current, { label = '' } = {}) {
  return html`<div class="seg" role="group"${label ? raw(` aria-label="${escapeHtml(label)}"`) : ''} data-seg="${name}">
    ${options.map((o) => html`<button type="button" data-seg-value="${o.value}" aria-pressed="${o.value === current ? 'true' : 'false'}">${o.label}</button>`)}
  </div>`;
}

// ARIA tablist. `tabs` = [{id, label, count?}]
export function tabList(name, tabs, current) {
  return html`<div class="tabs" role="tablist" data-tabs="${name}">
    ${tabs.map((tb) => html`<button type="button" class="tab" role="tab" id="tab-${name}-${tb.id}" data-tab="${tb.id}" aria-selected="${tb.id === current ? 'true' : 'false'}" tabindex="${tb.id === current ? '0' : '-1'}">${tb.label}${tb.count !== undefined && tb.count !== null ? html`<span class="tab-count">${tb.count}</span>` : ''}</button>`)}
  </div>`;
}

// Arrow-key navigation for a rendered tabList; calls onSelect(id).
export function wireTabs(root, name, onSelect) {
  const list = root.querySelector(`[data-tabs="${name}"]`);
  if (!list) return;
  const tabs = Array.from(list.querySelectorAll('[role="tab"]'));
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => onSelect(tab.dataset.tab));
    tab.addEventListener('keydown', (e) => {
      let next = null;
      if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
      else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (e.key === 'Home') next = tabs[0];
      else if (e.key === 'End') next = tabs[tabs.length - 1];
      if (!next) return;
      e.preventDefault();
      onSelect(next.dataset.tab);
      requestAnimationFrame(() => {
        const again = root.querySelector(`[data-tabs="${name}"] [data-tab="${next.dataset.tab}"]`);
        if (again) again.focus();
      });
    });
  });
}

export function wireSegmented(root, name, onSelect) {
  const group = root.querySelector(`[data-seg="${name}"]`);
  if (!group) return;
  group.querySelectorAll('[data-seg-value]').forEach((btn) => {
    btn.addEventListener('click', () => onSelect(btn.dataset.segValue));
  });
}
