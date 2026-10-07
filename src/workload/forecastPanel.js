// Workload forecast UI (V3-E/F/G), mounted inside the Week page as a
// second mode ("This week" | "Workload forecast"). Heatmap for 7/14/30
// days -> click a day to see WHY it's busy -> Rebalance an overloaded day
// (preview, then Apply) -> or explore What-if scenarios side by side.

import { t } from '../shared/i18n.js';
import { todayStr, addDays, dayOfWeek } from '../shared/dates.js';
import { app, onChange } from '../app/context.js';
import { html, raw, setHtml, on, h, escapeHtml } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { button, segmented, wireSegmented, skeletonRows, errorNotice, badge } from '../ui/components.js';
import { fmtMinutes, fmtClock, fmtDate, fmtDateLong, fmtWeekday } from '../ui/format.js';
import { toast } from '../ui/toast.js';
import { openDrawer } from '../ui/drawer.js';
import { buildWorkloadForecast, summarizeForecast, deadlineRisks } from './workloadModel.js';
import { proposeRebalance } from './rebalanceModel.js';
import { compareScenario, emptyScenario, scenarioIsEmpty, applyScenarioToInputs } from './scenarioModel.js';
import { loadForecastInput, buildContextByDate, applyRebalanceMoves, applyScenarioChanges } from './workloadData.js';

const LEVEL_KEY = { light: 'workload.light', balanced: 'workload.balanced', busy: 'workload.busy', overloaded: 'workload.overloaded' };
const KEPT_KEY = { locked: 'rebalance.keptLocked', completed: 'rebalance.keptCompleted', started: 'rebalance.keptStarted', missed: 'rebalance.keptMissed', no_room: 'rebalance.keptNoRoom', due_soon: 'rebalance.keptDueSoon', not_needed: 'rebalance.keptNotNeeded' };
const MODE_KEY = 'student-scheduler-week-mode';

export function formatReason(r) {
  let text = t(r.key);
  Object.entries(r.params || {}).forEach(([k, v]) => {
    const value = ['time', 'cap'].includes(k) ? fmtMinutes(v) : String(v);
    text = text.split(`{${k}}`).join(value);
  });
  return text;
}

function heatmapHtml(days, { selected = null, compact = false, interactive = true } = {}) {
  if (!days.length) return '';
  // Align to Monday columns so weeks read left-to-right.
  const lead = (dayOfWeek(days[0].date) + 6) % 7;
  const cells = [...Array.from({ length: lead }, () => null), ...days];
  return html`<div class="heat-wrap${compact ? ' is-compact' : ''}">
    <div class="heat-grid heat-grid--week" aria-hidden="${interactive ? 'false' : 'true'}">
      ${[1, 2, 3, 4, 5, 6, 0].map((d) => html`<span class="heat-head">${fmtWeekday(addDays('2026-10-04', d), 'short')}</span>`)}
      ${cells.map((d) => (d === null
        ? html`<span class="heat-empty"></span>`
        : html`<button type="button" class="heat-cell heat-cell--${d.level}${d.isToday ? ' is-today' : ''}${d.blocked ? ' is-blocked' : ''}" ${interactive ? raw(`data-action="select-day" data-date="${d.date}"`) : raw('tabindex="-1"')} aria-pressed="${selected === d.date ? 'true' : 'false'}" aria-label="${escapeHtml(`${fmtDateLong(d.date)}: ${t(LEVEL_KEY[d.level])}, ${fmtMinutes(d.studyLoad)} / ${fmtMinutes(d.capacity)}`)}">
            <span class="heat-cell-day">${compact ? fmtDate(d.date, { day: 'numeric' }) : fmtDate(d.date, { month: 'short', day: 'numeric' })}</span>
            ${compact ? '' : html`<span class="heat-cell-load tabular">${fmtMinutes(d.studyLoad)}</span>`}
            <span class="heat-cell-flags">${compact ? '' : ''}${d.exams.length ? html`<i class="heat-flag heat-flag--exam"></i>` : ''}${d.deadlines.length ? html`<i class="heat-flag"></i>` : ''}</span>
          </button>`))}
    </div>
  </div>`;
}

export function initForecastPanel() {
  const weekView = document.getElementById('weekView');
  if (!weekView) return null;
  const header = weekView.querySelector('.board-header');
  const weekOnly = [weekView.querySelector('.week-nav-row'), document.getElementById('weekSummaryCard'), document.getElementById('weekStatus'), document.getElementById('weekGrid')].filter(Boolean);

  const modeWrap = h('div', { class: 'week-mode' });
  header.querySelector('.board-header-info').appendChild(modeWrap);
  const panel = h('div', { class: 'forecast-panel', id: 'forecastPanel', hidden: true });
  weekView.appendChild(panel);

  let mode = 'week';
  try { mode = localStorage.getItem(MODE_KEY) === 'forecast' ? 'forecast' : 'week'; } catch { /* default */ }
  let horizon = 14;
  let selected = null;
  let state = null;
  let token = 0;

  function drawMode() {
    setHtml(modeWrap, segmented('weekMode', [{ value: 'week', label: t('workload.modeWeek') }, { value: 'forecast', label: t('workload.modeForecast') }], mode, { label: t('workload.modeLabel') }));
    wireSegmented(modeWrap, 'weekMode', (v) => {
      mode = v;
      try { localStorage.setItem(MODE_KEY, v); } catch { /* ignore */ }
      apply();
    });
  }

  function apply() {
    drawMode();
    weekOnly.forEach((el) => { el.dataset.forecastHidden = mode === 'forecast' ? '1' : ''; el.classList.toggle('is-forecast-hidden', mode === 'forecast'); });
    panel.hidden = mode !== 'forecast';
    if (mode === 'forecast') render();
  }

  async function render() {
    const my = ++token;
    if (!state) setHtml(panel, skeletonRows(4, 64));
    try {
      const today = todayStr();
      const { input, dueBySubject } = await loadForecastInput(app().userId, today, horizon);
      if (my !== token) return;
      const days = buildWorkloadForecast(input);
      state = { input, dueBySubject, days, summary: summarizeForecast(days), risks: deadlineRisks(days, input.groups, today), today };
      if (!selected || !days.some((d) => d.date === selected)) selected = (days.find((d) => d.level === 'overloaded') || days[0]).date;
      draw();
    } catch (err) {
      console.error('Could not build workload forecast', err);
      if (my === token) setHtml(panel, errorNotice('', { retryAction: 'forecast-retry' }));
    }
  }

  function draw() {
    const { days, summary, risks } = state;
    const day = days.find((d) => d.date === selected) || days[0];
    setHtml(panel, html`
      <div class="toolbar">
        ${segmented('horizon', [{ value: '7', label: t('workload.days7') }, { value: '14', label: t('workload.days14') }, { value: '30', label: t('workload.days30') }], String(horizon), { label: t('workload.horizonLabel') })}
        <span class="toolbar-spacer"></span>
        ${button(t('scenario.open'), { action: 'open-scenario', iconName: 'wand' })}
      </div>
      <div class="stat-row forecast-stats">
        <div class="stat"><span class="stat-label">${t('workload.statOverloaded')}</span><span class="stat-value${summary.overloadedDays ? ' is-danger' : ''}">${summary.overloadedDays}</span><span class="stat-sub">${summary.totalOver ? t('workload.overTotal').replace('{time}', fmtMinutes(summary.totalOver)) : t('workload.noneOver')}</span></div>
        <div class="stat"><span class="stat-label">${t('workload.statStudy')}</span><span class="stat-value">${fmtMinutes(summary.totalStudy)}</span><span class="stat-sub">${t('workload.perDayAvg').replace('{time}', fmtMinutes(summary.totalStudy / days.length))}</span></div>
        <div class="stat"><span class="stat-label">${t('workload.statClass')}</span><span class="stat-value">${fmtMinutes(summary.totalClass)}</span></div>
        <div class="stat"><span class="stat-label">${t('workload.statDeadlines')}</span><span class="stat-value">${summary.deadlines}</span><span class="stat-sub">${summary.exams ? t('workload.examsCount').replace('{n}', String(summary.exams)) : ''}</span></div>
      </div>
      ${risks.length ? html`<div class="notice notice--danger">${raw(icon('alert'))}<div><p class="notice-title">${t('workload.riskTitle')}</p><p>${risks.slice(0, 3).map((r) => t('workload.riskLine').replace('{name}', r.name).replace('{time}', fmtMinutes(r.shortBy)).replace('{date}', fmtDate(r.dueDate))).join(' ')}</p></div></div>` : ''}
      <div class="forecast-layout">
        <section class="card">
          <div class="card-head"><h2 class="card-title">${t('workload.heatTitle')}</h2>
            <div class="load-legend">${['light', 'balanced', 'busy', 'overloaded'].map((lv) => html`<span><i class="heat-cell--${lv}"></i>${t(LEVEL_KEY[lv])}</span>`)}</div>
          </div>
          ${heatmapHtml(days, { selected })}
          <p class="small muted" style="margin:var(--space-3) 0 0">${t('workload.heatHint')}</p>
        </section>
        ${dayDetail(day)}
      </div>`);
    wireSegmented(panel, 'horizon', (v) => { horizon = Number(v); state = null; render(); });
  }

  function dayDetail(d) {
    const segs = [
      ['study', d.studyMinutes],
      ['backlog', d.backlogMinutes],
      ['prep', d.examPrepMinutes],
    ].filter(([, v]) => v > 0);
    const max = Math.max(d.capacity, d.studyLoad, 1);
    return html`<section class="card forecast-day" aria-live="polite">
      <div class="card-head">
        <div><h2 class="card-title">${fmtDateLong(d.date)}</h2><p class="card-sub">${d.level === 'overloaded' ? t('workload.overBy').replace('{time}', fmtMinutes(d.overBy)) : t('workload.loadOf').replace('{load}', fmtMinutes(d.studyLoad)).replace('{cap}', fmtMinutes(d.capacity))}</p></div>
        ${badge(t(LEVEL_KEY[d.level]), d.level === 'overloaded' ? 'danger' : d.level === 'busy' ? 'warning' : d.level === 'balanced' ? 'success' : 'outline')}
      </div>
      <div class="load-bar" role="img" aria-label="${t('workload.loadOf').replace('{load}', fmtMinutes(d.studyLoad)).replace('{cap}', fmtMinutes(d.capacity))}">
        ${segs.map(([k, v]) => html`<span class="load-seg load-seg--${k}" style="width:${(v / max) * 100}%"></span>`)}
        ${d.capacity ? html`<span class="load-cap" style="left:${Math.min(100, (d.capacity / max) * 100)}%"></span>` : ''}
      </div>
      <div class="load-legend small">${segs.map(([k, v]) => html`<span><i class="load-seg--${k}"></i>${t(`workload.seg_${k}`)} ${fmtMinutes(v)}</span>`)}</div>
      <p class="section-label" style="margin-top:var(--space-4)">${t('workload.why')}</p>
      ${d.reasons.length ? html`<ul class="why-list">${d.reasons.map((r) => html`<li>${formatReason(r)}</li>`)}</ul>` : html`<p class="small muted">${t('workload.nothing')}</p>`}
      ${d.studyBlocks.length || d.classes.length ? html`<p class="section-label" style="margin-top:var(--space-4)">${t('workload.timeline')}</p>
        <ul class="day-timeline">${[...d.classes.map((c) => ({ ...c, kind: 'class' })), ...d.studyBlocks.map((b) => ({ ...b, kind: 'study' }))].sort((a, b) => a.start - b.start).map((x) => html`<li class="day-timeline-item day-timeline-item--${x.kind}">
          <span class="tabular muted">${fmtClock(x.start)}–${fmtClock(x.end)}</span>
          <span>${x.name}</span>
          ${x.locked ? html`<span class="badge badge--outline">${raw(icon('lock'))}${t('workload.pinned')}</span>` : ''}
          ${x.completed ? html`<span class="badge badge--success">${t('common.done')}</span>` : ''}
        </li>`)}</ul>` : ''}
      <div class="row" style="margin-top:var(--space-4)">
        ${button(t('workload.openPlanner'), { size: 'sm', action: 'open-day', attrs: `data-date="${d.date}"` })}
        ${d.level === 'overloaded' && d.studyBlocks.length ? button(t('rebalance.button'), { size: 'sm', variant: 'primary', action: 'rebalance', iconName: 'scale', attrs: `data-date="${d.date}"` }) : ''}
      </div>
    </section>`;
  }

  // ---------------- Smart Rebalance ----------------
  function openRebalance(date) {
    const ctx = buildContextByDate(state.days, state.input);
    const proposal = proposeRebalance({ date, today: state.today, days: state.days, contextByDate: ctx, dueBySubject: state.dueBySubject });
    const day = state.days.find((d) => d.date === date);
    openDrawer({
      title: t('rebalance.title').replace('{day}', fmtDateLong(date)),
      subtitle: t('rebalance.subtitle').replace('{time}', fmtMinutes(day.overBy)),
      size: 'wide',
      render: (body) => {
        const frag = html`
          ${proposal.moves.length ? html`<p class="section-label">${t('rebalance.proposed')}</p>
            <ul class="move-list">${proposal.moves.map((m) => html`<li class="move-item">
              <span class="move-name">${m.name}<span class="muted small"> · ${fmtMinutes(m.minutes)}</span></span>
              <span class="move-path"><span>${fmtDate(m.fromDate, { weekday: 'short', month: 'short', day: 'numeric' })} ${fmtClock(m.fromStart)}</span>${raw(icon('arrowRight'))}<strong>${fmtDate(m.toDate, { weekday: 'short', month: 'short', day: 'numeric' })} ${fmtClock(m.toStart)}</strong></span>
            </li>`)}</ul>`
            : html`<div class="notice notice--warning">${raw(icon('info'))}<p>${t('rebalance.nothing')}</p></div>`}
          ${proposal.remainingOver > 0 && proposal.moves.length ? html`<div class="notice notice--warning">${raw(icon('alert'))}<p>${t('rebalance.partial').replace('{time}', fmtMinutes(proposal.remainingOver))}</p></div>` : ''}
          ${proposal.kept.filter((k) => k.reason !== 'not_needed').length ? html`<p class="section-label">${t('rebalance.kept')}</p>
            <ul class="why-list">${proposal.kept.filter((k) => k.reason !== 'not_needed').map((k) => html`<li>${k.name} — ${t(KEPT_KEY[k.reason])}</li>`)}</ul>` : ''}
          <p class="small muted">${t('rebalance.rules')}</p>`;
        setHtml(body, frag);
      },
      actions: [
        { label: t('common.cancel'), variant: 'secondary', onClick: (api) => api.close() },
        ...(proposal.moves.length ? [{
          label: t('rebalance.apply'), variant: 'primary',
          onClick: async (api, btn) => {
            api.setBusy(true);
            btn.textContent = t('common.saving');
            try {
              const n = await applyRebalanceMoves(app().userId, proposal.moves);
              api.close(true);
              toast(t('rebalance.applied').replace('{n}', String(n)), { kind: 'success' });
              state = null;
              render();
            } catch (err) {
              console.error('Rebalance failed', err);
              api.close(true);
              toast(err && err.code === 'stale' ? t('rebalance.stale') : t('rebalance.failed'), { kind: 'error' });
              state = null;
              render();
            }
          },
        }] : []),
      ],
    });
  }

  // ---------------- What-if ----------------
  function openScenario() {
    const base = state.input;
    const scenario = emptyScenario();
    const openTasks = base.groups.filter((g) => !g.done && g.dueDate && g.dueDate >= state.today).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const upcomingExams = base.exams.filter((e) => e.exam_date >= state.today);
    let resultEl = null;
    let lastCompare = null;
    let lastMoves = [];

    function recompute() {
      if (scenarioIsEmpty(scenario)) {
        lastCompare = null;
        setHtml(resultEl, html`<p class="muted small">${t('scenario.pickSomething')}</p>`);
        return;
      }
      const cmp = compareScenario(base, scenario);
      lastCompare = cmp;
      // A blocked day is applied by moving its study elsewhere.
      lastMoves = [];
      const afterInput = applyScenarioToInputs(base, scenario);
      const ctx = buildContextByDate(cmp.afterDays, afterInput);
      scenario.blockedDates.forEach((d) => {
        const day = cmp.afterDays.find((x) => x.date === d);
        if (!day) return;
        const p = proposeRebalance({ date: d, today: state.today, days: cmp.afterDays, contextByDate: ctx, dueBySubject: state.dueBySubject, targetReduction: day.studyBlocksMinutes });
        lastMoves.push(...p.moves);
      });
      const unmovable = scenario.blockedDates.reduce((s, d) => {
        const day = cmp.afterDays.find((x) => x.date === d);
        if (!day) return s;
        const moved = lastMoves.filter((m) => m.fromDate === d).reduce((a, m) => a + m.minutes, 0);
        return s + Math.max(0, day.studyBlocksMinutes - moved);
      }, 0);
      setHtml(resultEl, html`
        <div class="scenario-compare">
          <div><p class="section-label">${t('scenario.original')}</p>${heatmapHtml(cmp.beforeDays, { compact: true, interactive: false })}
            <p class="small">${t('scenario.overloadedN').replace('{n}', String(cmp.before.overloadedDays))} · ${t('scenario.risksN').replace('{n}', String(cmp.risksBefore.length))}</p></div>
          <div><p class="section-label">${t('scenario.scenario')}</p>${heatmapHtml(cmp.afterDays, { compact: true, interactive: false })}
            <p class="small">${t('scenario.overloadedN').replace('{n}', String(cmp.after.overloadedDays))} · ${t('scenario.risksN').replace('{n}', String(cmp.risksAfter.length))}</p></div>
        </div>
        ${cmp.changedDays.length ? html`<p class="section-label">${t('scenario.changed')}</p><ul class="why-list">${cmp.changedDays.slice(0, 8).map((c) => html`<li><strong>${fmtDate(c.date, { weekday: 'short', month: 'short', day: 'numeric' })}</strong>: ${t(LEVEL_KEY[c.before.level])} (${fmtMinutes(c.before.studyLoad)}) → ${t(LEVEL_KEY[c.after.level])} (${fmtMinutes(c.after.studyLoad)})</li>`)}</ul>` : html`<p class="small muted">${t('scenario.noChange')}</p>`}
        ${cmp.newRisks.length ? html`<div class="notice notice--danger">${raw(icon('alert'))}<p>${t('scenario.newRisks').replace('{names}', cmp.newRisks.map((r) => r.name).join(', '))}</p></div>` : ''}
        ${cmp.resolvedRisks.length ? html`<div class="notice notice--info">${raw(icon('check'))}<p>${t('scenario.resolved').replace('{names}', cmp.resolvedRisks.map((r) => r.name).join(', '))}</p></div>` : ''}
        ${lastMoves.length ? html`<p class="section-label">${t('scenario.movesNeeded')}</p><ul class="move-list">${lastMoves.map((m) => html`<li class="move-item"><span class="move-name">${m.name}</span><span class="move-path">${fmtDate(m.fromDate, { weekday: 'short', day: 'numeric', month: 'short' })} ${raw(icon('arrowRight'))} <strong>${fmtDate(m.toDate, { weekday: 'short', day: 'numeric', month: 'short' })} ${fmtClock(m.toStart)}</strong></span></li>`)}</ul>` : ''}
        ${unmovable > 0 ? html`<div class="notice notice--warning">${raw(icon('alert'))}<p>${t('scenario.unmovable').replace('{time}', fmtMinutes(unmovable))}</p></div>` : ''}
        <p class="small ${canApply() ? 'muted' : 'is-danger-text'}">${canApply() ? t('scenario.safe') : t('scenario.unsafe')}</p>`);
      const applyBtn = document.getElementById('scenarioApplyBtn');
      if (applyBtn) applyBtn.disabled = !canApply();
    }
    function canApply() {
      if (!lastCompare) return false;
      const blockedOk = !scenario.blockedDates.length || lastMoves.length > 0;
      return lastCompare.safe && blockedOk;
    }

    openDrawer({
      title: t('scenario.title'),
      subtitle: t('scenario.subtitle'),
      size: 'wide',
      render: (body) => {
        // Can't study on…
        const chips = h('div', { class: 'chip-toggle-row' });
        state.days.forEach((d) => {
          const b = h('button', { type: 'button', class: 'chip-toggle', 'aria-pressed': 'false' }, fmtDate(d.date, { weekday: 'short', month: 'short', day: 'numeric' }));
          b.addEventListener('click', () => {
            const i = scenario.blockedDates.indexOf(d.date);
            if (i >= 0) scenario.blockedDates.splice(i, 1); else scenario.blockedDates.push(d.date);
            b.setAttribute('aria-pressed', i >= 0 ? 'false' : 'true');
            recompute();
          });
          chips.appendChild(b);
        });
        body.appendChild(h('div', { class: 'field' }, h('span', { class: 'field-label' }, t('scenario.cantStudy')), chips));
        // Max per day
        const max = h('select', { id: 'sc-max', class: 'v3-input', style: { maxWidth: '220px' } }, h('option', { value: '' }, t('scenario.keepLimit').replace('{time}', fmtMinutes(base.dailyMax))));
        [60, 90, 120, 150, 180, 240, 300, 360].forEach((m) => max.appendChild(h('option', { value: String(m) }, fmtMinutes(m))));
        max.addEventListener('change', () => { scenario.dailyMax = max.value ? Number(max.value) : null; recompute(); });
        body.appendChild(h('div', { class: 'field' }, h('label', { for: 'sc-max' }, t('scenario.maxPerDay')), max));
        // Task takes longer
        if (openTasks.length) {
          const taskSel = h('select', { id: 'sc-task', class: 'v3-input' }, h('option', { value: '' }, t('scenario.pickTask')));
          openTasks.slice(0, 80).forEach((g) => taskSel.appendChild(h('option', { value: g.id }, `${g.name} · ${fmtDate(g.dueDate)}`)));
          const extra = h('select', { id: 'sc-extra', class: 'v3-input', style: { maxWidth: '140px' }, 'aria-label': t('scenario.extraTime') });
          [30, 60, 90, 120, 180, 240].forEach((m) => extra.appendChild(h('option', { value: String(m) }, `+${fmtMinutes(m)}`)));
          extra.value = '120';
          const sync = () => { scenario.taskExtra = taskSel.value ? [{ taskId: taskSel.value, minutes: Number(extra.value) }] : []; recompute(); };
          taskSel.addEventListener('change', sync);
          extra.addEventListener('change', sync);
          body.appendChild(h('div', { class: 'field' }, h('label', { for: 'sc-task' }, t('scenario.taskLonger')), h('div', { class: 'row' }, taskSel, extra)));
        }
        // Move an exam
        if (upcomingExams.length) {
          const exSel = h('select', { id: 'sc-exam', class: 'v3-input' }, h('option', { value: '' }, t('scenario.pickExam')));
          upcomingExams.forEach((e) => exSel.appendChild(h('option', { value: e.id }, `${e.name} · ${fmtDate(e.exam_date)}`)));
          const date = h('input', { type: 'date', class: 'v3-input', style: { maxWidth: '180px' }, 'aria-label': t('scenario.newExamDate'), min: addDays(state.today, 1) });
          const sync = () => { scenario.examMoves = exSel.value && date.value ? [{ examId: exSel.value, newDate: date.value }] : []; recompute(); };
          exSel.addEventListener('change', () => {
            const e = upcomingExams.find((x) => x.id === exSel.value);
            if (e && !date.value) date.value = addDays(e.exam_date, 7);
            sync();
          });
          date.addEventListener('change', sync);
          body.appendChild(h('div', { class: 'field' }, h('label', { for: 'sc-exam' }, t('scenario.moveExam')), h('div', { class: 'row' }, exSel, date)));
        }
        resultEl = h('div', { class: 'scenario-result', 'aria-live': 'polite' });
        body.appendChild(h('hr', { class: 'divider' }));
        body.appendChild(resultEl);
        recompute();
      },
      actions: [
        { label: t('common.close'), variant: 'secondary', onClick: (api) => api.close() },
        {
          label: t('scenario.apply'), variant: 'primary', id: 'scenarioApplyBtn',
          onClick: async (api) => {
            if (!canApply()) return;
            api.setBusy(true);
            try {
              if (lastMoves.length) await applyRebalanceMoves(app().userId, lastMoves);
              await applyScenarioChanges(app().userId, scenario, { today: state.today, horizonEnd: addDays(state.today, horizon - 1) });
              api.close(true);
              toast(t('scenario.applied'), { kind: 'success' });
              state = null;
              render();
            } catch (err) {
              console.error('Applying scenario failed', err);
              api.setBusy(false);
              toast(t('scenario.applyFailed'), { kind: 'error' });
            }
          },
        },
      ],
    });
    const applyBtn = document.getElementById('scenarioApplyBtn');
    if (applyBtn) applyBtn.disabled = true;
  }

  on(panel, 'click', '[data-action]', (e, el) => {
    const a = el.dataset.action;
    if (a === 'select-day') { selected = el.dataset.date; draw(); }
    else if (a === 'open-day') app().openPlannerForDate(el.dataset.date);
    else if (a === 'rebalance') openRebalance(el.dataset.date);
    else if (a === 'open-scenario') openScenario();
    else if (a === 'forecast-retry') render();
  });
  // Arrow keys move between heatmap days.
  panel.addEventListener('keydown', (e) => {
    const cell = e.target.closest && e.target.closest('.heat-cell[data-date]');
    if (!cell || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    const next = addDays(cell.dataset.date, delta);
    if (!state.days.some((d) => d.date === next)) return;
    selected = next;
    draw();
    panel.querySelector(`.heat-cell[data-date="${next}"]`)?.focus();
  });

  onChange((topic) => {
    if (mode === 'forecast' && !panel.hidden && ['tasks', 'exams', 'classes'].includes(topic)) { state = null; render(); }
  });

  apply();
  return {
    onShow() {
      apply();
    },
    refreshLabels() {
      drawMode();
      if (mode === 'forecast' && state) draw();
    },
  };
}

