// "Catch up on missed work" drawer (V4-E): lists the missed / overdue work,
// lets the student untick anything and choose whether to start today or
// tomorrow, shows the proposed day for each task, and only writes after
// "Move". Sessions are then built by the Planner's normal Generate.

import { t, tCount } from '../shared/i18n.js';
import { h } from '../ui/dom.js';
import { openDrawer } from '../ui/drawer.js';
import { toast } from '../ui/toast.js';
import { app } from '../app/context.js';
import { todayStr, addDays, minutesOfDay } from '../shared/dates.js';
import { fmtDate, fmtWeekday, fmtMinutes } from '../ui/format.js';
import { loadForecastInput } from '../workload/workloadData.js';
import { buildWorkloadForecast } from '../workload/workloadModel.js';
import { freeDaysFromForecast } from './backlogPlanner.js';
import { collectCatchUp, proposeCatchUp, catchUpStart } from './catchUpModel.js';
import { applyCatchUp } from './catchUpData.js';

const HORIZON_DAYS = 14;

function dayLabel(date, today) {
  if (date === today) return t('catchup.today');
  if (date === addDays(today, 1)) return t('catchup.tomorrow');
  return `${fmtWeekday(date)} ${fmtDate(date)}`;
}

/** Number of tasks with missed work (for banners). */
export function countCatchUp(groups, today = todayStr()) {
  return collectCatchUp(groups, today).length;
}

/**
 * @param {Array} groups  task groups (taskModel) — rows and blocks included
 * @param {Function} [onDone]
 */
export async function openCatchUp(groups, onDone) {
  const ctx = app();
  const today = todayStr();
  const items = collectCatchUp(groups, today);
  const chosen = new Set(items.map((x) => x.group.id));
  let start = catchUpStart(today, minutesOfDay(), addDays(today, 1));
  let freeDays = [];
  let plan = { assignments: [], unplaced: [] };

  const api = openDrawer({
    title: t('catchup.title'),
    subtitle: t('catchup.sub'),
    render: (body) => body.appendChild(h('p', { class: 'hint' }, t('common.loading'))),
    actions: [{ label: t('common.cancel'), onClick: (a) => a.close() }],
  });
  if (!items.length) {
    api.body.innerHTML = '';
    api.body.appendChild(h('p', { class: 'hint' }, t('catchup.nothing')));
    return;
  }
  try {
    const fc = await loadForecastInput(ctx.userId, today, HORIZON_DAYS);
    freeDays = freeDaysFromForecast(buildWorkloadForecast(fc.input));
  } catch (err) {
    console.error('Could not load capacity for catch up', err);
    api.body.innerHTML = '';
    api.body.appendChild(h('p', { class: 'field-error', role: 'alert' }, t('v3.loadErrorBody')));
    return;
  }

  function paint(focusSel = null) {
    plan = proposeCatchUp(items.filter((x) => chosen.has(x.group.id)), freeDays, start);
    const byTask = new Map(plan.assignments.map((a) => [a.taskId, a]));
    const unplaced = new Set(plan.unplaced.map((u) => u.taskId));
    const body = api.body;
    body.innerHTML = '';
    body.appendChild(h('p', { class: 'hint' }, t('catchup.intro')));

    const startGroup = h('div', { class: 'seg', role: 'group', 'aria-label': t('catchup.startLabel') });
    [['today', today], ['tomorrow', addDays(today, 1)]].forEach(([key, date]) => {
      const b = h('button', { type: 'button', 'data-start': key, 'aria-pressed': start === date ? 'true' : 'false' }, t(`catchup.start_${key}`));
      b.addEventListener('click', () => { start = date; paint(`[data-start="${key}"]`); });
      startGroup.appendChild(b);
    });
    body.appendChild(h('div', { class: 'catchup-start' }, h('span', { class: 'field-label' }, t('catchup.startLabel')), startGroup));

    const list = h('ul', { class: 'catchup-list', 'aria-label': t('catchup.listLabel') });
    items.forEach((x) => {
      const g = x.group;
      const id = `cu-${g.id}`;
      const cb = h('input', { type: 'checkbox', id });
      cb.checked = chosen.has(g.id);
      cb.addEventListener('change', () => {
        if (cb.checked) chosen.add(g.id); else chosen.delete(g.id);
        paint(`#${id}`);
      });
      const a = byTask.get(g.id);
      let where;
      if (!chosen.has(g.id)) where = h('span', { class: 'catchup-day is-off' }, t('catchup.leaveAsIs'));
      else if (a) {
        where = h('span', { class: 'catchup-day' }, `→ ${dayLabel(a.date, today)}`);
      } else if (unplaced.has(g.id)) where = h('span', { class: 'catchup-day is-warn' }, t('catchup.noRoom'));
      else where = h('span', { class: 'catchup-day' }, '');
      const meta = h('span', { class: 'catchup-meta' },
        h('span', { class: `badge ${x.reason === 'overdue' ? 'badge--danger' : 'badge--warning'}` }, t(`catchup.reason_${x.reason}`)),
        h('span', {}, fmtMinutes(x.portion.minutes)),
        g.dueDate ? h('span', {}, t('catchup.due').replace('{date}', fmtDate(g.dueDate))) : null,
        a && a.tight ? h('span', { class: 'badge badge--warning' }, t('backlog.tight')) : null,
        a && a.lateForDue ? h('span', { class: 'badge badge--outline' }, t('catchup.afterDue')) : null,
        x.portion.lockedMinutes ? h('span', { class: 'muted' }, t('catchup.lockedKept').replace('{time}', fmtMinutes(x.portion.lockedMinutes))) : null);
      list.appendChild(h('li', { class: `catchup-row${chosen.has(g.id) ? '' : ' is-off'}` },
        cb,
        h('label', { for: id, class: 'catchup-main' }, h('span', { class: 'catchup-name' }, g.name), meta),
        where));
    });
    body.appendChild(list);
    body.appendChild(h('p', { class: 'hint' }, t('catchup.howNote')));
    body.appendChild(h('p', { class: 'hint' }, t('backlog.generateNote')));

    api.setActions([
      { label: t('common.cancel'), onClick: (b) => b.close() },
      {
        label: plan.assignments.length ? tCount('catchup.apply', plan.assignments.length) : t('catchup.applyNone'),
        variant: 'primary',
        onClick: async (b) => {
          if (!plan.assignments.length) return;
          b.setBusy(true);
          const res = await applyCatchUp(ctx.userId, plan.assignments);
          b.close(true);
          if (res.failed.length) toast(t('catchup.partial').replace('{done}', String(res.moved)).replace('{failed}', res.failed.map((f) => f.name).join(', ')), { kind: 'error' });
          else toast(tCount('catchup.done', res.moved), { kind: 'success' });
          if (onDone) onDone(res);
        },
      },
    ]);
    if (!plan.assignments.length) api.panel.querySelector('.drawer-foot .btn--primary')?.setAttribute('disabled', '');
    if (focusSel) body.querySelector(focusSel)?.focus();
  }
  paint();
}
