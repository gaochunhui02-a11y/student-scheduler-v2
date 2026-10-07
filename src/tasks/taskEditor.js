// Create / edit a task in a side drawer. Simple first layer (name, time
// needed, due date, course); everything else lives under "More options".
// Other V3 modules can contribute extra sections (dependencies, links,
// recurrence) through registerTaskEditorSection().

import { openDrawer, confirmAction } from '../ui/drawer.js';
import { h } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { t } from '../shared/i18n.js';
import { app } from '../app/context.js';
import { has } from '../shared/capabilities.js';
import { todayStr, clockToMinutes } from '../shared/dates.js';
import { fmtClockStr } from '../ui/format.js';
import { listCourses } from '../academics/academicsData.js';
import { sortCourses } from '../academics/courseModel.js';
import { validateTaskFields } from './taskModel.js';
import { createTask, updateTask, moveTaskToDate, deleteTaskGroup, unscheduleTask, canLeaveUnscheduled } from './tasksData.js';
import { validateTaskSchedule } from './taskModel.js';
import { spaceSelect, defaultSpaceForNew } from '../workspace/spaceField.js';
import { listProjects, listMilestones } from '../projects/projectsData.js';
import { SETTABLE_STATUSES, universalStatus, overrideForStatus } from './universalStatus.js';
import { pinStudyBlock, taskHasBlockOn } from '../planner/pinBlock.js';

const extraSections = [];

// section = { id, render(container, { task, isNew }) => { collect?(): object, afterSave?(taskId): Promise } }
export function registerTaskEditorSection(section) {
  if (!extraSections.some((s) => s.id === section.id)) extraSections.push(section);
}

function field(id, labelKey, control, { hint = '', span = false } = {}) {
  const wrap = h('div', { class: `field${span ? ' field-span' : ''}` });
  wrap.appendChild(h('label', { for: id }, t(labelKey)));
  wrap.appendChild(control);
  if (hint) wrap.appendChild(h('p', { class: 'field-hint', id: `${id}-hint` }, hint));
  wrap.appendChild(h('p', { class: 'field-error', id: `${id}-error`, role: 'alert' }));
  if (hint) control.setAttribute('aria-describedby', `${id}-hint ${id}-error`);
  else control.setAttribute('aria-describedby', `${id}-error`);
  return wrap;
}

function setError(body, id, key) {
  const input = body.querySelector(`#${id}`);
  const err = body.querySelector(`#${id}-error`);
  if (err) err.textContent = key ? t(key) : '';
  if (input) input.setAttribute('aria-invalid', key ? 'true' : 'false');
}

/**
 * @param {object} opts
 * @param {object|null} opts.task     a task group from taskModel (edit) or null (create)
 * @param {object} [opts.defaults]    { courseId, dueDate, planDate, name, minutes }
 * @param {Function} [opts.onSaved]
 */
export async function openTaskEditor({ task = null, defaults = {}, onSaved } = {}) {
  const ctx = app();
  const isNew = !task;
  let courses = [];
  if (has('courses')) {
    try {
      courses = sortCourses((await listCourses(ctx.userId)).filter((c) => !c.archived || (task && c.id === task.courseId)));
    } catch {
      courses = [];
    }
  }
  // V4-B: projects and their milestones (only when the database has them).
  let projects = [];
  let milestones = [];
  if (has('projects') && has('projectLinks')) {
    try {
      [projects, milestones] = await Promise.all([listProjects(ctx.userId), listMilestones(ctx.userId)]);
      projects = projects.filter((p) => p.status !== 'archived' || (task && p.id === task.projectId));
    } catch {
      projects = [];
    }
  }
  const v4Fields = has('taskFieldsV4');
  const root = task ? task.root : null;
  // V4-B.1: the scheduled (planned) date is optional. A new task starts
  // unscheduled unless a caller passes a day; without migration 0021 a day
  // is still required, exactly as in V3.
  const backlogOk = canLeaveUnscheduled();
  const planDateInitial = task
    ? (task.scheduledDate || (backlogOk ? '' : root.for_date || task.firstDate || todayStr()))
    : (defaults.planDate || (backlogOk ? '' : todayStr()));
  const sectionHandles = [];

  openDrawer({
    title: isNew ? t('tasks.newTitle') : t('tasks.editTitle'),
    subtitle: isNew ? t(backlogOk ? 'tasks.newSubtitle' : 'tasks.newSubtitleDay') : '',
    render: (body) => {
      const name = h('input', { type: 'text', id: 'te-name', maxlength: '200', autocomplete: 'off', 'data-autofocus': true, value: root ? root.name : defaults.name || '' });
      const minutes = h('input', { type: 'number', id: 'te-minutes', min: '5', max: '1440', step: '5', inputmode: 'numeric', value: String(root ? root.minutes_requested : defaults.minutes || 60) });
      const due = h('input', { type: 'date', id: 'te-due', value: root ? root.due_date || '' : defaults.dueDate || '' });
      const plan = h('input', { type: 'date', id: 'te-plan', value: planDateInitial });

      body.appendChild(field('te-name', 'tasks.fieldName', name));
      const grid = h('div', { class: 'field-grid' });
      grid.appendChild(field('te-minutes', 'tasks.fieldMinutes', minutes));
      grid.appendChild(field('te-due', 'tasks.fieldDue', due));
      body.appendChild(grid);

      // Scheduled date (when to work on it) — separate from the due date.
      const planWrap = h('div', { class: 'te-plan-row' }, plan,
        h('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-action': 'plan-today' }, t('tasks.planToday')));
      body.appendChild(field('te-plan', backlogOk ? 'tasks.fieldScheduled' : 'tasks.fieldPlanDate', planWrap, {
        hint: backlogOk ? t('tasks.fieldScheduledHint') : t('tasks.fieldPlanDateHint'),
      }));
      // The describedby belongs on the date input, not its wrapper.
      plan.setAttribute('aria-describedby', planWrap.getAttribute('aria-describedby'));
      planWrap.removeAttribute('aria-describedby');
      planWrap.querySelector('[data-action="plan-today"]').addEventListener('click', () => {
        plan.value = todayStr();
        plan.dispatchEvent(new Event('change'));
        plan.focus();
      });
      if (!backlogOk) plan.required = true;

      // Course and project side by side; a task needs neither.
      const where = h('div', { class: 'field-grid' });
      if (courses.length && has('courseLinks')) {
        const select = h('select', { id: 'te-course' }, h('option', { value: '' }, t('tasks.noCourse')));
        courses.forEach((c) => select.appendChild(h('option', { value: c.id }, c.code ? `${c.code} — ${c.name}` : c.name)));
        select.value = (task ? task.courseId : defaults.courseId) || '';
        where.appendChild(field('te-course', 'tasks.fieldCourse', select));
      }
      if (projects.length) {
        const select = h('select', { id: 'te-project' }, h('option', { value: '' }, t('tasks.noProject')));
        projects.forEach((p) => select.appendChild(h('option', { value: p.id }, p.title)));
        select.value = (task ? task.projectId : defaults.projectId) || '';
        where.appendChild(field('te-project', 'tasks.fieldProject', select));
      }
      if (where.childElementCount) body.appendChild(where);
      // V4: a task's own space; empty = follow its course's space.
      const space = spaceSelect('te-space', task ? task.spaceId : (defaults.spaceId || (defaults.courseId ? '' : defaultSpaceForNew())), 'spaces.fromCourse');
      if (space) body.appendChild(field('te-space', 'spaces.field', space, { hint: t('spaces.taskHint') }));

      const more = h('details', { class: 'disclosure' }, h('summary', {}, t('common.moreOptions')));
      const moreBody = h('div', { class: 'disclosure-body' });
      const priority = h('select', { id: 'te-priority' },
        h('option', { value: 'high' }, t('taskFilter.priorityHigh')),
        h('option', { value: 'medium' }, t('taskFilter.priorityMedium')),
        h('option', { value: 'low' }, t('taskFilter.priorityLow')));
      priority.value = root ? root.priority || 'medium' : 'medium';
      const moreGrid = h('div', { class: 'field-grid' });
      moreGrid.appendChild(field('te-priority', 'tasks.fieldPriority', priority));
      if (v4Fields) {
        moreGrid.appendChild(field('te-due-time', 'tasks.fieldDueTime', h('input', { type: 'time', id: 'te-due-time', value: task ? task.dueTime || '' : '' })));
        moreGrid.appendChild(field('te-start', 'tasks.fieldStartTime', h('input', { type: 'time', id: 'te-start', value: task ? task.startTime || '' : '' }), { hint: t('tasks.fieldStartTimeHint') }));
        const status = h('select', { id: 'te-status' });
        const current = task ? universalStatus(task) : 'todo';
        if (current === 'done' || current === 'missed') status.appendChild(h('option', { value: current }, t(`tasks.status_${current}`)));
        SETTABLE_STATUSES.forEach((s) => status.appendChild(h('option', { value: s }, t(`tasks.status_${s}`))));
        status.value = current;
        if (current === 'done') status.disabled = true;
        moreGrid.appendChild(field('te-status', 'tasks.fieldStatus', status, current === 'done' ? { hint: t('tasks.statusDoneHint') } : {}));
      }
      if (projects.length) {
        const msSel = h('select', { id: 'te-milestone' });
        const fillMilestones = (projectId, selected) => {
          msSel.innerHTML = '';
          msSel.appendChild(h('option', { value: '' }, t('tasks.noMilestone')));
          milestones.filter((m) => m.project_id === projectId).forEach((m) => msSel.appendChild(h('option', { value: m.id }, m.title)));
          msSel.value = selected || '';
          msSel.closest('.field') && (msSel.closest('.field').hidden = !projectId);
        };
        const msField = field('te-milestone', 'tasks.fieldMilestone', msSel);
        moreGrid.appendChild(msField);
        const projSel = body.querySelector('#te-project');
        fillMilestones(projSel ? projSel.value : '', task ? task.milestoneId : defaults.milestoneId);
        msField.hidden = !(projSel && projSel.value);
        if (projSel) projSel.addEventListener('change', () => fillMilestones(projSel.value, ''));
      }
      moreBody.appendChild(moreGrid);
      const notes = h('textarea', { id: 'te-notes', rows: '3', maxlength: '5000' });
      notes.value = root ? root.notes || '' : '';
      moreBody.appendChild(field('te-notes', 'common.notes', notes));
      extraSections.forEach((section) => {
        const container = h('div', { class: 'stack-sm' });
        const handle = section.render(container, { task, isNew }) || {};
        sectionHandles.push(handle);
        moreBody.appendChild(container);
      });
      more.appendChild(moreBody);
      if (!isNew) more.open = true;
      body.appendChild(more);
      body.appendChild(h('p', { class: 'field-error', id: 'te-form-error', role: 'alert' }));
    },
    actions: [
      ...(isNew ? [] : [{
        label: t('common.delete'),
        variant: 'danger',
        start: true,
        onClick: async (api) => {
          const ok = await confirmAction({ title: t('tasks.deleteTitle'), message: t('tasks.deleteBody').replace('{name}', task.name), confirmLabel: t('common.delete'), danger: true });
          if (!ok) return;
          try {
            await deleteTaskGroup(task.rowIds);
            api.close(true);
            toast(t('common.deleted'));
            if (onSaved) onSaved(null);
          } catch (err) {
            console.error('Could not delete task', err);
            toast(t('v3.deleteError'), { kind: 'error' });
          }
        },
      }]),
      { label: t('common.cancel'), variant: 'secondary', onClick: (api) => api.close() },
      {
        label: isNew ? t('tasks.create') : t('common.save'),
        variant: 'primary',
        onClick: async (api, btn) => {
          const body = api.body;
          const values = {
            name: body.querySelector('#te-name').value,
            minutes_requested: body.querySelector('#te-minutes').value,
            due_date: body.querySelector('#te-due').value || null,
            priority: body.querySelector('#te-priority').value,
            notes: body.querySelector('#te-notes').value,
          };
          const { ok, fields, errors } = validateTaskFields(values);
          ['te-name', 'te-minutes', 'te-due'].forEach((id) => setError(body, id, null));
          setError(body, 'te-name', errors.name);
          setError(body, 'te-minutes', errors.minutes_requested);
          setError(body, 'te-due', errors.due_date);
          if (!ok) {
            body.querySelector('[aria-invalid="true"]')?.focus();
            return;
          }
          const courseSel = body.querySelector('#te-course');
          if (courseSel) fields.course_id = courseSel.value || null;
          const spaceSel = body.querySelector('#te-space');
          if (spaceSel) fields.space_id = spaceSel.value || null;
          const projectSel = body.querySelector('#te-project');
          if (projectSel) {
            fields.project_id = projectSel.value || null;
            const msSel = body.querySelector('#te-milestone');
            fields.project_milestone_id = fields.project_id && msSel ? msSel.value || null : null;
          }
          let startTime = null;
          if (v4Fields) {
            fields.due_time = body.querySelector('#te-due-time').value || null;
            startTime = body.querySelector('#te-start').value || null;
            fields.start_time = startTime;
            const st = body.querySelector('#te-status');
            if (!st.disabled && st.value !== 'missed') fields.status_override = overrideForStatus(st.value);
          }
          sectionHandles.forEach((hd) => { if (hd.collect) Object.assign(fields, hd.collect()); });
          // V4-B.1: no date = unscheduled; a start time needs a date (never today by default).
          const sched = validateTaskSchedule({ planDate: body.querySelector('#te-plan').value, startTime });
          setError(body, 'te-plan', null);
          if (!sched.ok) {
            setError(body, 'te-plan', sched.error);
            body.querySelector('#te-plan').focus();
            return;
          }
          if (!sched.planDate && !backlogOk) {
            setError(body, 'te-plan', 'tasks.errDateRequired');
            body.querySelector('#te-plan').focus();
            return;
          }
          const planDate = sched.planDate;
          const formErr = body.querySelector('#te-form-error');
          formErr.textContent = '';
          btn.textContent = t('common.saving');
          api.setBusy(true);
          try {
            let taskId;
            if (isNew) {
              const row = await createTask(ctx.userId, { planDate, fields });
              taskId = row.id;
            } else {
              await updateTask(root.id, fields, { planDate: root.for_date });
              const oldDate = task.scheduledDate || null;
              if (planDate !== oldDate) {
                if (planDate) await moveTaskToDate(ctx.userId, root.id, planDate, oldDate);
                else await unscheduleTask(root.id, oldDate);
              }
              taskId = root.id;
            }
            for (const hd of sectionHandles) {
              // eslint-disable-next-line no-await-in-loop
              if (hd.afterSave) await hd.afterSave(taskId, { fields, planDate });
            }
            // V4-B: a start time pins a study block at that time on the planned
            // day (once — not if the task already has a block that day).
            let pinNote = null;
            if (startTime && planDate && (isNew || startTime !== task.startTime || planDate !== (task.scheduledDate || null))) {
              const start = clockToMinutes(startTime);
              const minutes = Math.min(Number(fields.minutes_requested) || 30, 240);
              if (start !== null && start + minutes <= 1440 && !(await taskHasBlockOn(taskId, planDate, ctx.userId).catch(() => true))) {
                const res = await pinStudyBlock({ userId: ctx.userId, date: planDate, start, minutes, name: fields.name, taskId }).catch(() => ({ ok: false, clash: '' }));
                pinNote = res.ok ? t('tasks.pinnedAt').replace('{time}', fmtClockStr(startTime)) : t('tasks.pinFailed').replace('{time}', fmtClockStr(startTime)).replace('{name}', res.clash || '—');
              }
            }
            api.close(true);
            toast(pinNote || (isNew ? t('tasks.created') : t('common.savedShort')), { kind: 'success' });
            if (onSaved) onSaved(taskId);
          } catch (err) {
            console.error('Could not save task', err);
            formErr.textContent = t('v3.saveError');
            btn.textContent = isNew ? t('tasks.create') : t('common.save');
            api.setBusy(false);
          }
        },
      },
    ],
  });
}
