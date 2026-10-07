// Tiny DOM helpers for V3 views. Rendering rule for the whole V3 layer:
// user-entered text only ever reaches the page through escapeHtml() (in
// template strings) or textContent (via h()). Nothing user-controlled is
// ever passed to innerHTML unescaped.

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Tagged template: interpolated values are escaped unless wrapped in raw().
const RAW = Symbol('raw');
export function raw(htmlString) {
  return { [RAW]: true, value: String(htmlString ?? '') };
}
export function html(strings, ...values) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += renderValue(values[i]);
  });
  return raw(out);
}
function renderValue(v) {
  if (v === null || v === undefined || v === false) return '';
  if (Array.isArray(v)) return v.map(renderValue).join('');
  if (typeof v === 'object' && v[RAW]) return v.value;
  return escapeHtml(v);
}
export function toHtml(fragment) {
  return renderValue(fragment);
}
export function setHtml(el, fragment) {
  if (el) el.innerHTML = renderValue(fragment);
  return el;
}

// h('button', { class: 'btn', onclick: fn, 'aria-label': 'x' }, 'text', childEl)
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([key, value]) => {
    if (value === null || value === undefined || value === false) return;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  });
  children.flat().forEach((child) => {
    if (child === null || child === undefined || child === false) return;
    el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return el;
}

// CSS custom property value for a stored course colour. Only accepts
// "#rrggbb" so a corrupted value can never inject arbitrary CSS.
export function safeColor(value, fallback = '#8a91a0') {
  return /^#[0-9a-fA-F]{6}$/.test(value || '') ? value : fallback;
}

// Delegated click handling: on(root, 'click', '[data-action]', (e, el) => …)
export function on(root, type, selector, handler) {
  if (!root) return () => {};
  const listener = (e) => {
    const target = e.target instanceof Element ? e.target.closest(selector) : null;
    if (target && root.contains(target)) handler(e, target);
  };
  root.addEventListener(type, listener);
  return () => root.removeEventListener(type, listener);
}

export function debounce(fn, ms = 200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
