// Calendar agenda controller (V2-E) — owns #calendarView's week agenda.
// Same bridge pattern as src/week/week.js: never imports data.js; reads
// only through hostApi.getWeekRangeData (the same fetch Week View and
// Home's workload card use) and navigates only through
// hostApi.openDateInPlanner. Read-only — it never writes anything.
//
// Merging/filtering lives in ./agendaModel.js (unit tested); this file only
// renders it. The Import/Export cards on the same page are still owned by
// ./calendar.js, unchanged.

import { t, getLocale } from '../shared/i18n.js';
import { formatClock } from '../dashboard/scheduler.js';
import { getWeekStart, getWeekDates, shiftWeek, isCurrentWeek } from '../week/weekModel.js';
import { buildAgenda, filterAgenda, countAgendaCategories, agendaCategory, AGENDA_FILTERS } from './agendaModel.js';
import { statusBadgeEl, statusLabelKey } from '../shared/statusModel.js';

const FILTER_STORAGE_KEY = 'scheduler.agendaFilter.v1';

function readStoredFilter() {
  try {
    const v = localStorage.getItem(FILTER_STORAGE_KEY);
    return AGENDA_FILTERS.includes(v) ? v : 'all';
  } catch {
    return 'all';
  }
}

function storeFilter(value) {
  try {
    localStorage.setItem(FILTER_STORAGE_KEY, value);
  } catch {
    // per-viewer convenience only
  }
}

function formatRangeLabel(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00`).toLocaleDateString(getLocale(), { month: 'short', day: 'numeric' });
  const end = new Date(`${endDate}T00:00:00`).toLocaleDateString(getLocale(), { month: 'short', day: 'numeric', year: 'numeric' });
  return `${start} – ${end}`;
}

const ORIGIN_LABEL_KEYS = { recurring: 'calendar.originRecurring', imported: 'calendar.originImported' };

export function initAgendaSection(userId, hostApi = {}) {
  const view = document.getElementById('calendarView');
  const listEl = document.getElementById('agendaList');
  const headingEl = document.getElementById('agendaRangeHeading');
  const statusEl = document.getElementById('agendaStatus');
  const filtersEl = document.getElementById('agendaFilters');
  const prevBtn = document.getElementById('agendaPrevBtn');
  const nextBtn = document.getElementById('agendaNextBtn');
  const todayBtn = document.getElementById('agendaTodayBtn');
  if (!view || !listEl || !headingEl) return null;

  let currentWeekStart = null;
  let filter = readStoredFilter();
  let days = [];
  let loadToken = 0;

  const today = () => (typeof hostApi.getTodayDateStr === 'function' ? hostApi.getTodayDateStr() : new Date().toISOString().slice(0, 10));

  function setStatus(text) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.hidden = !text;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderChips() {
    if (!filtersEl) return;
    const counts = countAgendaCategories(days);
    filtersEl.querySelectorAll('.agenda-chip').forEach((chip) => {
      const key = chip.dataset.filter;
      const active = key === filter;
      chip.classList.toggle('active', active);
      chip.setAttribute('aria-pressed', active ? 'true' : 'false');
      const countEl = chip.querySelector('.agenda-chip-count');
      if (countEl) countEl.textContent = String(counts[key] ?? 0);
    });
  }

  function renderList() {
    listEl.innerHTML = '';
    const todayStr = today();
    filterAgenda(days, filter).forEach((day) => {
      const dayEl = el('div', `agenda-day${day.date === todayStr ? ' is-today' : ''}`);
      const head = el('button', 'agenda-day-head');
      head.type = 'button';
      const label = new Date(`${day.date}T00:00:00`).toLocaleDateString(getLocale(), { weekday: 'long', month: 'short', day: 'numeric' });
      head.appendChild(el('span', 'agenda-day-label', label));
      if (day.date === todayStr) head.appendChild(el('span', 'agenda-today-badge', t('calendar.today')));
      head.appendChild(el('span', 'agenda-day-open', t('calendar.openDay')));
      head.addEventListener('click', () => {
        if (typeof hostApi.openDateInPlanner === 'function') hostApi.openDateInPlanner(day.date);
      });
      dayEl.appendChild(head);

      if (day.entries.length === 0) {
        dayEl.appendChild(el('p', 'agenda-empty', t('calendar.nothingHere')));
      } else {
        const ul = el('ul', 'agenda-entries');
        day.entries.forEach((entry) => {
          const category = agendaCategory(entry);
          const li = el('li', `agenda-entry agenda-entry-${category}${entry.completed ? ' is-done' : ''}`);
          const time = entry.start === null ? t('calendar.noTime') : `${formatClock(entry.start)}${entry.end !== null ? ` – ${formatClock(entry.end)}` : ''}`;
          li.appendChild(el('span', 'agenda-time', time));
          li.appendChild(el('i', `agenda-dot agenda-dot-${category === 'classes' ? 'class' : category}`));
          const main = el('span', 'agenda-main');
          main.appendChild(el('span', 'agenda-name', entry.name || '—')); // user-created content — never translated
          const tagKey = ORIGIN_LABEL_KEYS[entry.origin];
          if (tagKey) main.appendChild(el('span', 'agenda-tag', t(tagKey)));
          if (entry.modified) main.appendChild(el('span', 'agenda-tag', t('calendar.originModified')));
          if (entry.status && entry.status !== 'planned') main.appendChild(statusBadgeEl(entry.status, t(statusLabelKey(entry.status)), { compact: true }));
          li.appendChild(main);
          ul.appendChild(li);
        });
        dayEl.appendChild(ul);
      }
      listEl.appendChild(dayEl);
    });
  }

  async function loadAndRender(weekStart) {
    currentWeekStart = weekStart;
    if (todayBtn) todayBtn.classList.toggle('active', isCurrentWeek(weekStart, today()));
    const dates = getWeekDates(weekStart);
    headingEl.textContent = formatRangeLabel(dates[0], dates[6]);
    const token = ++loadToken;
    setStatus('');
    listEl.innerHTML = `<p class="hint">${t('week.loading')}</p>`;
    try {
      const data = await hostApi.getWeekRangeData(dates[0], dates[6]);
      if (token !== loadToken) return;
      days = buildAgenda({ dates, ...data });
    } catch (err) {
      if (token !== loadToken) return;
      console.error('Could not load calendar:', err);
      days = [];
      listEl.innerHTML = '';
      setStatus(t('week.loadError'));
      renderChips();
      return;
    }
    renderChips();
    renderList();
  }

  if (filtersEl) {
    filtersEl.addEventListener('click', (e) => {
      const chip = e.target.closest('.agenda-chip');
      if (!chip || !AGENDA_FILTERS.includes(chip.dataset.filter)) return;
      filter = chip.dataset.filter;
      storeFilter(filter);
      renderChips();
      renderList();
    });
  }
  if (prevBtn) prevBtn.addEventListener('click', () => loadAndRender(shiftWeek(currentWeekStart || getWeekStart(today()), -1)));
  if (nextBtn) nextBtn.addEventListener('click', () => loadAndRender(shiftWeek(currentWeekStart || getWeekStart(today()), 1)));
  if (todayBtn) todayBtn.addEventListener('click', () => loadAndRender(getWeekStart(today())));

  function onShow() {
    return loadAndRender(currentWeekStart || getWeekStart(today()));
  }

  return { onShow };
}
