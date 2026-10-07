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
import { todayStr } from '../shared/dates.js';
import { listCourses } from '../academics/academicsData.js';
import { sortCourses } from '../academics/courseModel.js';
import { validateTaskFields } from './taskModel.js';
import { createTask, updateTask, moveTaskToDate, deleteTaskGroup } from './tasksData.js';

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
  const root = task ? task.root : null;
  const planDateInitial = task ? (root.for_date || task.firstDate || todayStr()) : (defaults.planDate || todayStr());
  const sectionHandles = [];

  openDrawer({
    title: isNew ? t('tasks.newTitle') : t('tasks.editTitle'),
    subtitle: isNew ? t('tasks.newSubtitle') : '',
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

      if (courses.length && has('courseLinks')) {
        const select = h('select', { id: 'te-course' }, h('option', { value: '' }, t('tasks.noCourse')));
        courses.forEach((c) => select.appendChild(h('option', { value: c.id }, c.code ? `${c.code} — ${c.name}` : c.name)));
        select.value = (task ? task.courseId : defaults.courseId) || '';
        body.appendChild(field('te-course', 'tasks.fieldCourse', select));
      }

      const more = h('details', { class: 'disclosure' }, h('summary', {}, t('common.moreOptions')));
      const moreBody = h('div', { class: 'disclosure-body' });
      const priority = h('select', { id: 'te-priority' },
        h('option', { value: 'high' }, t('taskFilter.priorityHigh')),
        h('option', { value: 'medium' }, t('taskFilter.priorityMedium')),
        h('option', { value: 'low' }, t('taskFilter.priorityLow')));
      priority.value = root ? root.priority || 'medium' : 'medium';
      const moreGrid = h('div', { class: 'field-grid' });
      moreGrid.appendChild(field('te-plan', 'tasks.fieldPlanDate', plan, { hint: t('tasks.fieldPlanDateHint') }));
      moreGrid.appendChild(field('te-priority', 'tasks.fieldPriority', priority));
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
          sectionHandles.forEach((hd) => { if (hd.collect) Object.assign(fields, hd.collect()); });
          const planDate = body.querySelector('#te-plan').value || todayStr();
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
              if (root.for_date && planDate !== root.for_date) await moveTaskToDate(ctx.userId, root.id, planDate, root.for_date);
              taskId = root.id;
            }
            for (const hd of sectionHandles) {
              // eslint-disable-next-line no-await-in-loop
              if (hd.afterSave) await hd.afterSave(taskId);
            }
            api.close(true);
            toast(isNew ? t('tasks.created') : t('common.savedShort'), { kind: 'success' });
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
