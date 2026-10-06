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

import { t, tCount, getLocale } from '../shared/i18n.js';
import {
  lastNDates,
  attachDatesToItems,
  computeWeeklyTotals,
  computeCompletionRate,
  computeSubjectTotals,
  computeActualVsPlanned,
  computeUpcomingDeadlines,
  countByRisk,
  computeProductivityPeriod,
  summarizeBoards,
  computeTodayBlockStatus,
  computeAverageBlockLength,
  computeEstimateAccuracy,
  computeOverdueWorkload,
  computeSubjectWorkloadBars,
} from './analyticsModel.js';
import { getWeekStart, getWeekDates, aggregateWeekView, isOverloadedDay, OVERLOAD_THRESHOLD_MINUTES } from '../week/weekModel.js';
import { addDaysToDateStr } from '../dashboard/dateUtils.js';
import { displayBlockName } from '../shared/blockLabels.js';
import { deriveBlockStatus, countBlockStatuses, statusBadgeHtml, statusBadgeEl, statusLabelKey, SUMMARY_ORDER } from '../shared/statusModel.js';
import { formatDuration } from '../dashboard/summary.js';
import { formatClock } from '../dashboard/scheduler.js';
import { buildSmartTasks, computeAvailableStudyMinutes, rankTasks, buildReasonTags, buildExplanation, buildReasonFacts } from '../dashboard/smartPriority.js';

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
  const actualBodyEl = document.getElementById('analyticsActualBody');
  const actualEmptyEl = document.getElementById('analyticsActualEmpty');
  const productivityEl = document.getElementById('analyticsProductivity');
  const productivityEmptyEl = document.getElementById('analyticsProductivityEmpty');
  const upcomingListEl = document.getElementById('analyticsUpcomingList');
  const upcomingEmptyEl = document.getElementById('analyticsUpcomingEmpty');
  const boardsCardEl = document.getElementById('analyticsBoardsCard');
  const boardsSummaryEl = document.getElementById('analyticsBoardsSummary');
  const greetingEl = document.getElementById('homeGreeting');
  const dateLineEl = document.getElementById('homeDateLine');
  const recommendBodyEl = document.getElementById('homeRecommendBody');
  const insightsStripEl = document.getElementById('homeInsightsStrip');
  const plannedSecondaryEl = document.getElementById('homePlannedSecondary');
  const completedSecondaryEl = document.getElementById('homeCompletedSecondary');
  const atRiskSecondaryEl = document.getElementById('homeAtRiskSecondary');
  const todayBodyEl = document.getElementById('homeTodayBody');
  const weeklyBodyEl = document.getElementById('homeWeeklyBody');
  const workloadEl = document.getElementById('homeWorkload');
  const openInsightsBtn = document.getElementById('homeOpenInsightsBtn');
  const insightsMetricsEl = document.getElementById('insightsMetrics');
  const overdueBodyEl = document.getElementById('insightsOverdueBody');

  if (openInsightsBtn) {
    openInsightsBtn.addEventListener('click', () => {
      if (typeof hostApi.openInsights === 'function') hostApi.openInsights();
    });
  }

  let loading = false;
  let pendingOpts = null; // a request that arrived mid-load runs right after

  const insightsStatusEl = document.getElementById('insightsStatus');
  function showError(message) {
    [statusEl, insightsStatusEl].forEach((node) => {
      if (!node) return;
      node.textContent = message;
      node.hidden = false;
    });
  }
  function hideError() {
    [statusEl, insightsStatusEl].forEach((node) => {
      if (node) node.hidden = true;
    });
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
        dateLineEl.textContent = new Date().toLocaleDateString(getLocale(), { weekday: 'long', month: 'long', day: 'numeric' });
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

    if (plannedSecondaryEl) plannedSecondaryEl.textContent = `${todayStudyCounts.planned} ${tCount('home.sessionsPlannedLabel', todayStudyCounts.planned)}`;
    if (completedSecondaryEl) completedSecondaryEl.textContent = `${todayStudyCounts.completed} ${tCount('home.sessionsCompletedLabel', todayStudyCounts.completed)}`;
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

  // `primary` is used for the empty state's stronger call-to-action (it's
  // the only thing to do); once a real current/next block is shown, Open
  // Planner is a secondary, lower-emphasis action next to that block.
  function appendOpenPlannerButton(container, primary) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = primary ? 'btn-primary home-today-open-btn' : 'btn-secondary home-today-open-btn';
    btn.textContent = primary ? `${t('home.openPlanner')} →` : t('home.openPlanner');
    btn.addEventListener('click', goToPlanner);
    container.appendChild(btn);
  }

  function renderToday(status, todayItems = [], nowMinutes = null) {
    if (!todayBodyEl) return;
    todayBodyEl.innerHTML = '';
    const block = status.current || status.next;

    if (!block) {
      const empty = document.createElement('div');
      empty.className = 'home-empty-state';
      const glyph = document.createElement('span');
      glyph.className = 'home-empty-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = '◇';
      const title = document.createElement('p');
      title.className = 'home-empty-title';
      title.dataset.i18n = 'home.todayEmptyTitle';
      title.textContent = t('home.todayEmptyTitle');
      const body = document.createElement('p');
      body.className = 'hint';
      body.dataset.i18n = 'home.todayEmptyBody';
      body.textContent = t('home.todayEmptyBody');
      empty.appendChild(glyph);
      empty.appendChild(title);
      empty.appendChild(body);
      todayBodyEl.appendChild(empty);
      appendOpenPlannerButton(todayBodyEl, true);
      return;
    }

    // V2-G: a study block happening now shows the shared "In Progress"
    // status badge; classes/meals keep the plain NOW label, and an upcoming
    // block keeps NEXT (that's a time, not a status).
    const blockStatus = status.current ? deriveBlockStatus(block, { isToday: true, nowMinutes }) : null;
    let badge;
    if (blockStatus) {
      badge = statusBadgeEl(blockStatus, t(statusLabelKey(blockStatus)));
    } else {
      badge = document.createElement('span');
      const badgeKey = status.current ? 'home.nowLabel' : 'home.nextLabel';
      badge.className = `home-today-badge${status.current ? ' home-today-badge-now' : ''}`;
      badge.dataset.i18n = badgeKey;
      badge.textContent = t(badgeKey);
    }

    const name = document.createElement('div');
    name.className = 'home-today-name';
    name.textContent = displayBlockName(block, t); // user-created names untouched; generated Break/Free/meal labels translated

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

    const summary = renderStatusSummary(countBlockStatuses(todayItems, { isToday: true, nowMinutes }));
    if (summary) todayBodyEl.appendChild(summary);

    appendOpenPlannerButton(todayBodyEl, false);
  }

  // A row of "2 Done · 1 Partial · 1 Missed" badges; null when there's
  // nothing beyond plain Planned to report.
  function renderStatusSummary(counts) {
    const keys = SUMMARY_ORDER.filter((k) => counts[k] > 0);
    if (keys.length === 0) return null;
    const row = document.createElement('div');
    row.className = 'status-summary';
    row.innerHTML = keys.map((k) => statusBadgeHtml(k, t(statusLabelKey(k)), { count: counts[k], compact: true })).join('');
    return row;
  }

  // ---------------- Smart Suggestions: Recommended Next (Checkpoint E) ----------------
  // Fully deterministic — src/dashboard/smartPriority.js does the actual
  // scoring/reasoning from today's real study_subjects + schedule_items;
  // this only ever translates its plain output and renders it. No AI.

  function buildReasonLabels() {
    return {
      tag: {
        overdue: t('smart.tagOverdue'),
        today: t('smart.tagDueToday'),
        tomorrow: t('smart.tagDueTomorrow'),
        soon: t('smart.tagDueSoon'),
        highPriority: t('smart.tagHighPriority'),
        missed: t('smart.tagMissed'),
        carriedOver: t('smart.tagCarryOver'),
        fits: t('smart.tagFitsToday'),
      },
      clause: {
        overdue: t('smart.clauseOverdue'),
        today: t('smart.clauseDueToday'),
        tomorrow: t('smart.clauseDueTomorrow'),
        soon: t('smart.clauseDueSoon'),
        highPriority: t('smart.clauseHighPriority'),
        missed: t('smart.clauseMissed'),
        carriedOver: t('smart.clauseCarriedOver'),
        fits: t('smart.clauseFits'),
        inProgress: t('smart.clauseInProgress'),
        unfinished: t('smart.clauseUnfinished'),
      },
      explanationOne: t('smart.explanationOne'),
      explanationTwo: t('smart.explanationTwo'),
    };
  }

  function planTask(taskId) {
    if (typeof hostApi.planTask === 'function') hostApi.planTask(taskId);
  }

  // `ranked`: rankTasks()'s own output (`{ task, score, ... }[]`), already
  // capped to at most 3 by the caller. `hasAnyUnfinishedInput` distinguishes
  // "you've added nothing yet" from "you've finished everything" (section 7
  // of the brief) — two different empty states, never the same placeholder.
  function renderRecommendations(ranked, hasAnyTasksToday, factContext = {}) {
    if (!recommendBodyEl) return;
    recommendBodyEl.innerHTML = '';

    if (ranked.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'home-empty-state';
      const glyph = document.createElement('span');
      glyph.className = 'home-empty-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = hasAnyTasksToday ? '✓' : '◇';
      const titleKey = hasAnyTasksToday ? 'home.caughtUpTitle' : 'home.recommendedEmptyTitle';
      const bodyKey = hasAnyTasksToday ? 'home.caughtUpBody' : 'home.recommendedPlaceholder';
      const title = document.createElement('p');
      title.className = 'home-empty-title';
      title.dataset.i18n = titleKey;
      title.textContent = t(titleKey);
      const body = document.createElement('p');
      body.className = 'hint';
      body.dataset.i18n = bodyKey;
      body.textContent = t(bodyKey);
      empty.appendChild(glyph);
      empty.appendChild(title);
      empty.appendChild(body);
      recommendBodyEl.appendChild(empty);
      return;
    }

    const labels = buildReasonLabels();
    ranked.forEach((r, index) => {
      const isPrimary = index === 0;
      const item = document.createElement('div');
      item.className = `home-recommend-item${isPrimary ? ' home-recommend-item-primary' : ''}`;

      const nameEl = document.createElement('div');
      nameEl.className = 'home-recommend-name';
      nameEl.textContent = r.task.name; // user-created content — never translated

      const chips = document.createElement('div');
      chips.className = 'home-recommend-chips';
      buildReasonTags(r.task, r, labels, isPrimary ? 3 : 2).forEach((tagText) => {
        const chip = document.createElement('span');
        chip.className = 'reason-chip';
        chip.textContent = tagText;
        chips.appendChild(chip);
      });
      const minutesChip = document.createElement('span');
      minutesChip.className = 'reason-chip reason-chip-minutes';
      minutesChip.textContent = `${formatDuration(r.task.remainingMinutes)} ${t('home.remainingSuffix')}`;
      chips.appendChild(minutesChip);

      // V2-E: the top pick explains itself with concrete facts ("Due in 2
      // days · 120 min remaining · Tomorrow is heavily scheduled"); the
      // others keep the compact chips + one-line explanation.
      const facts = isPrimary ? buildReasonFacts(r.task, r, factContext, 4) : [];
      const explanation = facts.length > 0 ? buildWhyList(facts) : document.createElement('p');
      if (facts.length === 0) {
        explanation.className = 'hint home-recommend-explanation';
        explanation.textContent = buildExplanation(r.task, r, labels);
      }

      const planBtn = document.createElement('button');
      planBtn.type = 'button';
      planBtn.className = isPrimary ? 'btn-primary home-recommend-plan-btn' : 'btn-secondary home-recommend-plan-btn';
      planBtn.textContent = t('home.planIt');
      planBtn.addEventListener('click', () => planTask(r.task.id));

      item.appendChild(nameEl);
      if (facts.length === 0) item.appendChild(chips);
      item.appendChild(explanation);
      item.appendChild(planBtn);
      recommendBodyEl.appendChild(item);
    });
  }

  // A short strip of plain facts — never a percentage/trend that isn't
  // directly backed by a real sum already computed above. Each line is
  // omitted entirely when its value is 0, rather than showing a "0" fact.
  function renderInsights({ dueWithin3Count, missedMinutes, unfinishedMinutes }) {
    if (!insightsStripEl) return;
    insightsStripEl.innerHTML = '';
    const facts = [];
    if (dueWithin3Count > 0) facts.push(t('home.insightDueSoon').replace('{count}', String(dueWithin3Count)));
    if (missedMinutes > 0) facts.push(t('home.insightMissed').replace('{duration}', formatDuration(missedMinutes)));
    if (unfinishedMinutes > 0) facts.push(t('home.insightUnfinished').replace('{duration}', formatDuration(unfinishedMinutes)));

    if (facts.length === 0) {
      insightsStripEl.hidden = true;
      return;
    }
    facts.forEach((fact) => {
      const span = document.createElement('span');
      span.className = 'home-insight-fact';
      span.textContent = fact;
      insightsStripEl.appendChild(span);
    });
    insightsStripEl.hidden = false;
  }

  function shortDayLabel(dateStr) {
    try {
      return new Date(`${dateStr}T00:00:00`).toLocaleDateString(getLocale(), { weekday: 'short' });
    } catch {
      return dateStr.slice(5);
    }
  }

  // A bar's real proportion, but any genuinely non-zero value is floored to
  // a small minimum visible height — otherwise a day with a little real
  // activity next to a day with a lot of it would round down to a sliver
  // indistinguishable from an empty day, which reads as a rendering bug
  // rather than "small but real." A true zero still renders as truly flat.
  function barHeightPercent(minutes, maxMinutes) {
    if (minutes <= 0) return 0;
    return Math.max(6, Math.round((minutes / maxMinutes) * 100));
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
      plannedBar.style.height = `${barHeightPercent(d.planned, maxMinutes)}%`;
      plannedBar.title = `${t('analytics.planned')}: ${formatDuration(d.planned)}`;

      const completedBar = document.createElement('div');
      completedBar.className = 'analytics-chart-bar analytics-chart-bar-completed';
      completedBar.style.height = `${barHeightPercent(d.completed, maxMinutes)}%`;
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

  // Subject workload (V2-E): one bar per subject, planned as the track and
  // completed as the fill, scaled to the biggest subject.
  function renderSubjects(subjectTotals) {
    if (!subjectListEl) return;
    subjectListEl.querySelectorAll('.analytics-subject-row').forEach((node) => node.remove());
    const rows = computeSubjectWorkloadBars(subjectTotals.filter((s) => s.planned > 0 || s.completed > 0));
    if (subjectEmptyEl) subjectEmptyEl.hidden = rows.length > 0;
    rows.forEach((s) => {
      const row = el('div', 'analytics-subject-row subject-bar-row');
      const head = el('div', 'subject-bar-head');
      head.appendChild(el('span', 'analytics-subject-name', s.subject)); // user-created content — never translated
      // Missed (Phase 14) is shown only when there's actually something to
      // report, not as a permanent "Missed: 0m" on every subject.
      const missedPart = s.missed > 0 ? ` · ${t('analytics.missed')} ${formatDuration(s.missed)}` : '';
      head.appendChild(el('span', 'analytics-subject-values', `${formatDuration(s.completed)} / ${formatDuration(s.planned)}${missedPart}`));
      const track = el('div', 'subject-bar-track');
      track.setAttribute('aria-hidden', 'true');
      const planned = el('span', 'subject-bar-planned');
      planned.style.width = `${s.plannedPercent}%`;
      const done = el('span', 'subject-bar-completed');
      done.style.width = `${s.completedPercent}%`;
      track.appendChild(planned);
      track.appendChild(done);
      row.appendChild(head);
      row.appendChild(track);
      row.setAttribute('aria-label', `${s.subject}: ${t('analytics.completed')} ${formatDuration(s.completed)}, ${t('analytics.planned')} ${formatDuration(s.planned)}`);
      subjectListEl.appendChild(row);
    });
  }

  // V2-C: Estimated / Planned / Actual per subject. Built with DOM nodes
  // (not innerHTML) since subject names are user content. The small delta
  // under Actual only appears once something was actually logged — a
  // subject with zero actual time is "not started", not "-100%".
  function renderActualVsPlanned({ subjects, totals }) {
    if (!actualBodyEl) return;
    actualBodyEl.querySelectorAll('.avp-table').forEach((el) => el.remove());
    if (actualEmptyEl) actualEmptyEl.hidden = subjects.length > 0;
    if (subjects.length === 0) return;

    const table = document.createElement('table');
    table.className = 'avp-table';
    const head = table.createTHead().insertRow();
    ['taskFilter.subjectLabel', 'analytics.estimated', 'analytics.planned', 'analytics.actual'].forEach((key) => {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = t(key);
      head.appendChild(th);
    });

    function addRow(section, label, r) {
      const row = section.insertRow();
      row.insertCell().textContent = label;
      row.insertCell().textContent = formatDuration(r.estimated);
      row.insertCell().textContent = formatDuration(r.planned);
      const actualCell = row.insertCell();
      actualCell.textContent = formatDuration(r.actual);
      if (r.actual > 0 && r.planned > 0 && r.actual !== r.planned) {
        const delta = document.createElement('span');
        const diff = r.actual - r.planned;
        delta.className = `avp-delta${diff < 0 ? ' is-under' : ''}`;
        delta.textContent = `${diff > 0 ? '+' : '−'}${formatDuration(Math.abs(diff))}`;
        actualCell.appendChild(delta);
      }
    }

    const body = table.createTBody();
    subjects.forEach((r) => addRow(body, r.subject, r)); // user-created content — never translated
    if (subjects.length > 1) addRow(table.createTFoot(), t('analytics.total'), totals);
    actualBodyEl.appendChild(table);
  }

  // ---------------- V2-E: Home "Weekly Progress" + "Workload", Insights ----------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function progressBar(percent, extraClass = '') {
    const bar = el('div', `meter${extraClass ? ` ${extraClass}` : ''}`);
    bar.setAttribute('aria-hidden', 'true');
    const fill = el('span');
    fill.style.width = `${Math.max(0, Math.min(100, percent || 0))}%`;
    bar.appendChild(fill);
    return bar;
  }

  // Last 7 days: completion rate as the headline, the minutes behind it,
  // and missed time only when there is some.
  function renderWeeklyProgress(weekly, completionRate) {
    if (!weeklyBodyEl) return;
    weeklyBodyEl.innerHTML = '';
    if (weekly.totalPlanned <= 0) {
      weeklyBodyEl.appendChild(el('p', 'hint', t('home.weeklyEmpty')));
      return;
    }
    const head = el('div', 'home-weekly-head');
    head.appendChild(el('span', 'home-weekly-rate', `${completionRate}%`));
    head.appendChild(el('span', 'home-weekly-label', t('home.weeklyCompletedOfPlanned')
      .replace('{completed}', formatDuration(weekly.totalCompleted))
      .replace('{planned}', formatDuration(weekly.totalPlanned))));
    weeklyBodyEl.appendChild(head);
    weeklyBodyEl.appendChild(progressBar(completionRate));
    const foot = el('p', 'hint home-weekly-foot', t('insights.last7Days'));
    if (weekly.totalMissed > 0) foot.textContent += ` · ${t('analytics.missed')}: ${formatDuration(weekly.totalMissed)}`;
    weeklyBodyEl.appendChild(foot);
  }

  // Mon–Sun planned study per day. The scale is the busier of the week's
  // biggest day and the overload line, so a light week doesn't draw a
  // modest day as a full, alarming bar; the dashed marker is the 4h line.
  function renderWorkload(weekDays, todayStr) {
    if (!workloadEl) return;
    workloadEl.innerHTML = '';
    const busiest = weekDays.reduce((m, d) => Math.max(m, d.studyMinutes), 0);
    const scale = Math.max(busiest, OVERLOAD_THRESHOLD_MINUTES);
    const markerPct = (OVERLOAD_THRESHOLD_MINUTES / scale) * 100;
    weekDays.forEach((day) => {
      const overloaded = isOverloadedDay(day.studyMinutes);
      const row = el('button', `workload-row${overloaded ? ' is-overloaded' : ''}${day.date === todayStr ? ' is-today' : ''}`);
      row.type = 'button';
      const [y, m, d] = day.date.split('-').map(Number);
      const label = new Date(y, m - 1, d).toLocaleDateString(getLocale(), { weekday: 'short' });
      row.appendChild(el('span', 'workload-day', label));
      const track = el('span', 'workload-track');
      track.setAttribute('aria-hidden', 'true');
      const fill = el('span', 'workload-fill');
      fill.style.width = `${(day.studyMinutes / scale) * 100}%`;
      const marker = el('span', 'workload-marker');
      marker.style.left = `${markerPct}%`;
      track.appendChild(fill);
      track.appendChild(marker);
      row.appendChild(track);
      const value = el('span', 'workload-value', day.studyMinutes > 0 ? formatDuration(day.studyMinutes) : '—');
      row.appendChild(value);
      if (overloaded) row.appendChild(el('span', 'workload-flag', t('home.overloaded')));
      const deadlineNote = day.deadlines.length > 0 ? ` · ${day.deadlines.length} ${t('home.deadlinesSuffix')}` : '';
      row.setAttribute('aria-label', `${label}: ${formatDuration(day.studyMinutes)}${overloaded ? ` (${t('home.overloaded')})` : ''}${deadlineNote}`);
      row.addEventListener('click', () => {
        if (typeof hostApi.openDateInPlanner === 'function') hostApi.openDateInPlanner(day.date);
      });
      workloadEl.appendChild(row);
    });
  }

  function whyText(fact) {
    switch (fact.key) {
      case 'overdue': return (fact.value === 1 ? t('why.overdueOne') : t('why.overdueMany')).replace('{n}', fact.value);
      case 'dueToday': return t('why.dueToday');
      case 'dueTomorrow': return t('why.dueTomorrow');
      case 'dueIn': return t('why.dueIn').replace('{n}', fact.value);
      case 'highPriority': return t('why.highPriority');
      case 'missed': return t('why.missed');
      case 'remaining': return t('why.remaining').replace('{time}', formatDuration(fact.value));
      case 'tomorrowHeavy': return t('why.tomorrowHeavy').replace('{time}', formatDuration(fact.value));
      case 'carriedOver': return t('why.carriedOver').replace('{time}', formatDuration(fact.value));
      case 'inProgress': return t('why.inProgress');
      case 'fitsToday': return t('why.fitsToday');
      default: return '';
    }
  }

  function buildWhyList(facts) {
    const wrap = el('div', 'home-why');
    wrap.appendChild(el('span', 'home-why-label', t('home.whyLabel')));
    const ul = el('ul', 'home-why-list');
    facts.forEach((f) => {
      const text = whyText(f);
      if (text) ul.appendChild(el('li', null, text));
    });
    wrap.appendChild(ul);
    return wrap;
  }

  function metricCard(label, value, secondary, muted = false) {
    const card = el('div', `analytics-card insights-metric${muted ? ' is-muted' : ''}`);
    card.appendChild(el('span', 'analytics-card-label', label));
    card.appendChild(el('span', 'analytics-card-value', value));
    if (secondary) card.appendChild(el('span', 'home-stat-secondary', secondary));
    return card;
  }

  function renderInsightMetrics({ weekly, completionRate, avgBlock, accuracy, overdue }) {
    if (!insightsMetricsEl) return;
    insightsMetricsEl.innerHTML = '';
    const notEnough = t('analytics.noDataYet');
    insightsMetricsEl.appendChild(metricCard(
      t('analytics.completionRate'),
      completionRate === null ? '—' : `${completionRate}%`,
      completionRate === null ? notEnough : `${formatDuration(weekly.totalCompleted)} / ${formatDuration(weekly.totalPlanned)} · ${t('insights.last7Days')}`,
      completionRate === null
    ));
    insightsMetricsEl.appendChild(metricCard(
      t('insights.avgBlock'),
      avgBlock.insufficientData ? '—' : formatDuration(avgBlock.averageMinutes),
      avgBlock.insufficientData ? notEnough : tCount('insights.acrossBlocks', avgBlock.blockCount),
      avgBlock.insufficientData
    ));
    insightsMetricsEl.appendChild(metricCard(
      t('insights.estimateAccuracy'),
      accuracy.insufficientData ? '—' : `${accuracy.ratioPercent}%`,
      accuracy.insufficientData ? t('insights.accuracyNeedsData') : tCount('insights.accuracyDetail', accuracy.taskCount),
      accuracy.insufficientData
    ));
    insightsMetricsEl.appendChild(metricCard(
      t('insights.overdueTitle'),
      overdue.count > 0 ? formatDuration(overdue.totalMinutes) : '0',
      overdue.count > 0 ? tCount('insights.overdueTasks', overdue.count) : t('insights.nothingOverdue'),
      overdue.count === 0
    ));
  }

  function renderOverdue(overdue) {
    if (!overdueBodyEl) return;
    overdueBodyEl.innerHTML = '';
    if (overdue.count === 0) {
      overdueBodyEl.appendChild(el('p', 'hint', t('insights.nothingOverdue')));
      return;
    }
    overdue.items.forEach((o) => {
      const row = el('button', 'insights-overdue-row');
      row.type = 'button';
      row.appendChild(el('span', 'insights-overdue-title', o.title)); // user-created content — never translated
      row.appendChild(el('span', 'insights-overdue-meta', `${(o.daysOverdue === 1 ? t('why.overdueOne') : t('why.overdueMany')).replace('{n}', o.daysOverdue)} · ${t('why.remaining').replace('{time}', formatDuration(o.remainingMinutes))}`));
      row.addEventListener('click', () => {
        if (typeof hostApi.viewInPlanner === 'function') hostApi.viewInPlanner();
      });
      overdueBodyEl.appendChild(row);
    });
    if (overdue.count > overdue.items.length) {
      overdueBodyEl.appendChild(el('p', 'hint', t('insights.andMore').replace('{n}', overdue.count - overdue.items.length)));
    }
    overdueBodyEl.appendChild(el('p', 'hint insights-overdue-note', t('insights.overdueWindow')));
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
    const parts = [`${summary.count} ${tCount('analytics.activeBoards', summary.count)}`];
    if (summary.mostRecentTitle) parts.push(`${t('analytics.mostRecentBoard')}: ${summary.mostRecentTitle}`);
    if (boardsSummaryEl) boardsSummaryEl.textContent = parts.join(' · ');
  }

  // `insights` (V2-E): also load the longer-window data only the Insights
  // page uses, so opening Home doesn't pay for it. Both pages share every
  // other number, computed once here.
  async function loadAndRender(opts = {}) {
    if (loading) {
      pendingOpts = { insights: Boolean(opts.insights || pendingOpts?.insights) };
      return;
    }
    loading = true;
    hideError();
    renderGreeting();
    try {
      const today = typeof hostApi.getTodayDateStr === 'function' ? hostApi.getTodayDateStr() : new Date().toISOString().slice(0, 10);
      const dates = lastNDates(today, 7);
      const startDate = dates[0];
      const endDate = dates[dates.length - 1];

      // Home's workload card covers the calendar week (Mon–Sun) and also
      // needs tomorrow (for "Tomorrow is heavily scheduled"), which on a
      // Sunday falls in next week — so the range stretches to include it.
      const weekDates = getWeekDates(getWeekStart(today));
      const tomorrow = addDaysToDateStr(today, 1);
      const rangeEnd = tomorrow > weekDates[6] ? tomorrow : weekDates[6];
      const longStart = addDaysToDateStr(today, -27);
      const emptyWeek = { schedules: [], items: [], subjects: [] };

      const [weekData, upcomingSubjects, boards, todaySchedule, workloadData, longData, dueData] = await Promise.all([
        typeof hostApi.getWeekData === 'function' ? hostApi.getWeekData(startDate, endDate) : emptyWeek,
        typeof hostApi.getUpcomingDeadlines === 'function' ? hostApi.getUpcomingDeadlines(today) : [],
        typeof hostApi.getBoardsSummary === 'function' ? hostApi.getBoardsSummary() : [],
        typeof hostApi.getTodaySchedule === 'function' ? hostApi.getTodaySchedule() : null,
        !opts.insights && typeof hostApi.getWeekRangeData === 'function' ? hostApi.getWeekRangeData(weekDates[0], rangeEnd) : null,
        opts.insights && typeof hostApi.getWeekData === 'function' ? hostApi.getWeekData(longStart, today) : null,
        opts.insights && typeof hostApi.getDueTasksWithBlocks === 'function'
          ? hostApi.getDueTasksWithBlocks(addDaysToDateStr(today, -30), addDaysToDateStr(today, -1))
          : null,
      ]);

      const itemsWithDate = attachDatesToItems(weekData.items, weekData.schedules);
      const weekly = computeWeeklyTotals(itemsWithDate, dates);
      const completionRate = computeCompletionRate(weekly.totalPlanned, weekly.totalCompleted);
      const subjectTotals = computeSubjectTotals(weekData.subjects, itemsWithDate);
      const actualVsPlanned = computeActualVsPlanned(weekData.subjects, itemsWithDate);
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

      // Smart Suggestions (Checkpoint E) — deterministic only, no AI. Built
      // from today's real study_subjects + schedule_items (camelCase, the
      // exact shape smartPriority.js's carryOverModel-backed aggregation
      // expects), never a second/duplicate fetch.
      const todayItemsCamel = todayItems.map((i) => ({
        type: i.item_type,
        start: i.start_minutes,
        end: i.end_minutes,
        completed: i.completed,
        completedMinutes: i.completed_minutes,
        carriedOverMinutes: i.carried_over_minutes,
        missed: i.missed,
        sourceSubjectId: i.source_subject_id,
        name: i.name,
      }));
      const todaySubjects = todaySchedule ? todaySchedule.subjects || [] : [];
      const todaySubjectsCamel = todaySubjects.map((s) => ({
        id: s.id,
        name: s.name,
        priority: s.priority,
        dueDate: s.due_date,
        minutesRequested: s.minutes_requested,
      }));
      const smartTasks = buildSmartTasks(todaySubjectsCamel, todayItemsCamel);
      const availableMinutesToday = computeAvailableStudyMinutes(todayItemsCamel);
      const ranked = rankTasks(smartTasks, { todayDateStr: today, availableMinutesToday }).slice(0, 3);

      // Plain facts only — each sourced from a sum this view already
      // computes elsewhere (upcoming deadlines, this week's planned/
      // completed/missed totals), never a separate calculation or an
      // invented percentage/trend.
      const dueWithin3Count = upcoming.filter((d) => d.daysRemaining >= 0 && d.daysRemaining <= 3 && d.remainingMinutes > 0).length;
      const missedMinutes = weekly.totalMissed;
      const unfinishedMinutes = Math.max(0, weekly.totalPlanned - weekly.totalCompleted);

      // Each page renders only its own cards, so a load for one page never
      // overwrites the other's with less context (e.g. Insights has no
      // week workload, so it must not re-render Home's "Why:" list).
      if (opts.insights) {
        renderChart(weekly.byDay);
        renderSubjects(subjectTotals);
        renderActualVsPlanned(actualVsPlanned);
        renderProductivity(productivity);
        const longItems = longData ? longData.items || [] : [];
        const avgBlock = computeAverageBlockLength(longItems);
        const accuracy = computeEstimateAccuracy(longData ? longData.subjects || [] : [], longItems);
        const overdue = dueData ? computeOverdueWorkload(dueData.subjects, dueData.items, today) : { count: 0, totalMinutes: 0, items: [] };
        renderInsightMetrics({ weekly, completionRate, avgBlock, accuracy, overdue });
        const statusBadgesEl = document.getElementById('insightsStatusBadges');
        if (statusBadgesEl) {
          statusBadgesEl.innerHTML = '';
          const summary = renderStatusSummary(countBlockStatuses(itemsWithDate.filter((i) => i.date !== today)));
          if (summary) statusBadgesEl.appendChild(summary);
          else statusBadgesEl.textContent = t('analytics.noDataYet');
        }
        renderOverdue(overdue);
        return;
      }

      renderCards({ todayTotals, todayStudyCounts, weekly, completionRate, upcomingCount: upcoming.length, atRiskCount });
      renderToday(todayStatus, todayItems, now.getHours() * 60 + now.getMinutes());
      let tomorrowStudyMinutes = null;
      if (workloadData) {
        const weekDays = aggregateWeekView({ weekDates, ...workloadData });
        renderWorkload(weekDays, today);
        const [tomorrowDay] = aggregateWeekView({ weekDates: [tomorrow], ...workloadData });
        tomorrowStudyMinutes = tomorrowDay ? tomorrowDay.studyMinutes : null;
      }
      renderWeeklyProgress(weekly, completionRate);
      renderRecommendations(ranked, smartTasks.length > 0, { todayDateStr: today, tomorrowStudyMinutes, heavyDayMinutes: OVERLOAD_THRESHOLD_MINUTES });
      renderInsights({ dueWithin3Count, missedMinutes, unfinishedMinutes });
      // Home is an overview: the 5 soonest. The count card above still
      // reports the full number.
      renderUpcoming(upcoming.slice(0, 5));
      renderBoardsSummary(boardsSummary);
    } catch (err) {
      console.error('Could not load analytics:', err);
      showError(t('analytics.couldNotLoad'));
    } finally {
      loading = false;
      if (pendingOpts) {
        const next = pendingOpts;
        pendingOpts = null;
        loadAndRender(next);
      }
    }
  }

  // Refreshed every time the tab is opened (not cached from first open) —
  // this week's completion state changes as the user works elsewhere in
  // the same session.
  function onShow() {
    loadAndRender();
  }

  function onShowInsights() {
    loadAndRender({ insights: true });
  }

  return { onShow, onShowInsights };
}
