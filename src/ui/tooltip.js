// One shared tooltip for chart marks: any element with data-tip="…" shows
// it on hover AND on keyboard focus (so it's never mouse-only). The text is
// set with textContent, never HTML.

let tipEl = null;
let installed = false;

function ensureEl() {
  if (tipEl) return tipEl;
  tipEl = document.createElement('div');
  tipEl.className = 'chart-tip';
  tipEl.setAttribute('role', 'tooltip');
  tipEl.hidden = true;
  document.body.appendChild(tipEl);
  return tipEl;
}

function show(target) {
  const text = target.getAttribute('data-tip');
  if (!text) return;
  const el = ensureEl();
  el.textContent = text;
  el.hidden = false;
  const r = target.getBoundingClientRect();
  const tr = el.getBoundingClientRect();
  let left = r.left + r.width / 2 - tr.width / 2;
  left = Math.max(8, Math.min(window.innerWidth - tr.width - 8, left));
  let top = r.top - tr.height - 8;
  if (top < 8) top = r.bottom + 8;
  el.style.left = `${left + window.scrollX}px`;
  el.style.top = `${top + window.scrollY}px`;
}

function hide() {
  if (tipEl) tipEl.hidden = true;
}

export function installTooltips() {
  if (installed) return;
  installed = true;
  const over = (e) => {
    const t = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
    if (t) show(t);
  };
  document.addEventListener('mouseover', over);
  document.addEventListener('focusin', over);
  document.addEventListener('mouseout', (e) => {
    if (e.target instanceof Element && e.target.closest('[data-tip]')) hide();
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('scroll', hide, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
}
