// "Break it down" drawer (V4-G): pick a template (suggested from the task's
// name), preview the steps with their share of the time and a "done by"
// date, untick any step, then either add them as a checklist inside the task
// or create them as separate tasks with their own due dates (unscheduled,
// ready for "Plan my backlog"). In "separate tasks" mode the task itself
// becomes the final step when no study has been done on it yet, so the total
// time stays the same. Nothing is written before "Create".

import { t, tCount } from '../shared/i18n.js';
import { h } from '../ui/dom.js';
import { openDrawer } from '../ui/drawer.js';
import { toast } from '../ui/toast.js';
import { app } from '../app/context.js';
import { todayStr } from '../shared/dates.js';
import { fmtDate, fmtMinutes } from '../ui/format.js';
import { TEMPLATE_IDS, buildBreakdown, suggestTemplate, canReuseOriginal } from './breakdownModel.js';
import { createTask, updateTask, canLeaveUnscheduled } from './tasksData.js';
import { listSubtasks, insertSubtask } from '../dashboard/data.js';

export function openBreakdown(group, onDone) {
  const today = todayStr();
  const root = group.root;
  let template = suggestTemplate(group.name);
  const reuse = canReuseOriginal(group);
  // Separate step tasks only when the task itself can become the final step
  // (no sessions or progress yet); otherwise the time would be counted twice.
  let mode = reuse ? 'tasks' : 'checklist';
  let steps = [];
  const off = new Set();
  const total = group.remainingMinutes || group.requestedMinutes || root.minutes_requested || 60;

  const api = openDrawer({
    title: t('breakdown.title'),
    subtitle: group.name,
    render: () => {},
    actions: [],
  });

  function stepName(key) {
    return `${group.name}: ${t(`breakdown.step_${key}`)}`;
  }

  function paint(focusSel = null) {
    steps = buildBreakdown({ totalMinutes: total, dueDate: group.dueDate, today, template });
    const body = api.body;
    body.innerHTML = '';
    body.appendChild(h('p', { class: 'hint' }, t('breakdown.intro')));

    const sel = h('select', { id: 'bd-template' });
    TEMPLATE_IDS.forEach((id) => sel.appendChild(h('option', { value: id }, t(`breakdown.tpl_${id}`))));
    sel.value = template;
    sel.addEventListener('change', () => { template = sel.value; off.clear(); paint('#bd-template'); });
    body.appendChild(h('div', { class: 'field' }, h('label', { for: 'bd-template' }, t('breakdown.template')), sel));

    const modeGroup = h('fieldset', { class: 'bd-mode' }, h('legend', {}, t('breakdown.how')));
    [['tasks', 'breakdown.modeTasks', 'breakdown.modeTasksHint'], ['checklist', 'breakdown.modeChecklist', 'breakdown.modeChecklistHint']].forEach(([value, label, hint]) => {
      const id = `bd-mode-${value}`;
      const input = h('input', { type: 'radio', name: 'bd-mode', id, value });
      input.checked = mode === value;
      if (value === 'tasks' && !reuse) input.disabled = true;
      input.addEventListener('change', () => { mode = value; paint(`#${id}`); });
      modeGroup.appendChild(h('div', { class: 'bd-mode-row' }, input, h('label', { for: id }, h('strong', {}, t(label)), h('span', { class: 'muted small' }, t(hint)))));
    });
    if (!reuse) modeGroup.appendChild(h('p', { class: 'field-hint' }, t('breakdown.tasksUnavailable')));
    body.appendChild(modeGroup);

    const list = h('ul', { class: 'catchup-list bd-steps', 'aria-label': t('breakdown.steps') });
    steps.forEach((s, i) => {
      const id = `bd-step-${i}`;
      const finalIsTask = mode === 'tasks' && s.isLast && reuse;
      const cb = h('input', { type: 'checkbox', id });
      cb.checked = !off.has(i);
      if (finalIsTask) { cb.checked = true; cb.disabled = true; }
      cb.addEventListener('change', () => { if (cb.checked) off.delete(i); else off.add(i); paint(`#${id}`); });
      list.appendChild(h('li', { class: `catchup-row${cb.checked ? '' : ' is-off'}` },
        cb,
        h('label', { for: id, class: 'catchup-main' },
          h('span', { class: 'catchup-name' }, mode === 'tasks' ? stepName(s.key) : t(`breakdown.step_${s.key}`)),
          h('span', { class: 'catchup-meta' },
            h('span', {}, fmtMinutes(s.minutes)),
            mode === 'tasks' && s.dueDate ? h('span', {}, t('breakdown.doneBy').replace('{date}', fmtDate(s.dueDate))) : null,
            finalIsTask ? h('span', { class: 'badge badge--outline' }, t('breakdown.thisTask')) : null))));
    });
    body.appendChild(list);
    if (mode === 'tasks') body.appendChild(h('p', { class: 'hint' }, t('breakdown.reuseNote')));
    if (mode === 'tasks' && !group.dueDate) body.appendChild(h('p', { class: 'hint' }, t('breakdown.noDueNote')));

    const chosen = steps.map((s, i) => ({ ...s, i })).filter((s) => !off.has(s.i) || (mode === 'tasks' && s.isLast && reuse));
    const creating = mode === 'tasks' ? chosen.filter((s) => !(s.isLast && reuse)).length : chosen.length;
    api.setActions([
      { label: t('common.cancel'), onClick: (a) => a.close() },
      {
        label: mode === 'tasks' ? tCount('breakdown.createTasks', creating) : tCount('breakdown.addChecklist', creating),
        variant: 'primary',
        onClick: async (a) => {
          if (!creating) return;
          a.setBusy(true);
          try {
            if (mode === 'checklist') {
              const existing = await listSubtasks(root.id).catch(() => []);
              let order = existing.length;
              for (const s of chosen) {
                // eslint-disable-next-line no-await-in-loop
                await insertSubtask(root.id, app().userId, { title: t(`breakdown.step_${s.key}`) }, order);
                order += 1;
              }
            } else {
              const planDate = canLeaveUnscheduled() ? null : today;
              for (const s of chosen) {
                if (s.isLast) {
                  // The task itself is the final step: keep its name and due date, take the last share of time.
                  // eslint-disable-next-line no-await-in-loop
                  await updateTask(root.id, { minutes_requested: Math.min(1440, s.minutes) }, { refresh: false });
                  continue;
                }
                // eslint-disable-next-line no-await-in-loop
                await createTask(app().userId, {
                  planDate,
                  fields: {
                    name: stepName(s.key).slice(0, 200),
                    minutes_requested: Math.min(1440, s.minutes),
                    due_date: s.dueDate,
                    priority: root.priority || 'medium',
                    course_id: root.course_id || null,
                    project_id: root.project_id || null,
                    goal_id: root.goal_id || null,
                    space_id: root.space_id || null,
                    tags: Array.isArray(root.tags) ? root.tags : [],
                  },
                });
              }
            }
            a.close(true);
            toast(mode === 'tasks' ? tCount('breakdown.createdTasks', creating) : tCount('breakdown.addedChecklist', creating), { kind: 'success' });
            if (onDone) onDone();
          } catch (err) {
            console.error('Breakdown failed', err);
            a.setBusy(false);
            toast(t('v3.saveError'), { kind: 'error' });
          }
        },
      },
    ]);
    if (focusSel) body.querySelector(focusSel)?.focus();
  }
  paint();
}
