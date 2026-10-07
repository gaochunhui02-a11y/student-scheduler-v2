// Backlog (V4-B.1) UI: "Plan my backlog" (deterministic day assignment with a
// preview — nothing moves until the student confirms) and "Add from backlog"
// (the student pulls chosen tasks onto a Planner day). Both only give tasks a
// DAY; the Planner's Generate builds the sessions, as for every task.

import { t, tCount } from '../shared/i18n.js';
import { h } from '../ui/dom.js';
import { openDrawer } from '../ui/drawer.js';
import { toast } from '../ui/toast.js';
import { app } from '../app/context.js';
import { todayStr } from '../shared/dates.js';
import { fmtDate, fmtWeekday, fmtMinutes } from '../ui/format.js';
import { loadForecastInput } from '../workload/workloadData.js';
import { buildWorkloadForecast } from '../workload/workloadModel.js';
import { planBacklog, freeDaysFromForecast } from './backlogPlanner.js';
import { moveTaskToDate, listBacklogRows } from '../tasks/tasksData.js';

const HORIZON_DAYS = 14;

function dayLabel(date) {
  return `${fmtWeekday(date)} ${fmtDate(date)}`;
}

/**
 * @param {Array} groups  open, unscheduled task groups (taskModel)
 * @param {Function} [onDone]
 */
export async function openPlanBacklog(groups, onDone) {
  const ctx = app();
  const today = todayStr();
  let plan = null;
  const api = openDrawer({
    title: t('backlog.planTitle'),
    subtitle: t('backlog.planSub'),
    render: (body) => body.appendChild(h('p', { class: 'hint' }, t('common.loading'))),
    actions: [{ label: t('common.cancel'), onClick: (a) => a.close() }],
  });
  try {
    const fc = await loadForecastInput(ctx.userId, today, HORIZON_DAYS);
    const days = freeDaysFromForecast(buildWorkloadForecast(fc.input));
    plan = planBacklog({
      today,
      days,
      tasks: groups.map((g) => ({ id: g.id, name: g.name, minutes: g.remainingMinutes || g.requestedMinutes, dueDate: g.dueDate, priority: g.priority })),
    });
  } catch (err) {
    console.error('Could not plan the backlog', err);
    api.body.innerHTML = '';
    api.body.appendChild(h('p', { class: 'field-error', role: 'alert' }, t('v3.loadErrorBody')));
    return;
  }
  const body = api.body;
  body.innerHTML = '';
  if (plan.assignments.length) {
    body.appendChild(h('p', { class: 'hint' }, t('backlog.planIntro')));
    const list = h('ul', { class: 'backlog-plan' });
    plan.assignments.forEach((a) => list.appendChild(h('li', {},
      h('span', { class: 'backlog-plan-name' }, a.name),
      h('span', { class: 'backlog-plan-day' }, `${dayLabel(a.date)} · ${fmtMinutes(a.minutes)}`),
      a.tight ? h('span', { class: 'badge badge--warning' }, t('backlog.tight')) : null)));
    body.appendChild(list);
  }
  if (plan.unplaced.length) {
    body.appendChild(h('h3', { class: 'settings3-subhead' }, t('backlog.unplacedTitle')));
    body.appendChild(h('p', { class: 'hint' }, t('backlog.unplacedBody')));
    const list = h('ul', { class: 'backlog-plan is-unplaced' });
    plan.unplaced.forEach((u) => list.appendChild(h('li', {}, h('span', { class: 'backlog-plan-name' }, u.name))));
    body.appendChild(list);
  }
  if (!plan.assignments.length && !plan.unplaced.length) body.appendChild(h('p', { class: 'hint' }, t('backlog.nothing')));
  body.appendChild(h('p', { class: 'hint' }, t('backlog.generateNote')));
  api.setActions([
    { label: t('common.cancel'), onClick: (a) => a.close() },
    ...(plan.assignments.length ? [{
      label: tCount('backlog.apply', plan.assignments.length),
      variant: 'primary',
      onClick: async (a) => {
        a.setBusy(true);
        let done = 0;
        try {
          for (const asg of plan.assignments) {
            // eslint-disable-next-line no-await-in-loop
            await moveTaskToDate(ctx.userId, asg.taskId, asg.date, null, { plannedBy: 'planner' });
            done += 1;
          }
          a.close(true);
          toast(tCount('backlog.applied', done), { kind: 'success' });
        } catch (err) {
          console.error('Could not schedule backlog', err);
          a.setBusy(false);
          toast(tCount('backlog.partial', done), { kind: 'error' });
        }
        if (onDone) onDone();
      },
    }] : []),
  ]);
}

/** Planner: pick backlog tasks to work on this day. */
export async function openBacklogPicker(date, onDone) {
  const ctx = app();
  let rows = [];
  try {
    rows = (await listBacklogRows(ctx.userId)).filter((r) => !r.origin_subject_id);
  } catch (err) {
    console.error(err);
    toast(t('v3.loadErrorBody'), { kind: 'error' });
    return;
  }
  rows.sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')) || String(a.name).localeCompare(String(b.name)));
  openDrawer({
    title: t('backlog.pickTitle').replace('{day}', dayLabel(date)),
    subtitle: t('backlog.pickSub'),
    render: (body) => {
      if (!rows.length) {
        body.appendChild(h('p', { class: 'hint' }, t('backlog.pickEmpty')));
        return;
      }
      const list = h('fieldset', { class: 'backlog-pick' }, h('legend', { class: 'sr-only' }, t('backlog.pickLegend')));
      rows.forEach((r) => {
        const id = `bp-${r.id}`;
        list.appendChild(h('label', { class: 'backlog-pick-row', for: id },
          h('input', { type: 'checkbox', id, value: r.id }),
          h('span', { class: 'backlog-plan-name' }, r.name),
          h('span', { class: 'backlog-plan-day' }, [r.due_date ? t('backlog.due').replace('{date}', fmtDate(r.due_date)) : '', fmtMinutes(Number(r.minutes_requested) || 0)].filter(Boolean).join(' · '))));
      });
      body.appendChild(list);
    },
    actions: [
      { label: t('common.cancel'), onClick: (a) => a.close() },
      ...(rows.length ? [{
        label: t('backlog.pickAdd'),
        variant: 'primary',
        onClick: async (a) => {
          const ids = [...a.body.querySelectorAll('input[type="checkbox"]:checked')].map((x) => x.value);
          if (!ids.length) {
            a.close();
            return;
          }
          a.setBusy(true);
          try {
            for (const id of ids) {
              // eslint-disable-next-line no-await-in-loop
              await moveTaskToDate(ctx.userId, id, date, null, { plannedBy: 'user' });
            }
            a.close(true);
            toast(tCount('backlog.picked', ids.length), { kind: 'success' });
            if (onDone) onDone();
          } catch (err) {
            console.error(err);
            a.setBusy(false);
            toast(t('v3.saveError'), { kind: 'error' });
          }
        },
      }] : []),
    ],
  });
}
