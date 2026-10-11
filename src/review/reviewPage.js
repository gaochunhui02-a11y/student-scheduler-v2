// Weekly review (V4-F, #/review, #/review/<monday>): a calm look back at one
// week and a look ahead — planned vs actual study (per day and per course /
// project), focus time, what got done, what slipped (with Catch up),
// milestones, goal check-ins and routines — then three short reflection
// questions saved for that week. Read-only except the reflection.

import { t, tCount } from '../shared/i18n.js';
import { has } from '../shared/capabilities.js';
import { todayStr, addDays, isValidDateStr } from '../shared/dates.js';
import { app, onChange } from '../app/context.js';
import { html, raw, setHtml, on, safeColor } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { pageHead, emptyState, button, badge, progressBar, skeletonRows, errorNotice, segmented, wireSegmented } from '../ui/components.js';
import { fmtDate, fmtWeekday, fmtMinutes, fmtDateWithYear } from '../ui/format.js';
import { toast } from '../ui/toast.js';
import { completionRate } from '../routines/routineModel.js';
import { formatValue } from '../goals/goalModel.js';
import { loadReviewData, saveReview } from './reviewData.js';
import { weekBounds, plannedVsActual, plannedVsActualBy, weekTasks, weekMilestones, weekGoalCheckIns, REVIEW_FIELDS, REVIEW_LIMIT } from './reviewModel.js';

const AREA_KEY = 'student-scheduler-review-area';
const pct = (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);

function fill(key, params) {
  let text = t(key);
  Object.entries(params || {}).forEach(([k, v]) => { text = text.split(`{${k}}`).join(String(v)); });
  return text;
}

export function initReviewPage() {
  const root = document.getElementById('reviewView');
  if (!root) return null;
  let token = 0;
  let last = null;
  let week = weekBounds(todayStr()).start;
  let area = (() => { try { return localStorage.getItem(AREA_KEY) === 'project' ? 'project' : 'course'; } catch { return 'course'; } })();

  function head(start) {
    const end = addDays(start, 6);
    const current = weekBounds(todayStr()).start;
    return pageHead({
      eyebrow: t('nav.sectionReview'),
      title: t('review.title'),
      subtitle: `${fmtDate(start)} – ${fmtDateWithYear(end)}${start === current ? ` · ${t('review.thisWeek')}` : ''}`,
      actions: html`<div class="review-nav" role="group" aria-label="${t('review.weekNav')}">
        ${button(t('review.prevWeek'), { action: 'week-prev', iconName: 'chevronLeft', size: 'sm' })}
        ${start !== current ? button(t('review.thisWeek'), { action: 'week-now', size: 'sm' }) : ''}
        ${start < current ? button(t('review.nextWeek'), { action: 'week-next', iconName: 'chevronRight', size: 'sm' }) : ''}
      </div>`,
    });
  }

  async function render(param = null) {
    if (param && isValidDateStr(param)) week = weekBounds(param).start;
    const my = ++token;
    if (!last || last.start !== week) setHtml(root, [head(week), skeletonRows(4, 90)]);
    let d;
    try {
      d = await loadReviewData(week);
    } catch (err) {
      console.error('Could not load the weekly review', err);
      if (my === token) setHtml(root, [head(week), errorNotice('', { retryAction: 'review-retry' })]);
      return;
    }
    if (my !== token) return;
    last = d;
    paint(d);
  }

  function paint(d) {
    const pva = plannedVsActual({ schedules: d.range.schedules, items: d.range.items, sessions: d.sessions, from: d.start, to: d.end });
    const tasks = weekTasks(d.groups, d.start, d.end, d.today);
    const milestones = [...weekMilestones(d.projMs, d.start, d.end).map((m) => ({ ...m, kind: 'project' })), ...weekMilestones(d.goalMs, d.start, d.end).map((m) => ({ ...m, kind: 'goal' }))];
    const checkIns = weekGoalCheckIns(d.goals, d.logs, d.start, d.end);
    const achieved = d.goals.filter((g) => g.status === 'achieved' && g.achieved_at && todayStrOf(g.achieved_at) >= d.start && todayStrOf(g.achieved_at) <= d.end);
    const lastDay = d.end < d.today ? d.end : d.today;
    const dayCount = Math.max(1, Math.round((Date.parse(`${lastDay}T00:00:00Z`) - Date.parse(`${d.start}T00:00:00Z`)) / 86400000) + 1);
    const routineRows = d.routines.filter((r) => !r.archived && r.start_date <= lastDay).map((r) => ({ r, rate: completionRate(r, d.completions, lastDay, dayCount) })).filter((x) => x.rate.due > 0);
    const routineDone = routineRows.reduce((s, x) => s + x.rate.done, 0);
    const routineDue = routineRows.reduce((s, x) => s + x.rate.due, 0);
    const courseById = new Map(d.courses.map((c) => [c.id, c]));
    const projectById = new Map(d.projects.map((p) => [p.id, p]));
    const review = d.reviews[d.start] || {};
    const nothing = !pva.planned && !pva.focus && !tasks.completed.length && !tasks.slipped.length && !routineDue;

    const tiles = html`<div class="review-tiles">
      <div class="review-tile"><span class="review-tile-label">${t('review.tilePlanned')}</span><strong class="tabular">${fmtMinutes(pva.done)} <small>/ ${fmtMinutes(pva.planned)}</small></strong><span class="muted small">${pva.rate === null ? t('review.noPlan') : fill('review.followThrough', { pct: pct(pva.rate) })}</span></div>
      <div class="review-tile"><span class="review-tile-label">${t('review.tileFocus')}</span><strong class="tabular">${fmtMinutes(pva.focus)}</strong><span class="muted small">${tCount('review.sessions', d.sessions.filter((s) => { const x = todayStrOf(s.started_at); return x >= d.start && x <= d.end; }).length)}</span></div>
      <div class="review-tile"><span class="review-tile-label">${t('review.tileDone')}</span><strong class="tabular">${tasks.completed.length}</strong><span class="muted small">${tasks.slipped.length ? tCount('review.slippedCount', tasks.slipped.length) : t('review.nothingSlipped')}</span></div>
      ${has('routines') ? html`<div class="review-tile"><span class="review-tile-label">${t('review.tileRoutines')}</span><strong class="tabular">${routineDue ? pct(routineDone / routineDue) : '—'}</strong><span class="muted small">${routineDue ? fill('review.routinesOf', { done: routineDone, due: routineDue }) : t('review.noRoutines')}</span></div>` : ''}
    </div>`;

    // Per-day bars (planned outline, done fill) with a text equivalent.
    const max = Math.max(60, ...pva.days.map((x) => Math.max(x.planned, x.done, x.focus)));
    const chart = html`<section class="card review-chart" aria-labelledby="reviewChartHead">
      <div class="card-head"><div><h2 class="card-title" id="reviewChartHead">${t('review.chartTitle')}</h2><p class="card-subtitle">${t('review.chartSub')}</p></div>
        <span class="review-legend" aria-hidden="true"><span class="lg lg-planned"></span>${t('review.legendPlanned')}<span class="lg lg-done"></span>${t('review.legendDone')}<span class="lg lg-focus"></span>${t('review.legendFocus')}</span></div>
      <div class="review-bars" role="list">${pva.days.map((x) => html`<div class="review-bar-col${x.date === d.today ? ' is-today' : ''}${x.date > d.today ? ' is-future' : ''}" role="listitem" aria-label="${fill('review.dayLabel', { day: fmtWeekday(x.date, 'long'), done: fmtMinutes(x.done), planned: fmtMinutes(x.planned), focus: fmtMinutes(x.focus) })}">
          <div class="review-bar-track" aria-hidden="true">
            <span class="review-bar planned" style="height:${Math.round((x.planned / max) * 100)}%"></span>
            <span class="review-bar done" style="height:${Math.round((x.done / max) * 100)}%"></span>
            <span class="review-bar focus" style="height:${Math.round((x.focus / max) * 100)}%"></span>
          </div>
          <span class="review-bar-day" aria-hidden="true">${fmtWeekday(x.date, 'short')}</span>
        </div>`)}</div>
    </section>`;

    const keyOf = (sid) => {
      const r = d.rootOf(sid);
      if (!r) return null;
      return area === 'project' ? r.project_id || null : r.course_id || null;
    };
    const areas = plannedVsActualBy({ schedules: d.range.schedules, items: d.range.items, from: d.start, to: d.end, keyOf });
    const areaName = (k) => {
      if (!k) return area === 'project' ? t('review.noProject') : t('review.noCourse');
      if (area === 'project') return projectById.get(k) ? projectById.get(k).title : t('review.noProject');
      const c = courseById.get(k);
      return c ? (c.code || c.name) : t('review.noCourse');
    };
    const areaColor = (k) => (area === 'course' && courseById.get(k) ? courseById.get(k).color : '');
    const areaCard = html`<section class="card" aria-labelledby="reviewAreaHead">
      <div class="card-head"><h2 class="card-title" id="reviewAreaHead">${t('review.areaTitle')}</h2>
        ${has('projects') ? segmented('reviewArea', [{ value: 'course', label: t('review.byCourse') }, { value: 'project', label: t('review.byProject') }], area, { label: t('review.areaTitle') }) : ''}</div>
      ${areas.length ? html`<ul class="review-areas">${areas.map((x) => html`<li style="--c:${safeColor(areaColor(x.key), '#8a91a0')}">
          <span class="review-area-name"><span class="course-dot" aria-hidden="true"></span>${areaName(x.key)}</span>
          ${progressBar(x.planned ? x.done / x.planned : 0, { thin: true, color: areaColor(x.key), label: fill('review.areaLabel', { name: areaName(x.key), done: fmtMinutes(x.done), planned: fmtMinutes(x.planned) }) })}
          <span class="small tabular">${fmtMinutes(x.done)} / ${fmtMinutes(x.planned)}</span>
        </li>`)}</ul>` : html`<p class="muted small" style="margin:0">${t('review.noBlocks')}</p>`}
    </section>`;

    const winsCard = html`<section class="card" aria-labelledby="reviewWinsHead">
      <div class="card-head"><h2 class="card-title" id="reviewWinsHead">${t('review.winsTitle')} <span class="muted">${tasks.completed.length + milestones.length + achieved.length || ''}</span></h2></div>
      ${tasks.completed.length || milestones.length || achieved.length ? html`<ul class="review-list">
        ${achieved.map((g) => html`<li>${raw(icon('target'))}<span>${fill('review.goalAchieved', { name: g.title })}</span></li>`)}
        ${milestones.map((m) => html`<li>${raw(icon('flag'))}<span>${m.title}</span></li>`)}
        ${tasks.completed.slice(0, 12).map((g) => html`<li>${raw(icon('check'))}<span>${g.name}</span></li>`)}
        ${tasks.completed.length > 12 ? html`<li class="muted">${fill('review.andMore', { n: tasks.completed.length - 12 })}</li>` : ''}
      </ul>` : html`<p class="muted small" style="margin:0">${t('review.noWins')}</p>`}
    </section>`;

    const slippedCard = html`<section class="card" aria-labelledby="reviewSlipHead">
      <div class="card-head"><h2 class="card-title" id="reviewSlipHead">${t('review.slippedTitle')} <span class="muted">${tasks.slipped.length || ''}</span></h2>
        ${tasks.slipped.length && d.isCurrent ? button(t('catchup.open'), { size: 'sm', action: 'review-catchup', iconName: 'repeat' }) : ''}</div>
      ${tasks.slipped.length ? html`<ul class="review-list">${tasks.slipped.slice(0, 10).map((g) => html`<li>${raw(icon('alert'))}<span>${g.name} <span class="muted small">· ${fill('review.wasDue', { date: fmtDate(g.dueDate) })}</span></span></li>`)}</ul>`
        : html`<p class="muted small" style="margin:0">${t('review.nothingSlippedLong')}</p>`}
    </section>`;

    const goalsCard = has('goals') && (checkIns.length || d.goals.some((g) => g.status === 'active')) ? html`<section class="card" aria-labelledby="reviewGoalsHead">
      <div class="card-head"><h2 class="card-title" id="reviewGoalsHead">${t('review.goalsTitle')}</h2><a class="card-link" href="#/goals">${t('common.viewAll')}</a></div>
      ${checkIns.length ? html`<ul class="review-list">${checkIns.map((x) => html`<li>${raw(icon('target'))}<span>${x.goal.title} <span class="muted small">· ${x.change !== null ? fill('review.goalChange', { change: `${x.change >= 0 ? '+' : ''}${formatValue(x.change)}`, unit: x.goal.unit || '' }) : fill('review.goalLatest', { value: formatValue(x.latest), unit: x.goal.unit || '' })} · ${tCount('review.checkIns', x.count)}</span></span></li>`)}</ul>`
        : html`<p class="muted small" style="margin:0">${t('review.noCheckIns')}</p>`}
    </section>` : '';

    const routinesCard = has('routines') && routineRows.length ? html`<section class="card" aria-labelledby="reviewRoutinesHead">
      <div class="card-head"><h2 class="card-title" id="reviewRoutinesHead">${t('nav.routines')}</h2><a class="card-link" href="#/routines">${t('common.viewAll')}</a></div>
      <ul class="review-areas">${routineRows.map((x) => html`<li><span class="review-area-name">${x.r.title}</span>${progressBar(x.rate.rate || 0, { thin: true, label: fill('review.routineLabel', { name: x.r.title, done: x.rate.done, due: x.rate.due }) })}<span class="small tabular">${x.rate.done}/${x.rate.due}</span></li>`)}</ul>
    </section>` : '';

    const upcoming = d.groups.filter((g) => !g.done && g.dueDate && g.dueDate > d.end && g.dueDate <= addDays(d.end, 7)).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const nextExams = d.exams.filter((e) => e.exam_date > d.end && e.exam_date <= addDays(d.end, 7));
    const heavy = d.nextDays.filter((x) => x.level === 'overloaded' || x.level === 'busy');
    const aheadCard = d.isCurrent ? html`<section class="card" aria-labelledby="reviewAheadHead">
      <div class="card-head"><h2 class="card-title" id="reviewAheadHead">${t('review.aheadTitle')}</h2><a class="card-link" href="#/week">${t('home3.openForecast')}</a></div>
      ${d.nextDays.length ? html`<div class="home3-mini-heat" aria-label="${t('workload.heatTitle')}">${d.nextDays.map((x) => html`<span class="home3-mini-day heat-cell--${x.level}" title="${fmtDate(x.date)} · ${t(`workload.${x.level}`)}"><span>${fmtWeekday(x.date, 'narrow')}</span></span>`)}</div>` : ''}
      <ul class="review-list">
        ${nextExams.map((e) => html`<li>${raw(icon('exam'))}<span>${e.name} <span class="muted small">· ${fmtDate(e.exam_date)}</span></span></li>`)}
        ${upcoming.slice(0, 6).map((g) => html`<li>${raw(icon('clock'))}<span>${g.name} <span class="muted small">· ${fill('review.dueOn', { date: fmtDate(g.dueDate) })}</span></span></li>`)}
        ${heavy.slice(0, 2).map((x) => html`<li>${raw(icon('alert'))}<span>${fill('review.heavyDay', { day: fmtWeekday(x.date, 'long'), level: t(`workload.${x.level}`) })}</span></li>`)}
      </ul>
      ${!upcoming.length && !nextExams.length && !heavy.length ? html`<p class="muted small" style="margin:0">${t('review.aheadCalm')}</p>` : ''}
    </section>` : '';

    const reflect = html`<section class="card review-reflect" aria-labelledby="reviewReflectHead">
      <div class="card-head"><div><h2 class="card-title" id="reviewReflectHead" tabindex="-1">${t('review.reflectTitle')}</h2><p class="card-subtitle">${t('review.reflectSub')}</p></div>
        ${review.doneAt ? badge(fill('review.reviewedOn', { date: fmtDate(todayStrOf(review.doneAt)) }), 'success') : ''}</div>
      <form data-form="reflect" class="review-form">
        ${REVIEW_FIELDS.map((f) => html`<div class="field"><label for="review-${f}">${t(`review.q_${f}`)}</label><textarea id="review-${f}" rows="2" maxlength="${REVIEW_LIMIT}" placeholder="${t(`review.p_${f}`)}">${review[f] || ''}</textarea></div>`)}
        <div class="settings-btn-row">
          <button type="submit" class="btn btn--primary btn--sm" data-done="1"><span>${review.doneAt ? t('review.saveAgain') : t('review.markDone')}</span></button>
          <button type="submit" class="btn btn--secondary btn--sm" data-done="0"><span>${t('review.saveDraft')}</span></button>
        </div>
        <p class="hint" data-role="reflect-msg" aria-live="polite"></p>
      </form>
    </section>`;

    setHtml(root, [head(d.start),
      nothing ? html`<div class="card">${emptyState({ iconName: 'semester', title: t('review.emptyTitle'), body: t('review.emptyBody'), compact: true })}</div>` : '',
      tiles, html`<div class="review-columns"><div class="stack">${chart}${areaCard}${winsCard}${slippedCard}</div><div class="stack">${aheadCard}${goalsCard}${routinesCard}${reflect}</div></div>`]);
    wireSegmented(root, 'reviewArea', (v) => {
      area = v;
      try { localStorage.setItem(AREA_KEY, v); } catch { /* per-viewer */ }
      paint(last);
      root.querySelector('[data-seg="reviewArea"] [aria-pressed="true"]')?.focus();
    });
  }

  function todayStrOf(iso) {
    const dt = new Date(iso);
    return Number.isNaN(dt.getTime()) ? '' : todayStr(dt);
  }

  on(root, 'submit', '[data-form="reflect"]', async (e, form) => {
    e.preventDefault();
    const done = e.submitter ? e.submitter.dataset.done === '1' : true;
    const fields = Object.fromEntries(REVIEW_FIELDS.map((f) => [f, form.querySelector(`#review-${f}`).value]));
    const msg = form.querySelector('[data-role="reflect-msg"]');
    try {
      const next = await saveReview(app().userId, last.start, fields, { done });
      last.reviews = next;
      if (done) {
        toast(t('review.doneToast'), { kind: 'success' });
        paint(last);
        root.querySelector('#reviewReflectHead')?.focus();
      } else msg.textContent = t('review.draftSaved');
    } catch (err) {
      console.error(err);
      msg.textContent = t('settings3.saveFailed');
    }
  });

  on(root, 'click', '[data-action]', async (e, el) => {
    const a = el.dataset.action;
    if (a === 'review-retry') render();
    else if (a === 'week-prev') app().navigate('reviewView', addDays(week, -7));
    else if (a === 'week-next') app().navigate('reviewView', addDays(week, 7));
    else if (a === 'week-now') app().navigate('reviewView', weekBounds(todayStr()).start);
    else if (a === 'review-catchup' && last) {
      const { openCatchUp } = await import('../planner/catchUpUI.js');
      openCatchUp(last.groups, () => render());
    }
  });

  onChange((topic) => {
    if (!root.hidden && ['tasks', 'routines', 'goals', 'projects'].includes(topic)) render();
  });

  return { onShow: (param) => render(param || null) };
}
