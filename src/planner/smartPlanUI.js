// Smart plan drawer (V5-B) — "Catch up" and "Plan my deadlines".
// Shows every task that needs days, where each part would go, and WHY, in
// plain words built from the forecast's real numbers ("Due Thu · 3 h left ·
// Wed has 2 h free"). Warns when there isn't enough time. Nothing is written
// until Apply; locked sessions and fixed events are never moved.

import { t, tCount } from '../shared/i18n.js';
import { h } from '../ui/dom.js';
import { openDrawer } from '../ui/drawer.js';
import { toast } from '../ui/toast.js';
import { app } from '../app/context.js';
import { todayStr, addDays, minutesOfDay, diffDays } from '../shared/dates.js';
import { fmtDate, fmtWeekday, fmtMinutes } from '../ui/format.js';
import { loadForecastInput } from '../workload/workloadData.js';
import { buildWorkloadForecast } from '../workload/workloadModel.js';
import { freeDaysFromForecast } from './backlogPlanner.js';
import { catchUpStart } from './catchUpModel.js';
import { collectPlanItems, proposeSmartPlan } from './smartPlanModel.js';
import { applySmartPlan } from './smartPlanData.js';
import { planHorizonDays } from '../billing/entitlements.js';
import { track } from '../analytics/productEvents.js';

function fill(key, params = {}) {
  let text = t(key);
  Object.entries(params).forEach(([k, v]) => { text = text.split(`{${k}}`).join(String(v)); });
  return text;
}

function dayName(date, today) {
  if (date === today) return t('catchup.today');
  if (date === addDays(today, 1)) return t('catchup.tomorrow');
  // Within a week the weekday is clearest; further out, the date.
  const n = diffDays(today, date);
  return n > 0 && n < 7 ? fmtWeekday(date, 'long') : `${fmtWeekday(date)} ${fmtDate(date)}`;
}

/** One-sentence explanation from the plan's facts (never invents numbers). */
export function explanationText(proposal, today, start = today) {
  const { summary, parts } = proposal;
  const out = [];
  const left = fmtMinutes(summary.minutes);
  if (summary.dueDate && !summary.late) out.push(fill('smart.whyDue', { date: dayName(summary.dueDate, today), left }));
  else if (summary.late) out.push(fill('smart.whyLate', { date: fmtDate(summary.dueDate), left }));
  else out.push(fill('smart.whyNoDue', { left }));
  const first = parts[0];
  if (first && summary.shortBy <= 0) out.push(fill('smart.whyFirstDay', { day: dayName(first.date, today), free: fmtMinutes(first.dayFree) }));
  if (first && first.date > start) out.push(t('smart.whyEarlierFull'));
  if (summary.shortBy > 0) {
    const last = parts[parts.length - 1];
    out.push(fill('smart.whyShort', { need: left, free: fmtMinutes(summary.freeBeforeDue), date: summary.dueDate ? dayName(summary.dueDate, today) : '—', extra: fmtMinutes(summary.shortBy), day: last ? dayName(last.date, today) : '' }));
  } else if (summary.tight) out.push(t('smart.whyTight'));
  return out.join(' ');
}

/**
 * @param {Array} groups task groups (taskModel)
 * @param {{ mode?: 'catchup'|'all', onDone?: Function }} [opts]
 */
export async function openSmartPlan(groups, { mode = 'all', onDone } = {}) {
  const ctx = app();
  const today = todayStr();
  let includeUnscheduled = mode === 'all';
  let start = mode === 'catchup' ? catchUpStart(today, minutesOfDay(), addDays(today, 1)) : today;
  let items = collectPlanItems(groups, today, { includeUnscheduled });
  const unscheduledCount = collectPlanItems(groups, today).filter((x) => x.reason === 'unscheduled').length;
  const unchecked = new Set();
  let freeDays = [];
  let horizon = 14;
  let cappedByPlan = false;
  let result = { proposals: [], totals: { minutes: 0, planned: 0, short: 0, tasks: 0 } };

  const api = openDrawer({
    title: mode === 'catchup' ? t('catchup.title') : t('smart.title'),
    subtitle: mode === 'catchup' ? t('catchup.sub') : t('smart.sub'),
    size: 'wide',
    render: (body) => body.appendChild(h('p', { class: 'hint' }, t('common.loading'))),
    actions: [{ label: t('common.cancel'), onClick: (a) => a.close() }],
  });

  async function loadCapacity() {
    // Far enough to reach the furthest due date (within the plan's horizon).
    const furthest = items.reduce((m, x) => (x.group.dueDate && x.group.dueDate > m ? x.group.dueDate : m), today);
    const limit = planHorizonDays();
    const wanted = Math.max(14, diffDays(today, furthest) + 1);
    horizon = Math.min(limit, wanted);
    cappedByPlan = wanted > limit;
    const fc = await loadForecastInput(ctx.userId, today, horizon);
    freeDays = freeDaysFromForecast(buildWorkloadForecast(fc.input));
  }

  try {
    await loadCapacity();
  } catch (err) {
    console.error('Could not load capacity for the smart plan', err);
    api.body.innerHTML = '';
    api.body.appendChild(h('p', { class: 'field-error', role: 'alert' }, t('v3.loadErrorBody')));
    return;
  }

  function paint(focusSel = null) {
    const chosen = items.filter((x) => !unchecked.has(x.group.id));
    result = proposeSmartPlan(chosen, freeDays, start);
    const byTask = new Map(result.proposals.map((p) => [p.summary.taskId, p]));
    const body = api.body;
    body.innerHTML = '';

    if (!items.length) {
      body.appendChild(h('div', { class: 'smart-empty' },
        h('p', { class: 'smart-empty-title' }, mode === 'catchup' ? t('catchup.nothing') : t('smart.nothingTitle')),
        h('p', { class: 'hint' }, t('smart.nothingBody'))));
      if (mode === 'catchup' && unscheduledCount) body.appendChild(includeToggle());
      api.setActions([{ label: t('common.close'), onClick: (b) => b.close() }]);
      return;
    }

    // Summary: how much work, how much room — from the forecast.
    const t0 = result.totals;
    const freeTotal = freeDays.filter((d) => d.date >= start).reduce((s, d) => s + d.free, 0);
    body.appendChild(h('div', { class: 'smart-summary', role: 'status' },
      h('div', { class: 'smart-stat' }, h('span', { class: 'smart-stat-n' }, String(t0.tasks)), h('span', { class: 'smart-stat-l' }, tCount('smart.statTasks', t0.tasks))),
      h('div', { class: 'smart-stat' }, h('span', { class: 'smart-stat-n' }, fmtMinutes(t0.minutes)), h('span', { class: 'smart-stat-l' }, t('smart.statWork'))),
      h('div', { class: 'smart-stat' }, h('span', { class: 'smart-stat-n' }, fmtMinutes(freeTotal)), h('span', { class: 'smart-stat-l' }, fill('smart.statFree', { n: horizon })))));
    if (t0.short > 0) {
      body.appendChild(h('div', { class: 'notice notice--warning smart-warn', role: 'alert' },
        h('div', {}, h('p', { class: 'notice-title' }, t('smart.shortTitle')), h('p', {}, fill('smart.shortBody', { time: fmtMinutes(t0.short) })))));
    }

    // Free plan (only when billing is on): say plainly what the look-ahead covers.
    if (cappedByPlan) body.appendChild(h('p', { class: 'hint smart-capped' }, fill('smart.cappedByPlan', { n: horizon })));
    const controls = h('div', { class: 'smart-controls' });
    const startGroup = h('div', { class: 'seg', role: 'group', 'aria-label': t('catchup.startLabel') });
    [['today', today], ['tomorrow', addDays(today, 1)]].forEach(([key, date]) => {
      const b = h('button', { type: 'button', 'data-start': key, 'aria-pressed': start === date ? 'true' : 'false' }, t(`catchup.start_${key}`));
      b.addEventListener('click', () => { start = date; paint(`[data-start="${key}"]`); });
      startGroup.appendChild(b);
    });
    controls.appendChild(h('div', { class: 'catchup-start' }, h('span', { class: 'field-label' }, t('catchup.startLabel')), startGroup));
    if (unscheduledCount) controls.appendChild(includeToggle());
    body.appendChild(controls);

    const list = h('ul', { class: 'smart-list', 'aria-label': t('catchup.listLabel') });
    items.forEach((x) => {
      const g = x.group;
      const id = `sp-${g.id}`;
      const on = !unchecked.has(g.id);
      const cb = h('input', { type: 'checkbox', id });
      cb.checked = on;
      cb.addEventListener('change', () => {
        if (cb.checked) unchecked.delete(g.id); else unchecked.add(g.id);
        paint(`#${CSS.escape(id)}`);
      });
      const p = byTask.get(g.id);
      const badges = h('span', { class: 'smart-badges' },
        h('span', { class: `badge ${x.reason === 'overdue' ? 'badge--danger' : x.reason === 'missed' ? 'badge--warning' : 'badge--outline'}` }, t(`smart.reason_${x.reason}`)),
        x.portion.lockedMinutes ? h('span', { class: 'muted small' }, t('catchup.lockedKept').replace('{time}', fmtMinutes(x.portion.lockedMinutes))) : null);
      const li = h('li', { class: `smart-row${on ? '' : ' is-off'}` },
        cb,
        h('label', { for: id, class: 'smart-main' }, h('span', { class: 'smart-name' }, g.name), badges));
      if (on && p) {
        li.appendChild(h('p', { class: 'smart-why' }, explanationText(p, today, start)));
        const chips = h('ol', { class: 'smart-days', 'aria-label': t('smart.daysLabel') });
        p.parts.forEach((part) => {
          chips.appendChild(h('li', { class: `smart-day${part.overBy ? ' is-over' : part.tight ? ' is-tight' : ''}`, title: fill('smart.dayFree', { free: fmtMinutes(part.dayFree) }) },
            h('span', { class: 'smart-day-d' }, dayName(part.date, today)),
            h('span', { class: 'smart-day-m' }, fmtMinutes(part.minutes)),
            part.overBy ? h('span', { class: 'sr-only' }, fill('smart.overBy', { time: fmtMinutes(part.overBy) })) : null));
        });
        li.appendChild(chips);
      } else if (!on) {
        li.appendChild(h('p', { class: 'smart-why muted' }, t('catchup.leaveAsIs')));
      }
      list.appendChild(li);
    });
    body.appendChild(list);
    body.appendChild(h('p', { class: 'hint' }, t('smart.safetyNote')));

    const n = result.proposals.length;
    api.setActions([
      { label: t('common.cancel'), onClick: (b) => b.close() },
      {
        label: n ? tCount('smart.apply', n) : t('catchup.applyNone'),
        variant: 'primary',
        onClick: async (b) => {
          if (!n) return;
          b.setBusy(true);
          const res = await applySmartPlan(ctx.userId, result.proposals);
          track(mode === 'catchup' ? 'catchup_applied' : 'plan_applied', { tasks: res.moved, days: new Set(result.proposals.flatMap((p) => p.parts.map((x) => x.date))).size });
          b.close(true);
          if (res.failed.length) toast(t('catchup.partial').replace('{done}', String(res.moved)).replace('{failed}', res.failed.map((f) => f.name).join(', ')), { kind: 'error' });
          else toast(tCount('smart.done', res.moved), { kind: 'success' });
          if (onDone) onDone(res);
        },
      },
    ]);
    if (!n) api.panel.querySelector('.drawer-foot .btn--primary')?.setAttribute('disabled', '');
    if (focusSel) body.querySelector(focusSel)?.focus();
  }

  function includeToggle() {
    const label = h('label', { class: 'smart-include' });
    const cb = h('input', { type: 'checkbox', id: 'spIncludeUnscheduled' });
    cb.checked = includeUnscheduled;
    cb.addEventListener('change', async () => {
      includeUnscheduled = cb.checked;
      items = collectPlanItems(groups, today, { includeUnscheduled });
      try { await loadCapacity(); } catch { /* keep the previous capacity */ }
      paint('#spIncludeUnscheduled');
    });
    label.append(cb, h('span', {}, fill('smart.includeUnscheduled', { n: unscheduledCount })));
    return label;
  }

  paint();
}
