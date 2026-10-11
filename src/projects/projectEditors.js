// Project and milestone editors (V4-B) — side drawers, like courses and exams.
// Deleting a project is confirmed and explains that its tasks are kept.

import { openDrawer, confirmAction } from '../ui/drawer.js';
import { h } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { t } from '../shared/i18n.js';
import { app } from '../app/context.js';
import { PROJECT_STATUSES, PROJECT_PRIORITIES, validateProjectFields, validateMilestoneFields } from './projectModel.js';
import { createProject, updateProject, deleteProject, createMilestone, updateMilestone, deleteMilestone } from './projectsData.js';
import { spaceSelect, defaultSpaceForNew } from '../workspace/spaceField.js';
import { has } from '../shared/capabilities.js';
import { listGoals } from '../goals/goalsData.js';
import { todayStr } from '../shared/dates.js';
import { PROJECT_TEMPLATE_IDS, buildFromTemplate } from './projectTemplates.js';
import { createTask, canLeaveUnscheduled } from '../tasks/tasksData.js';

function field(id, labelKey, control, { hint = '' } = {}) {
  const wrap = h('div', { class: 'field' });
  wrap.appendChild(h('label', { for: id }, t(labelKey)));
  wrap.appendChild(control);
  if (hint) wrap.appendChild(h('p', { class: 'field-hint', id: `${id}-hint` }, hint));
  wrap.appendChild(h('p', { class: 'field-error', id: `${id}-error`, role: 'alert' }));
  control.setAttribute('aria-describedby', hint ? `${id}-hint ${id}-error` : `${id}-error`);
  return wrap;
}

function showErrors(body, map) {
  Object.entries(map).forEach(([id, key]) => {
    const err = body.querySelector(`#${id}-error`);
    if (err) err.textContent = key ? t(key) : '';
    body.querySelector(`#${id}`)?.setAttribute('aria-invalid', key ? 'true' : 'false');
  });
}

function options(select, values, labelPrefix, current) {
  values.forEach((v) => select.appendChild(h('option', { value: v }, t(`${labelPrefix}${v}`))));
  select.value = current;
  return select;
}

export async function openProjectEditor({ project = null, defaults = {}, onSaved, onDeleted } = {}) {
  const isNew = !project;
  // V4-C: a project can serve one goal.
  let goals = [];
  if (has('goals') && has('goalLinks')) {
    try {
      goals = (await listGoals(app().userId)).filter((g) => ['active', 'on_hold'].includes(g.status) || (project && g.id === project.goal_id) || g.id === defaults.goalId);
    } catch {
      goals = [];
    }
  }
  openDrawer({
    title: isNew ? t('projects.newTitle') : t('projects.editTitle'),
    render: (body) => {
      // V4-H: a new project can start from a template (milestones + tasks).
      if (isNew) {
        const tpl = h('select', { id: 'pe-template' }, h('option', { value: '' }, t('projTpl.blank')));
        PROJECT_TEMPLATE_IDS.forEach((id) => tpl.appendChild(h('option', { value: id }, t(`projTpl.${id}`))));
        tpl.value = defaults.template || '';
        body.appendChild(field('pe-template', 'projTpl.field', tpl, { hint: t('projTpl.hint') }));
        tpl.addEventListener('change', () => {
          const title = body.querySelector('#pe-title');
          if (tpl.value && (!title.value.trim() || title.dataset.fromTemplate === '1')) {
            title.value = t(`projTpl.${tpl.value}`);
            title.dataset.fromTemplate = '1';
          }
          body.querySelector('#pe-template-preview').textContent = tpl.value ? t(`projTpl.${tpl.value}_summary`) : '';
        });
        body.appendChild(h('p', { class: 'field-hint', id: 'pe-template-preview', 'aria-live': 'polite' }));
      }
      body.appendChild(field('pe-title', 'projects.fieldTitle', h('input', { type: 'text', id: 'pe-title', maxlength: '120', autocomplete: 'off', 'data-autofocus': true, value: project ? project.title : '', placeholder: t('projects.titlePlaceholder') })));
      const desc = h('textarea', { id: 'pe-desc', rows: '3', maxlength: '5000', placeholder: t('projects.descPlaceholder') });
      desc.value = project ? project.description || '' : '';
      body.appendChild(field('pe-desc', 'projects.fieldDescription', desc));
      const grid = h('div', { class: 'field-grid' });
      grid.appendChild(field('pe-status', 'projects.fieldStatus', options(h('select', { id: 'pe-status' }), PROJECT_STATUSES, 'projects.status_', project ? project.status : 'active')));
      grid.appendChild(field('pe-priority', 'projects.fieldPriority', options(h('select', { id: 'pe-priority' }), PROJECT_PRIORITIES, 'projects.priority_', project ? project.priority : 'medium')));
      grid.appendChild(field('pe-start', 'projects.fieldStart', h('input', { type: 'date', id: 'pe-start', value: project ? project.start_date || '' : '' })));
      grid.appendChild(field('pe-due', 'projects.fieldDue', h('input', { type: 'date', id: 'pe-due', value: project ? project.due_date || '' : '' })));
      body.appendChild(grid);
      const space = spaceSelect('pe-space', project ? project.space_id : defaultSpaceForNew());
      if (space) body.appendChild(field('pe-space', 'spaces.field', space));
      if (goals.length) {
        const gs = h('select', { id: 'pe-goal' }, h('option', { value: '' }, t('goals.noGoal')));
        goals.forEach((g) => gs.appendChild(h('option', { value: g.id }, g.title)));
        gs.value = (project ? project.goal_id : defaults.goalId) || '';
        body.appendChild(field('pe-goal', 'goals.field', gs));
      }

      const more = h('details', { class: 'disclosure' }, h('summary', {}, t('common.moreOptions')));
      const mb = h('div', { class: 'disclosure-body' });
      mb.appendChild(field('pe-estimate', 'projects.fieldEstimate', h('input', { type: 'number', id: 'pe-estimate', min: '1', step: '15', inputmode: 'numeric', value: project && project.estimated_minutes ? String(project.estimated_minutes) : '' }), { hint: t('projects.estimateHint') }));
      const modeSel = h('select', { id: 'pe-progress-mode' },
        h('option', { value: 'auto' }, t('projects.progressAuto')),
        h('option', { value: 'manual' }, t('projects.progressManual')));
      modeSel.value = project && project.progress_mode === 'manual' ? 'manual' : 'auto';
      mb.appendChild(field('pe-progress-mode', 'projects.fieldProgress', modeSel, { hint: t('projects.progressHint') }));
      const manual = h('input', { type: 'number', id: 'pe-manual', min: '0', max: '100', step: '5', inputmode: 'numeric', value: project && project.manual_progress !== null && project.manual_progress !== undefined ? String(project.manual_progress) : '' });
      const manualField = field('pe-manual', 'projects.fieldManual', manual);
      manualField.hidden = modeSel.value !== 'manual';
      modeSel.addEventListener('change', () => { manualField.hidden = modeSel.value !== 'manual'; });
      mb.appendChild(manualField);
      more.appendChild(mb);
      if (project && (project.estimated_minutes || project.progress_mode === 'manual')) more.open = true;
      body.appendChild(more);
      body.appendChild(h('p', { class: 'field-error', id: 'pe-form-error', role: 'alert' }));
    },
    actions: [
      ...(isNew ? [] : [{
        label: t('common.delete'),
        variant: 'danger',
        start: true,
        onClick: async (api) => {
          const ok = await confirmAction({
            title: t('projects.deleteTitle').replace('{name}', project.title),
            message: t('projects.deleteBody'),
            confirmLabel: t('projects.deleteConfirm'),
            danger: true,
          });
          if (!ok) return;
          try {
            await deleteProject(project.id);
            api.close(true);
            toast(t('projects.deleted'));
            if (onDeleted) onDeleted();
          } catch (err) {
            console.error('Could not delete project', err);
            toast(t('v3.deleteError'), { kind: 'error' });
          }
        },
      }]),
      { label: t('common.cancel'), variant: 'secondary', onClick: (api) => api.close() },
      {
        label: isNew ? t('projects.create') : t('common.save'),
        variant: 'primary',
        onClick: async (api, btn) => {
          const b = api.body;
          const v = validateProjectFields({
            title: b.querySelector('#pe-title').value,
            description: b.querySelector('#pe-desc').value,
            status: b.querySelector('#pe-status').value,
            priority: b.querySelector('#pe-priority').value,
            start_date: b.querySelector('#pe-start').value,
            due_date: b.querySelector('#pe-due').value,
            estimated_minutes: b.querySelector('#pe-estimate').value,
            progress_mode: b.querySelector('#pe-progress-mode').value,
            manual_progress: b.querySelector('#pe-manual').value,
            space_id: b.querySelector('#pe-space') ? b.querySelector('#pe-space').value : (project ? project.space_id : null),
          });
          showErrors(b, { 'pe-title': v.errors.title, 'pe-due': v.errors.due_date, 'pe-estimate': v.errors.estimated_minutes, 'pe-manual': v.errors.manual_progress });
          if (!v.ok) {
            if (v.errors.estimated_minutes || v.errors.manual_progress) b.querySelector('details.disclosure').open = true;
            b.querySelector('[aria-invalid="true"]')?.focus();
            return;
          }
          if (!b.querySelector('#pe-space')) delete v.fields.space_id;
          if (b.querySelector('#pe-goal')) v.fields.goal_id = b.querySelector('#pe-goal').value || null;
          btn.textContent = t('common.saving');
          api.setBusy(true);
          try {
            const saved = isNew ? await createProject(app().userId, v.fields) : await updateProject(project.id, v.fields);
            const tplId = isNew && b.querySelector('#pe-template') ? b.querySelector('#pe-template').value : '';
            if (tplId && saved) await applyProjectTemplate(saved, tplId);
            api.close(true);
            toast(isNew ? t('projects.created') : t('common.savedShort'), { kind: 'success' });
            if (onSaved) onSaved(saved);
          } catch (err) {
            console.error('Could not save project', err);
            b.querySelector('#pe-form-error').textContent = t('v3.saveError');
            btn.textContent = isNew ? t('projects.create') : t('common.save');
            api.setBusy(false);
          }
        },
      },
    ],
  });
}

export function openMilestoneEditor({ projectId, milestone = null, onSaved } = {}) {
  const isNew = !milestone;
  openDrawer({
    title: isNew ? t('projects.newMilestone') : t('projects.editMilestone'),
    size: 'narrow',
    render: (body) => {
      body.appendChild(field('me-title', 'projects.fieldMilestoneTitle', h('input', { type: 'text', id: 'me-title', maxlength: '120', autocomplete: 'off', 'data-autofocus': true, value: milestone ? milestone.title : '', placeholder: t('projects.milestonePlaceholder') })));
      body.appendChild(field('me-due', 'projects.fieldDue', h('input', { type: 'date', id: 'me-due', value: milestone ? milestone.due_date || '' : '' })));
      const desc = h('textarea', { id: 'me-desc', rows: '2', maxlength: '2000' });
      desc.value = milestone ? milestone.description || '' : '';
      body.appendChild(field('me-desc', 'projects.fieldDescriptionOptional', desc));
    },
    actions: [
      ...(isNew ? [] : [{
        label: t('common.delete'),
        variant: 'danger',
        start: true,
        onClick: async (api) => {
          const ok = await confirmAction({ title: t('projects.deleteMilestoneTitle'), message: t('projects.deleteMilestoneBody'), confirmLabel: t('common.delete'), danger: true });
          if (!ok) return;
          try {
            await deleteMilestone(milestone.id);
            api.close(true);
            toast(t('common.deleted'));
            if (onSaved) onSaved();
          } catch (err) {
            console.error(err);
            toast(t('v3.deleteError'), { kind: 'error' });
          }
        },
      }]),
      { label: t('common.cancel'), variant: 'secondary', onClick: (api) => api.close() },
      {
        label: isNew ? t('projects.addMilestone') : t('common.save'),
        variant: 'primary',
        onClick: async (api) => {
          const b = api.body;
          const v = validateMilestoneFields({ title: b.querySelector('#me-title').value, due_date: b.querySelector('#me-due').value, description: b.querySelector('#me-desc').value });
          showErrors(b, { 'me-title': v.errors.title });
          if (!v.ok) {
            b.querySelector('#me-title').focus();
            return;
          }
          api.setBusy(true);
          try {
            if (isNew) await createMilestone(app().userId, projectId, v.fields);
            else await updateMilestone(milestone.id, v.fields);
            api.close(true);
            if (onSaved) onSaved();
          } catch (err) {
            console.error(err);
            api.setBusy(false);
            toast(t('v3.saveError'), { kind: 'error' });
          }
        },
      },
    ],
  });
}

// V4-H: creates a template's milestones and tasks for a new project. Tasks
// start unscheduled (with due dates) so "Plan my backlog" can place them.
async function applyProjectTemplate(project, templateId) {
  const start = project.start_date || todayStr();
  const plan = buildFromTemplate(templateId, start, project.due_date || null);
  const userId = app().userId;
  const milestoneIds = [];
  for (const m of plan.milestones) {
    // eslint-disable-next-line no-await-in-loop
    const row = await createMilestone(userId, project.id, { title: t(`projTpl.${templateId}_${m.key}`), due_date: m.dueDate });
    milestoneIds.push(row.id);
  }
  const planDate = canLeaveUnscheduled() ? null : todayStr();
  let order = 10;
  for (const task of plan.tasks) {
    // eslint-disable-next-line no-await-in-loop
    await createTask(userId, {
      planDate,
      fields: {
        name: t(`projTpl.${templateId}_${task.key}`),
        minutes_requested: task.minutes,
        due_date: task.dueDate,
        project_id: project.id,
        project_milestone_id: milestoneIds[task.milestoneIndex] || null,
        project_sort: order,
        space_id: project.space_id || null,
        goal_id: project.goal_id || null,
      },
    });
    order += 10;
  }
  if (!project.due_date && plan.dueDate) await updateProject(project.id, { due_date: plan.dueDate, start_date: start });
}
