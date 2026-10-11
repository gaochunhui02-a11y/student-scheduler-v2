// Goal, goal-milestone and check-in editors (V4-C) — side drawers, like
// projects. Deleting a goal is confirmed and explains that linked tasks,
// projects and routines are kept.

import { openDrawer, confirmAction } from '../ui/drawer.js';
import { h } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { t } from '../shared/i18n.js';
import { app } from '../app/context.js';
import { todayStr } from '../shared/dates.js';
import { GOAL_STATUSES, validateGoalFields, validateGoalMilestoneFields, validateCheckIn, formatValue } from './goalModel.js';
import { createGoal, updateGoal, deleteGoal, createGoalMilestone, updateGoalMilestone, deleteGoalMilestone, addCheckIn } from './goalsData.js';
import { updateProject } from '../projects/projectsData.js';
import { spaceSelect, defaultSpaceForNew } from '../workspace/spaceField.js';

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

const val = (v) => (v === null || v === undefined ? '' : String(v));

export function openGoalEditor({ goal = null, onSaved, onDeleted } = {}) {
  const isNew = !goal;
  openDrawer({
    title: isNew ? t('goals.newTitle') : t('goals.editTitle'),
    render: (body) => {
      body.appendChild(field('ge-title', 'goals.fieldTitle', h('input', { type: 'text', id: 'ge-title', maxlength: '120', autocomplete: 'off', 'data-autofocus': true, value: goal ? goal.title : '', placeholder: t('goals.titlePlaceholder') })));
      const desc = h('textarea', { id: 'ge-desc', rows: '2', maxlength: '5000', placeholder: t('goals.descPlaceholder') });
      desc.value = goal ? goal.description || '' : '';
      body.appendChild(field('ge-desc', 'goals.fieldWhy', desc));

      // How progress is measured — the one decision that matters.
      const mode = h('select', { id: 'ge-mode' },
        h('option', { value: 'auto' }, t('goals.mode_auto')),
        h('option', { value: 'numeric' }, t('goals.mode_numeric')),
        h('option', { value: 'manual' }, t('goals.mode_manual')));
      mode.value = goal ? goal.progress_mode : 'auto';
      body.appendChild(field('ge-mode', 'goals.fieldMode', mode, { hint: t('goals.modeHint_auto') }));
      const modeHint = body.querySelector('#ge-mode-hint');

      const numeric = h('div', { class: 'field-grid goal-numeric' });
      numeric.appendChild(field('ge-start-value', 'goals.fieldStartValue', h('input', { type: 'number', id: 'ge-start-value', step: 'any', inputmode: 'decimal', value: goal ? val(goal.start_value) : '0' })));
      numeric.appendChild(field('ge-target-value', 'goals.fieldTargetValue', h('input', { type: 'number', id: 'ge-target-value', step: 'any', inputmode: 'decimal', value: goal ? val(goal.target_value) : '' })));
      numeric.appendChild(field('ge-unit', 'goals.fieldUnit', h('input', { type: 'text', id: 'ge-unit', maxlength: '24', autocomplete: 'off', placeholder: t('goals.unitPlaceholder'), value: goal ? goal.unit || '' : '' })));
      const agg = h('select', { id: 'ge-aggregate' },
        h('option', { value: 'sum' }, t('goals.aggregate_sum')),
        h('option', { value: 'latest' }, t('goals.aggregate_latest')));
      agg.value = goal && goal.aggregate === 'latest' ? 'latest' : 'sum';
      numeric.appendChild(field('ge-aggregate', 'goals.fieldAggregate', agg));
      body.appendChild(numeric);
      const manualField = field('ge-manual', 'goals.fieldManual', h('input', { type: 'number', id: 'ge-manual', min: '0', max: '100', step: '5', inputmode: 'numeric', value: goal && goal.manual_progress !== null && goal.manual_progress !== undefined ? String(goal.manual_progress) : '' }));
      body.appendChild(manualField);
      const syncMode = () => {
        numeric.hidden = mode.value !== 'numeric';
        manualField.hidden = mode.value !== 'manual';
        modeHint.textContent = t(`goals.modeHint_${mode.value}`);
      };
      mode.addEventListener('change', syncMode);
      syncMode();

      const grid = h('div', { class: 'field-grid' });
      grid.appendChild(field('ge-start', 'goals.fieldStart', h('input', { type: 'date', id: 'ge-start', value: goal ? goal.start_date || '' : (isNew ? todayStr() : '') })));
      grid.appendChild(field('ge-target', 'goals.fieldTarget', h('input', { type: 'date', id: 'ge-target', value: goal ? goal.target_date || '' : '' })));
      if (!isNew) {
        const st = h('select', { id: 'ge-status' });
        GOAL_STATUSES.forEach((s) => st.appendChild(h('option', { value: s }, t(`goals.status_${s}`))));
        st.value = goal.status;
        grid.appendChild(field('ge-status', 'goals.fieldStatus', st));
      }
      body.appendChild(grid);
      const space = spaceSelect('ge-space', goal ? goal.space_id : defaultSpaceForNew());
      if (space) body.appendChild(field('ge-space', 'spaces.field', space));
      body.appendChild(h('p', { class: 'field-error', id: 'ge-form-error', role: 'alert' }));
    },
    actions: [
      ...(isNew ? [] : [{
        label: t('common.delete'),
        variant: 'danger',
        start: true,
        onClick: async (api) => {
          const ok = await confirmAction({
            title: t('goals.deleteTitle').replace('{name}', goal.title),
            message: t('goals.deleteBody'),
            confirmLabel: t('goals.deleteConfirm'),
            danger: true,
          });
          if (!ok) return;
          try {
            await deleteGoal(goal.id);
            api.close(true);
            toast(t('goals.deleted'));
            if (onDeleted) onDeleted();
          } catch (err) {
            console.error('Could not delete goal', err);
            toast(t('v3.deleteError'), { kind: 'error' });
          }
        },
      }]),
      { label: t('common.cancel'), variant: 'secondary', onClick: (api) => api.close() },
      {
        label: isNew ? t('goals.create') : t('common.save'),
        variant: 'primary',
        onClick: async (api, btn) => {
          const b = api.body;
          const q = (s) => b.querySelector(s);
          const v = validateGoalFields({
            title: q('#ge-title').value,
            description: q('#ge-desc').value,
            status: q('#ge-status') ? q('#ge-status').value : (goal ? goal.status : 'active'),
            start_date: q('#ge-start').value,
            target_date: q('#ge-target').value,
            progress_mode: q('#ge-mode').value,
            start_value: q('#ge-start-value').value,
            target_value: q('#ge-target-value').value,
            unit: q('#ge-unit').value,
            aggregate: q('#ge-aggregate').value,
            manual_progress: q('#ge-manual').value,
            space_id: q('#ge-space') ? q('#ge-space').value : (goal ? goal.space_id : null),
          });
          showErrors(b, { 'ge-title': v.errors.title, 'ge-target': v.errors.target_date, 'ge-start-value': v.errors.start_value, 'ge-target-value': v.errors.target_value, 'ge-manual': v.errors.manual_progress });
          if (!v.ok) {
            b.querySelector('[aria-invalid="true"]')?.focus();
            return;
          }
          if (!q('#ge-space')) delete v.fields.space_id;
          btn.textContent = t('common.saving');
          api.setBusy(true);
          try {
            const saved = isNew ? await createGoal(app().userId, v.fields) : await updateGoal(goal.id, v.fields);
            api.close(true);
            toast(isNew ? t('goals.created') : t('common.savedShort'), { kind: 'success' });
            if (onSaved) onSaved(saved);
          } catch (err) {
            console.error('Could not save goal', err);
            q('#ge-form-error').textContent = t('v3.saveError');
            btn.textContent = isNew ? t('goals.create') : t('common.save');
            api.setBusy(false);
          }
        },
      },
    ],
  });
}

export function openGoalMilestoneEditor({ goalId, milestone = null, onSaved } = {}) {
  const isNew = !milestone;
  openDrawer({
    title: isNew ? t('goals.newMilestone') : t('goals.editMilestone'),
    size: 'narrow',
    render: (body) => {
      body.appendChild(field('gm-title', 'goals.fieldMilestoneTitle', h('input', { type: 'text', id: 'gm-title', maxlength: '120', autocomplete: 'off', 'data-autofocus': true, value: milestone ? milestone.title : '', placeholder: t('goals.milestonePlaceholder') })));
      body.appendChild(field('gm-due', 'goals.fieldMilestoneDue', h('input', { type: 'date', id: 'gm-due', value: milestone ? milestone.due_date || '' : '' })));
    },
    actions: [
      ...(isNew ? [] : [{
        label: t('common.delete'),
        variant: 'danger',
        start: true,
        onClick: async (api) => {
          const ok = await confirmAction({ title: t('goals.deleteMilestoneTitle'), message: t('goals.deleteMilestoneBody'), confirmLabel: t('common.delete'), danger: true });
          if (!ok) return;
          try {
            await deleteGoalMilestone(milestone.id);
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
        label: isNew ? t('goals.addMilestone') : t('common.save'),
        variant: 'primary',
        onClick: async (api) => {
          const b = api.body;
          const v = validateGoalMilestoneFields({ title: b.querySelector('#gm-title').value, due_date: b.querySelector('#gm-due').value });
          showErrors(b, { 'gm-title': v.errors.title });
          if (!v.ok) {
            b.querySelector('#gm-title').focus();
            return;
          }
          api.setBusy(true);
          try {
            if (isNew) await createGoalMilestone(app().userId, goalId, v.fields);
            else await updateGoalMilestone(milestone.id, v.fields);
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

/** Numeric goals: record a check-in ("+1 book", "5.5 km"). */
export function openCheckInEditor({ goal, current, onSaved } = {}) {
  const today = todayStr();
  const sum = goal.aggregate !== 'latest';
  openDrawer({
    title: t('goals.checkInTitle'),
    subtitle: goal.title,
    size: 'narrow',
    render: (body) => {
      const hint = sum ? t('goals.checkInHintSum') : t('goals.checkInHintLatest');
      const unit = goal.unit ? ` (${goal.unit})` : '';
      const label = h('label', { for: 'gc-value' }, `${t(sum ? 'goals.fieldAmount' : 'goals.fieldValue')}${unit}`);
      const input = h('input', { type: 'number', id: 'gc-value', step: 'any', inputmode: 'decimal', 'data-autofocus': true, value: sum ? '1' : formatValue(current), 'aria-describedby': 'gc-value-hint gc-value-error' });
      body.appendChild(h('div', { class: 'field' }, label, input,
        h('p', { class: 'field-hint', id: 'gc-value-hint' }, hint),
        h('p', { class: 'field-error', id: 'gc-value-error', role: 'alert' })));
      body.appendChild(field('gc-date', 'goals.fieldCheckInDate', h('input', { type: 'date', id: 'gc-date', max: today, value: today })));
      body.appendChild(field('gc-note', 'goals.fieldNote', h('input', { type: 'text', id: 'gc-note', maxlength: '500', autocomplete: 'off' })));
    },
    actions: [
      { label: t('common.cancel'), variant: 'secondary', onClick: (api) => api.close() },
      {
        label: t('goals.checkInSave'),
        variant: 'primary',
        onClick: async (api) => {
          const b = api.body;
          const v = validateCheckIn({ value: b.querySelector('#gc-value').value, logged_on: b.querySelector('#gc-date').value, note: b.querySelector('#gc-note').value }, today);
          showErrors(b, { 'gc-value': v.errors.value, 'gc-date': v.errors.logged_on });
          if (!v.ok) {
            b.querySelector('[aria-invalid="true"]')?.focus();
            return;
          }
          api.setBusy(true);
          try {
            await addCheckIn(app().userId, goal.id, v.fields);
            api.close(true);
            toast(t('goals.checkInSaved'), { kind: 'success' });
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

/** Links one of the student's existing projects to a goal. */
export function openLinkProjectDialog({ goal, projects, onSaved } = {}) {
  const candidates = projects.filter((p) => p.goal_id !== goal.id && p.status !== 'archived');
  openDrawer({
    title: t('goals.linkProjectTitle'),
    subtitle: goal.title,
    size: 'narrow',
    render: (body) => {
      if (!candidates.length) {
        body.appendChild(h('p', { class: 'muted' }, t('goals.linkProjectNone')));
        return;
      }
      const sel = h('select', { id: 'gl-project', 'data-autofocus': true });
      candidates.forEach((p) => sel.appendChild(h('option', { value: p.id }, p.title)));
      body.appendChild(field('gl-project', 'goals.fieldProject', sel, { hint: t('goals.linkProjectHint') }));
    },
    actions: [
      { label: t('common.cancel'), variant: 'secondary', onClick: (api) => api.close() },
      ...(candidates.length ? [{
        label: t('goals.linkProject'),
        variant: 'primary',
        onClick: async (api) => {
          const id = api.body.querySelector('#gl-project').value;
          api.setBusy(true);
          try {
            await updateProject(id, { goal_id: goal.id });
            api.close(true);
            toast(t('goals.projectLinked'), { kind: 'success' });
            if (onSaved) onSaved();
          } catch (err) {
            console.error(err);
            api.setBusy(false);
            toast(t('v3.saveError'), { kind: 'error' });
          }
        },
      }] : []),
    ],
  });
}
