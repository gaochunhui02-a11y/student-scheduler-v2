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
// functions. The "Ask AI Advisor" bridge that used to live here was
// removed with the AI Advisor itself (final non-AI product redesign,
// Checkpoint A) — analyticsModel.js's buildAdvisorPromptForTask is kept,
// unimported, alongside the rest of the optional/future AI code.

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
  computeTodayBlockStatus,
} from './analyticsModel.js';
import { formatDuration } from '../dashboard/summary.js';
import { formatClock } from '../dashboard/scheduler.js';

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
  const greetingEl = document.getElementById('homeGreeting');
  const dateLineEl = document.getElementById('homeDateLine');
  const plannedSecondaryEl = document.getElementById('homePlannedSecondary');
  const completedSecondaryEl = document.getElementById('homeCompletedSecondary');
  const atRiskSecondaryEl = document.getElementById('homeAtRiskSecondary');
  const todayBodyEl = document.getElementById('homeTodayBody');

  let loading = false;

  function showError(message) {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.hidden = false;
  }
  function hideError() {
    if (statusEl) statusEl.hidden = true;
  }

  // Greeting + date line are rendered here (not just once on load) so a
  // language switch re-translates them like everything else — dashboard.js
  // calls onShow() again after applyTranslations() runs for exactly this
  // reason (see the langSelect change handler).
  function renderGreeting() {
    if (!greetingEl) return;
    const name = typeof hostApi.getDisplayName === 'function' ? hostApi.getDisplayName() : '';
    const hour = new Date().getHours();
    const key = hour < 12 ? 'home.greetingMorning' : hour < 18 ? 'home.greetingAfternoon' : 'home.greetingEvening';
    greetingEl.textContent = t(key).replace('{name}', name || '');
    if (dateLineEl) {
      try {
        dateLineEl.textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
      } catch {
        dateLineEl.textContent = '';
      }
    }
  }

  function renderCards({ todayTotals, todayStudyCounts, weekly, completionRate, upcomingCount, atRiskCount }) {
    if (plannedValueEl) plannedValueEl.textContent = formatDuration(todayTotals.totalPlanned);
    if (completedValueEl) completedValueEl.textContent = formatDuration(todayTotals.totalCompleted);
    if (completionRateValueEl) completionRateValueEl.textContent = completionRate === null ? '—' : `${completionRate}%`;
    if (deadlinesValueEl) deadlinesValueEl.textContent = String(upcomingCount);
    if (atRiskValueEl) atRiskValueEl.textContent = String(atRiskCount);

    if (plannedSecondaryEl) plannedSecondaryEl.textContent = `${todayStudyCounts.planned} ${t('home.sessionsPlannedLabel')}`;
    if (completedSecondaryEl) completedSecondaryEl.textContent = `${todayStudyCounts.completed} ${t('home.sessionsCompletedLabel')}`;
    if (atRiskSecondaryEl) atRiskSecondaryEl.hidden = atRiskCount <= 0;
  }

  // "Today" card: whichever of today's already-generated schedule_items is
  // happening right now, or the next one coming up, plus how much planned
  // study time is still ahead — all from computeTodayBlockStatus
  // (analyticsModel.js), never a second scheduler. Empty state (nothing
  // generated for today yet) offers the exact same Open Planner bridge
  // every other cross-view action here already uses.
  function goToPlanner() {
    if (typeof hostApi.viewInPlanner === 'function') hostApi.viewInPlanner();
  }

  function appendOpenPlannerButton(container) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-secondary home-today-open-btn';
    btn.dataset.i18n = 'home.openPlanner';
    btn.textContent = t('home.openPlanner');
    btn.addEventListener('click', goToPlanner);
    container.appendChild(btn);
  }

  function renderToday(status) {
    if (!todayBodyEl) return;
    todayBodyEl.innerHTML = '';
    const block = status.current || status.next;

    if (!block) {
      const empty = document.createElement('div');
      empty.className = 'home-today-empty';
      const title = document.createElement('p');
      title.className = 'home-empty-title';
      title.dataset.i18n = 'home.todayEmptyTitle';
      title.textContent = t('home.todayEmptyTitle');
      const body = document.createElement('p');
      body.className = 'hint';
      body.dataset.i18n = 'home.todayEmptyBody';
      body.textContent = t('home.todayEmptyBody');
      empty.appendChild(title);
      empty.appendChild(body);
      todayBodyEl.appendChild(empty);
      appendOpenPlannerButton(todayBodyEl);
      return;
    }

    const badge = document.createElement('span');
    const badgeKey = status.current ? 'home.nowLabel' : 'home.nextLabel';
    badge.className = `home-today-badge${status.current ? ' home-today-badge-now' : ''}`;
    badge.dataset.i18n = badgeKey;
    badge.textContent = t(badgeKey);

    const name = document.createElement('div');
    name.className = 'home-today-name';
    name.textContent = block.name; // user-created content — never translated

    const meta = document.createElement('div');
    meta.className = 'home-today-meta';
    meta.textContent = `${formatClock(block.start_minutes)} – ${formatClock(block.end_minutes)}`;

    todayBodyEl.appendChild(badge);
    todayBodyEl.appendChild(name);
    todayBodyEl.appendChild(meta);

    if (status.remainingPlannedMinutes > 0) {
      const remaining = document.createElement('div');
      remaining.className = 'home-today-remaining';
      remaining.textContent = `${formatDuration(status.remainingPlannedMinutes)} ${t('home.remainingTodayLabel')}`;
      todayBodyEl.appendChild(remaining);
    }

    appendOpenPlannerButton(todayBodyEl);
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
      // Missed (Phase 14) is shown only when there's actually something to
      // report — most subjects have nothing missed, and the row shouldn't
      // grow a permanent "Missed: 0m" for every subject that never needed it.
      const missedPart = s.missed > 0 ? `  ·  ${t('analytics.missed')}: ${formatDuration(s.missed)}` : '';
      values.textContent = `${t('analytics.planned')}: ${formatDuration(s.planned)}  ·  ${t('analytics.completed')}: ${formatDuration(s.completed)}${missedPart}`;

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
    renderGreeting();
    try {
      const today = typeof hostApi.getTodayDateStr === 'function' ? hostApi.getTodayDateStr() : new Date().toISOString().slice(0, 10);
      const dates = lastNDates(today, 7);
      const startDate = dates[0];
      const endDate = dates[dates.length - 1];

      const [weekData, upcomingSubjects, boards, todaySchedule] = await Promise.all([
        typeof hostApi.getWeekData === 'function' ? hostApi.getWeekData(startDate, endDate) : { schedules: [], items: [], subjects: [] },
        typeof hostApi.getUpcomingDeadlines === 'function' ? hostApi.getUpcomingDeadlines(today) : [],
        typeof hostApi.getBoardsSummary === 'function' ? hostApi.getBoardsSummary() : [],
        typeof hostApi.getTodaySchedule === 'function' ? hostApi.getTodaySchedule() : null,
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

      // Today's own stat-card numbers (Study Planned/Completed) are
      // deliberately distinct from the weekly chart below them — reuses
      // the exact same computeWeeklyTotals a single "week" of one day is a
      // valid input for, rather than a second planned/completed calculator.
      const todayItems = todaySchedule ? todaySchedule.items || [] : [];
      const todayTotals = computeWeeklyTotals(
        todayItems.map((i) => ({ ...i, date: today })),
        [today]
      );
      const todayStudyItems = todayItems.filter((i) => i.item_type === 'study');
      const todayStudyCounts = { planned: todayStudyItems.length, completed: todayStudyItems.filter((i) => i.completed).length };
      const now = new Date();
      const todayStatus = computeTodayBlockStatus(todayItems, now.getHours() * 60 + now.getMinutes());

      renderCards({ todayTotals, todayStudyCounts, weekly, completionRate, upcomingCount: upcoming.length, atRiskCount });
      renderToday(todayStatus);
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
