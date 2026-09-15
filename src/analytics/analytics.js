// Dashboard + Analytics client controller — owns all #analyticsView DOM.
// Completely isolated from src/dashboard/dashboard.js: it never imports
// data.js or boardData.js directly, and dashboard.js only ever calls
// initAnalyticsSection(userId, hostApi) and the returned onShow(); it never
// reaches into this module's internals. Same bridge pattern as
// src/board/board.js and src/advisor/advisor.js.
//
// This view is entirely read-only/derived — it never creates, updates, or
// deletes a study task, class, schedule, or Board node. The only "action"
// buttons here (a row click -> Planner, "Ask AI Advisor" on an at-risk
// task) navigate to or pre-fill an EXISTING feature; nothing here writes
// to Supabase itself.
//
// No AI is used for any of the analytics/risk numbers — every calculation
// comes from src/analytics/analyticsModel.js's deterministic pure
// functions. The only AI touchpoint is the optional "Ask AI Advisor"
// button, which reuses Phase 9's Advisor as-is (hostApi.openAdvisorWithMessage)
// rather than building a second AI flow.

import { t } from '../shared/i18n.js';
import {
  lastNDates,
  attachDatesToItems,
  computeWeeklyTotals,
  computeCompletionRate,
  computeSubjectTotals,
  computeUpcomingDeadlines,
  countByRisk,
  computeProductivityPeriod,
  summarizeBoards,
  buildAdvisorPromptForTask,
} from './analyticsModel.js';
import { formatDuration } from '../dashboard/summary.js';

const RISK_LABEL_KEYS = { on_track: 'analytics.onTrack', needs_attention: 'analytics.needsAttention', at_risk: 'analytics.atRisk' };
const PERIOD_LABEL_KEYS = { morning: 'analytics.periodMorning', afternoon: 'analytics.periodAfternoon', evening: 'analytics.periodEvening', night: 'analytics.periodNight' };

export function initAnalyticsSection(userId, hostApi = {}) {
  const analyticsView = document.getElementById('analyticsView');
  if (!analyticsView) return null;

  const statusEl = document.getElementById('analyticsStatus');
  const plannedValueEl = document.getElementById('analyticsPlannedValue');
  const completedValueEl = document.getElementById('analyticsCompletedValue');
  const completionRateValueEl = document.getElementById('analyticsCompletionRateValue');
  const deadlinesValueEl = document.getElementById('analyticsDeadlinesValue');
  const atRiskValueEl = document.getElementById('analyticsAtRiskValue');
  const chartEl = document.getElementById('analyticsChart');
  const subjectListEl = document.getElementById('analyticsSubjectList');
  const subjectEmptyEl = document.getElementById('analyticsSubjectEmpty');
  const productivityEl = document.getElementById('analyticsProductivity');
  const productivityEmptyEl = document.getElementById('analyticsProductivityEmpty');
  const upcomingListEl = document.getElementById('analyticsUpcomingList');
  const upcomingEmptyEl = document.getElementById('analyticsUpcomingEmpty');
  const boardsCardEl = document.getElementById('analyticsBoardsCard');
  const boardsSummaryEl = document.getElementById('analyticsBoardsSummary');

  let loading = false;

  function showError(message) {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.hidden = false;
  }
  function hideError() {
    if (statusEl) statusEl.hidden = true;
  }

  function renderCards({ weekly, completionRate, upcomingCount, atRiskCount }) {
    if (plannedValueEl) plannedValueEl.textContent = formatDuration(weekly.totalPlanned);
    if (completedValueEl) completedValueEl.textContent = formatDuration(weekly.totalCompleted);
    if (completionRateValueEl) completionRateValueEl.textContent = completionRate === null ? '—' : `${completionRate}%`;
    if (deadlinesValueEl) deadlinesValueEl.textContent = String(upcomingCount);
    if (atRiskValueEl) atRiskValueEl.textContent = String(atRiskCount);
  }

  function shortDayLabel(dateStr) {
    try {
      return new Date(`${dateStr}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short' });
    } catch {
      return dateStr.slice(5);
    }
  }

  function renderChart(byDay) {
    if (!chartEl) return;
    chartEl.innerHTML = '';
    const maxMinutes = Math.max(1, ...byDay.map((d) => d.planned));
    byDay.forEach((d) => {
      const col = document.createElement('div');
      col.className = 'analytics-chart-col';

      const bars = document.createElement('div');
      bars.className = 'analytics-chart-bars';

      const plannedBar = document.createElement('div');
      plannedBar.className = 'analytics-chart-bar analytics-chart-bar-planned';
      plannedBar.style.height = `${Math.round((d.planned / maxMinutes) * 100)}%`;
      plannedBar.title = `${t('analytics.planned')}: ${formatDuration(d.planned)}`;

      const completedBar = document.createElement('div');
      completedBar.className = 'analytics-chart-bar analytics-chart-bar-completed';
      completedBar.style.height = `${Math.round((d.completed / maxMinutes) * 100)}%`;
      completedBar.title = `${t('analytics.completed')}: ${formatDuration(d.completed)}`;

      bars.appendChild(plannedBar);
      bars.appendChild(completedBar);

      const label = document.createElement('span');
      label.className = 'analytics-chart-label';
      label.textContent = shortDayLabel(d.date);

      col.appendChild(bars);
      col.appendChild(label);
      chartEl.appendChild(col);
    });
  }

  function renderSubjects(subjectTotals) {
    if (!subjectListEl) return;
    subjectListEl.querySelectorAll('.analytics-subject-row').forEach((el) => el.remove());
    if (subjectEmptyEl) subjectEmptyEl.hidden = subjectTotals.length > 0;
    subjectTotals.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'analytics-subject-row';

      const name = document.createElement('span');
      name.className = 'analytics-subject-name';
      name.textContent = s.subject; // user-created content — never translated

      const values = document.createElement('span');
      values.className = 'analytics-subject-values';
      values.textContent = `${t('analytics.planned')}: ${formatDuration(s.planned)}  ·  ${t('analytics.completed')}: ${formatDuration(s.completed)}`;

      row.appendChild(name);
      row.appendChild(values);
      subjectListEl.appendChild(row);
    });
  }

  function renderProductivity(result) {
    if (!productivityEl) return;
    productivityEl.querySelectorAll('.analytics-productivity-result').forEach((el) => el.remove());
    if (productivityEmptyEl) productivityEmptyEl.hidden = !result.insufficientData;
    if (result.insufficientData || !result.period) return;

    const strong = document.createElement('p');
    strong.className = 'analytics-productivity-result';
    const labelKey = PERIOD_LABEL_KEYS[result.period];
    strong.dataset.i18n = labelKey;
    strong.textContent = t(labelKey);
    productivityEl.appendChild(strong);
  }

  function renderUpcoming(list) {
    if (!upcomingListEl) return;
    upcomingListEl.querySelectorAll('.analytics-upcoming-row').forEach((el) => el.remove());
    if (upcomingEmptyEl) upcomingEmptyEl.hidden = list.length > 0;

    list.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'analytics-upcoming-row';
      row.tabIndex = 0;
      row.setAttribute('role', 'button');

      const main = document.createElement('div');
      main.className = 'analytics-upcoming-main';

      const title = document.createElement('span');
      title.className = 'analytics-upcoming-title';
      title.textContent = item.title; // user-created content — never translated

      const meta = document.createElement('span');
      meta.className = 'analytics-upcoming-meta';
      meta.textContent = `${item.dueDate} · ${formatDuration(item.remainingMinutes)}`;

      main.appendChild(title);
      main.appendChild(meta);

      const riskBadge = document.createElement('span');
      const riskKey = RISK_LABEL_KEYS[item.risk] || RISK_LABEL_KEYS.on_track;
      riskBadge.className = `analytics-risk-badge risk-${item.risk}`;
      riskBadge.dataset.i18n = riskKey;
      riskBadge.textContent = t(riskKey);

      row.appendChild(main);
      row.appendChild(riskBadge);

      if (item.risk === 'at_risk' && typeof hostApi.openAdvisorWithMessage === 'function') {
        const askBtn = document.createElement('button');
        askBtn.type = 'button';
        askBtn.className = 'board-node-link-btn';
        askBtn.dataset.i18n = 'analytics.askAiAdvisor';
        askBtn.textContent = t('analytics.askAiAdvisor');
        askBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const prompt = buildAdvisorPromptForTask(item, {
            help: t('analytics.advisorPromptHelp'),
            due: t('analytics.advisorPromptDue'),
            riskNote: t('analytics.advisorPromptRisk'),
          });
          hostApi.openAdvisorWithMessage(prompt);
        });
        row.appendChild(askBtn);
      }

      function goToPlanner() {
        if (typeof hostApi.viewInPlanner === 'function') hostApi.viewInPlanner();
      }
      row.addEventListener('click', goToPlanner);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          goToPlanner();
        }
      });

      upcomingListEl.appendChild(row);
    });
  }

  function renderBoardsSummary(summary) {
    if (!boardsCardEl) return;
    if (summary.count === 0) {
      boardsCardEl.hidden = true;
      return;
    }
    boardsCardEl.hidden = false;
    const parts = [`${summary.count} ${t('analytics.activeBoards')}`];
    if (summary.mostRecentTitle) parts.push(`${t('analytics.mostRecentBoard')}: ${summary.mostRecentTitle}`);
    if (boardsSummaryEl) boardsSummaryEl.textContent = parts.join(' · ');
  }

  async function loadAndRender() {
    if (loading) return;
    loading = true;
    hideError();
    try {
      const today = typeof hostApi.getTodayDateStr === 'function' ? hostApi.getTodayDateStr() : new Date().toISOString().slice(0, 10);
      const dates = lastNDates(today, 7);
      const startDate = dates[0];
      const endDate = dates[dates.length - 1];

      const [weekData, upcomingSubjects, boards] = await Promise.all([
        typeof hostApi.getWeekData === 'function' ? hostApi.getWeekData(startDate, endDate) : { schedules: [], items: [], subjects: [] },
        typeof hostApi.getUpcomingDeadlines === 'function' ? hostApi.getUpcomingDeadlines(today) : [],
        typeof hostApi.getBoardsSummary === 'function' ? hostApi.getBoardsSummary() : [],
      ]);

      const itemsWithDate = attachDatesToItems(weekData.items, weekData.schedules);
      const weekly = computeWeeklyTotals(itemsWithDate, dates);
      const completionRate = computeCompletionRate(weekly.totalPlanned, weekly.totalCompleted);
      const subjectTotals = computeSubjectTotals(weekData.subjects, itemsWithDate);
      const upcoming = computeUpcomingDeadlines(upcomingSubjects, today, 10);
      const atRiskCount = countByRisk(upcoming, 'at_risk');
      const completedStudyItems = itemsWithDate
        .filter((i) => i.item_type === 'study' && i.completed)
        .map((i) => ({ start: i.start_minutes, end: i.end_minutes }));
      const productivity = computeProductivityPeriod(completedStudyItems);
      const boardsSummary = summarizeBoards(boards);

      renderCards({ weekly, completionRate, upcomingCount: upcoming.length, atRiskCount });
      renderChart(weekly.byDay);
      renderSubjects(subjectTotals);
      renderProductivity(productivity);
      renderUpcoming(upcoming);
      renderBoardsSummary(boardsSummary);
    } catch (err) {
      console.error('Could not load analytics:', err);
      showError(t('analytics.couldNotLoad'));
    } finally {
      loading = false;
    }
  }

  // Refreshed every time the tab is opened (not cached from first open) —
  // this week's completion state changes as the user works elsewhere in
  // the same session.
  function onShow() {
    loadAndRender();
  }

  return { onShow };
}
