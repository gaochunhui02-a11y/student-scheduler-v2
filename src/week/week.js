// Week View client controller (V2-A) — owns all #weekView DOM. Completely
// isolated from src/dashboard/dashboard.js: it never imports data.js
// directly, and dashboard.js only ever calls initWeekSection(userId,
// hostApi) and the returned onShow(); it never reaches into this module's
// internals. Same bridge pattern as src/board/board.js,
// src/analytics/analytics.js, src/calendar/calendar.js.
//
// This view is entirely read-only — it never creates, updates, or deletes a
// class, study task, or schedule. The only "action" is clicking a day,
// which asks the host to switch the Planner to that date (hostApi's
// openDateInPlanner) — the exact same loadScheduleForDate the Planner's own
// date picker/Prev/Next buttons already use, never a second loader.
//
// Pure aggregation (date math, grouping classes/study minutes/deadlines by
// day, workload-bar scaling) lives in ./weekModel.js and is unit tested
// there; this file only renders what that module computes and wires the
// week-navigation buttons.

import { t, getLocale } from '../shared/i18n.js';
import { formatDuration } from '../dashboard/summary.js';
import { getWeekStart, getWeekDates, shiftWeek, isCurrentWeek, aggregateWeekView, computeWeekWorkloadBars, computeWeekSummary } from './weekModel.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatWeekRangeLabel(weekStartDate, weekEndDate) {
  const start = new Date(`${weekStartDate}T00:00:00`).toLocaleDateString(getLocale(), { month: 'short', day: 'numeric' });
  const end = new Date(`${weekEndDate}T00:00:00`).toLocaleDateString(getLocale(), { month: 'short', day: 'numeric', year: 'numeric' });
  return `${start} – ${end}`;
}

function formatDayHeadLabel(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return {
    weekday: d.toLocaleDateString(getLocale(), { weekday: 'short' }),
    dayNum: d.toLocaleDateString(getLocale(), { day: 'numeric' }),
  };
}

export function initWeekSection(userId, hostApi = {}) {
  const rangeHeadingEl = document.getElementById('weekRangeHeading');
  const gridEl = document.getElementById('weekGrid');
  const statusEl = document.getElementById('weekStatus');
  const prevBtn = document.getElementById('weekPrevBtn');
  const nextBtn = document.getElementById('weekNextBtn');
  const todayBtn = document.getElementById('weekTodayBtn');
  const summaryStudyTimeEl = document.getElementById('weekSummaryStudyTime');
  const summaryClassesEl = document.getElementById('weekSummaryClasses');
  const summaryDeadlinesEl = document.getElementById('weekSummaryDeadlines');
  const summaryBusiestWrapEl = document.getElementById('weekSummaryBusiestWrap');
  const summaryBusiestEl = document.getElementById('weekSummaryBusiest');

  if (!rangeHeadingEl || !gridEl) return null;

  let currentWeekStart = null;
  let loadToken = 0;

  function setStatus(text) {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    statusEl.hidden = !text;
  }

  function renderSummary(summary) {
    if (summaryStudyTimeEl) summaryStudyTimeEl.textContent = formatDuration(summary.totalStudyMinutes);
    if (summaryClassesEl) summaryClassesEl.textContent = String(summary.totalClasses);
    if (summaryDeadlinesEl) summaryDeadlinesEl.textContent = String(summary.totalDeadlines);
    if (summaryBusiestWrapEl && summaryBusiestEl) {
      if (summary.busiestDate) {
        summaryBusiestWrapEl.hidden = false;
        const d = new Date(`${summary.busiestDate}T00:00:00`);
        summaryBusiestEl.textContent = d.toLocaleDateString(getLocale(), { weekday: 'short', month: 'short', day: 'numeric' });
      } else {
        summaryBusiestWrapEl.hidden = true;
      }
    }
  }

  function renderGrid(days, bars) {
    const todayStr = typeof hostApi.getTodayDateStr === 'function' ? hostApi.getTodayDateStr() : null;
    const barsByDate = new Map(bars.map((b) => [b.date, b]));

    gridEl.innerHTML = days
      .map((day) => {
        const bar = barsByDate.get(day.date) || { barFraction: 0, overloaded: false };
        const { weekday, dayNum } = formatDayHeadLabel(day.date);
        const isToday = day.date === todayStr;

        const classesHtml = day.classes
          .map((c) => `<li class="week-day-class-item">${escapeHtml(c.start_time ? c.start_time.slice(0, 5) : '')} ${escapeHtml(c.name)}</li>`)
          .join('');
        const deadlinesHtml = day.deadlines
          .map(
            (d) => `<li class="week-day-deadline-item week-day-deadline-${escapeHtml(d.priority)}" title="${escapeHtml(d.name)}">${escapeHtml(d.name)}</li>`
          )
          .join('');

        return `
          <button type="button" class="week-day-card${isToday ? ' week-day-today' : ''}" data-date="${escapeHtml(day.date)}">
            <div class="week-day-head">
              <span class="week-day-name">${escapeHtml(weekday)}</span>
              <span class="week-day-num">${escapeHtml(dayNum)}</span>
            </div>
            <div class="week-day-bar-track" title="${escapeHtml(formatDuration(day.studyMinutes))}">
              <div class="week-day-bar${bar.overloaded ? ' week-day-bar-overloaded' : ''}" style="height:${Math.round(bar.barFraction * 100)}%"></div>
            </div>
            <div class="week-day-study">${day.studyMinutes > 0 ? escapeHtml(formatDuration(day.studyMinutes)) : ''}</div>
            ${classesHtml ? `<ul class="week-day-classes">${classesHtml}</ul>` : ''}
            ${deadlinesHtml ? `<ul class="week-day-deadlines">${deadlinesHtml}</ul>` : ''}
          </button>
        `;
      })
      .join('');
  }

  async function loadAndRender(weekStart) {
    currentWeekStart = weekStart;
    if (todayBtn) todayBtn.classList.toggle('active', isCurrentWeek(weekStart, hostApi.getTodayDateStr()));

    const weekDates = getWeekDates(weekStart);
    const token = ++loadToken;
    setStatus('');
    rangeHeadingEl.textContent = formatWeekRangeLabel(weekDates[0], weekDates[6]);
    gridEl.innerHTML = `<p class="hint">${escapeHtml(t('week.loading'))}</p>`;

    let data;
    try {
      data = await hostApi.getWeekRangeData(weekDates[0], weekDates[6]);
    } catch (e) {
      console.error(e);
      if (token !== loadToken) return;
      gridEl.innerHTML = '';
      setStatus(t('week.loadError'));
      return;
    }
    if (token !== loadToken) return;

    const days = aggregateWeekView({
      weekDates,
      schedules: data.schedules,
      classes: data.classes,
      items: data.items,
      dueSubjects: data.dueSubjects,
    });
    renderSummary(computeWeekSummary(days));
    renderGrid(days, computeWeekWorkloadBars(days));
  }

  gridEl.addEventListener('click', (e) => {
    const card = e.target.closest('.week-day-card');
    if (!card || typeof hostApi.openDateInPlanner !== 'function') return;
    hostApi.openDateInPlanner(card.dataset.date);
  });

  if (prevBtn) prevBtn.addEventListener('click', () => loadAndRender(shiftWeek(currentWeekStart || getWeekStart(hostApi.getTodayDateStr()), -1)));
  if (nextBtn) nextBtn.addEventListener('click', () => loadAndRender(shiftWeek(currentWeekStart || getWeekStart(hostApi.getTodayDateStr()), 1)));
  if (todayBtn) todayBtn.addEventListener('click', () => loadAndRender(getWeekStart(hostApi.getTodayDateStr())));

  // Refreshed every time the view is opened (not cached from first open) —
  // same reasoning as analytics.js's onShow: Planner edits made elsewhere in
  // the same session must show up here. The CHOSEN week (if the user had
  // already navigated away from "this week") is preserved across repeat
  // opens; only the very first open defaults to the current week.
  function onShow() {
    return loadAndRender(currentWeekStart || getWeekStart(hostApi.getTodayDateStr()));
  }

  return { onShow };
}
