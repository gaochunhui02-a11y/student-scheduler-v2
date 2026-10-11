// Routine editor (V4-C) — a side drawer. Simple first layer (name, how
// often); time of day, duration, dates, goal, space and notes below.
// Deleting is confirmed and recommends Pause or Archive, because it erases
// the routine's history.

import { openDrawer, confirmAction } from '../ui/drawer.js';
import { h } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { t } from '../shared/i18n.js';
import { app } from '../app/context.js';
import { has } from '../shared/capabilities.js';
import { todayStr, addDays } from '../shared/dates.js';
import { fmtWeekday } from '../ui/format.js';
import { TIMES_OF_DAY, validateRoutineFields } from './routineModel.js';
import { createRoutine, updateRoutine, deleteRoutine } from './routinesData.js';
import { listGoals } from '../goals/goalsData.js';
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

// 2026-10-04 is a Sunday: addDays(SUNDAY, d) is weekday d.
const SUNDAY = '2026-10-04';
export const weekdayShort = (d) => fmtWeekday(addDays(SUNDAY, d), 'short');

export async function openRoutineEditor({ routine = null, defaults = {}, onSaved, onDeleted } = {}) {
  const isNew = !routine;
  const today = todayStr();
  let goals = [];
  if (has('goals')) {
    try {
      goals = (await listGoals(app().userId)).filter((g) => ['active', 'on_hold'].includes(g.status) || (routine && g.id === routine.goal_id) || g.id === defaults.goalId);
    } catch {
      goals = [];
    }
  }
  // New routines can start from a preset (defaults: frequency, days, …).
  const src = routine || { frequency: 'daily', weekly_target: 3, time_of_day: 'anytime', duration_minutes: null, days_of_week: [], ...defaults };
  const days = new Set((src.days_of_week || []).map(Number));

  openDrawer({
    title: isNew ? t('routines.newTitle') : t('routines.editTitle'),
    render: (body) => {
      body.appendChild(field('re-title', 'routines.fieldTitle', h('input', { type: 'text', id: 're-title', maxlength: '120', autocomplete: 'off', 'data-autofocus': true, value: routine ? routine.title : defaults.title || '', placeholder: t('routines.titlePlaceholder') })));

      const freq = h('select', { id: 're-frequency' },
        h('option', { value: 'daily' }, t('routines.freq_daily')),
        h('option', { value: 'days' }, t('routines.freq_days')),
        h('option', { value: 'weekly_count' }, t('routines.freq_weekly_count')));
      freq.value = src.frequency;
      body.appendChild(field('re-frequency', 'routines.fieldFrequency', freq));

      // Weekday toggles (frequency = days)
      const dayWrap = h('div', { class: 'field', id: 're-days-field' });
      dayWrap.appendChild(h('span', { class: 'field-label', id: 're-days-label' }, t('routines.fieldDays')));
      const dayRow = h('div', { class: 'day-toggle-row', role: 'group', 'aria-labelledby': 're-days-label', id: 're-days' });
      [1, 2, 3, 4, 5, 6, 0].forEach((d) => {
        const b = h('button', { type: 'button', class: 'day-toggle', 'aria-pressed': days.has(d) ? 'true' : 'false', 'data-day': String(d) }, weekdayShort(d));
        b.addEventListener('click', () => {
          if (days.has(d)) days.delete(d); else days.add(d);
          b.setAttribute('aria-pressed', days.has(d) ? 'true' : 'false');
        });
        dayRow.appendChild(b);
      });
      dayWrap.appendChild(dayRow);
      dayWrap.appendChild(h('p', { class: 'field-error', id: 're-days-error', role: 'alert' }));
      body.appendChild(dayWrap);

      const weekly = h('input', { type: 'number', id: 're-weekly', min: '1', max: '7', step: '1', inputmode: 'numeric', value: String(src.weekly_target || 3) });
      const weeklyField = field('re-weekly', 'routines.fieldWeekly', weekly, { hint: t('routines.weeklyHint') });
      body.appendChild(weeklyField);
      const sync = () => {
        dayWrap.hidden = freq.value !== 'days';
        weeklyField.hidden = freq.value !== 'weekly_count';
      };
      freq.addEventListener('change', sync);
      sync();

      const grid = h('div', { class: 'field-grid' });
      const tod = h('select', { id: 're-time' });
      TIMES_OF_DAY.forEach((x) => tod.appendChild(h('option', { value: x }, t(`routines.time_${x}`))));
      tod.value = src.time_of_day || 'anytime';
      grid.appendChild(field('re-time', 'routines.fieldTimeOfDay', tod));
      grid.appendChild(field('re-duration', 'routines.fieldDuration', h('input', { type: 'number', id: 're-duration', min: '1', max: '1440', step: '5', inputmode: 'numeric', value: src.duration_minutes ? String(src.duration_minutes) : '' }), { hint: t('routines.durationHint') }));
      body.appendChild(grid);

      if (goals.length) {
        const gs = h('select', { id: 're-goal' }, h('option', { value: '' }, t('goals.noGoal')));
        goals.forEach((g) => gs.appendChild(h('option', { value: g.id }, g.title)));
        gs.value = (routine ? routine.goal_id : defaults.goalId) || '';
        body.appendChild(field('re-goal', 'routines.fieldGoal', gs, { hint: t('routines.goalHint') }));
      }

      const more = h('details', { class: 'disclosure' }, h('summary', {}, t('common.moreOptions')));
      const mb = h('div', { class: 'disclosure-body' });
      const dates = h('div', { class: 'field-grid' });
      dates.appendChild(field('re-start', 'routines.fieldStart', h('input', { type: 'date', id: 're-start', value: routine ? routine.start_date : today })));
      dates.appendChild(field('re-end', 'routines.fieldEnd', h('input', { type: 'date', id: 're-end', value: routine ? routine.end_date || '' : '' })));
      mb.appendChild(dates);
      const space = spaceSelect('re-space', routine ? routine.space_id : defaultSpaceForNew());
      if (space) mb.appendChild(field('re-space', 'spaces.field', space));
      const notes = h('textarea', { id: 're-notes', rows: '2', maxlength: '2000' });
      notes.value = routine ? routine.notes || '' : '';
      mb.appendChild(field('re-notes', 'common.notes', notes));
      more.appendChild(mb);
      if (routine && (routine.end_date || routine.notes)) more.open = true;
      body.appendChild(more);
      body.appendChild(h('p', { class: 'field-error', id: 're-form-error', role: 'alert' }));
    },
    actions: [
      ...(isNew ? [] : [{
        label: t('common.delete'),
        variant: 'danger',
        start: true,
        onClick: async (api) => {
          const ok = await confirmAction({
            title: t('routines.deleteTitle').replace('{name}', routine.title),
            message: t('routines.deleteBody'),
            confirmLabel: t('routines.deleteConfirm'),
            danger: true,
          });
          if (!ok) return;
          try {
            await deleteRoutine(routine.id);
            api.close(true);
            toast(t('routines.deleted'));
            if (onDeleted) onDeleted();
          } catch (err) {
            console.error('Could not delete routine', err);
            toast(t('v3.deleteError'), { kind: 'error' });
          }
        },
      }, {
        label: routine.archived ? t('routines.unarchive') : t('routines.archive'),
        variant: 'secondary',
        start: true,
        onClick: async (api) => {
          try {
            await updateRoutine(routine.id, { archived: !routine.archived });
            api.close(true);
            toast(routine.archived ? t('routines.unarchivedToast') : t('routines.archivedToast'), { kind: 'success' });
            if (onSaved) onSaved();
          } catch (err) {
            console.error(err);
            toast(t('v3.saveError'), { kind: 'error' });
          }
        },
      }]),
      { label: t('common.cancel'), variant: 'secondary', onClick: (api) => api.close() },
      {
        label: isNew ? t('routines.create') : t('common.save'),
        variant: 'primary',
        onClick: async (api, btn) => {
          const b = api.body;
          const q = (s) => b.querySelector(s);
          const v = validateRoutineFields({
            title: q('#re-title').value,
            frequency: q('#re-frequency').value,
            days_of_week: [...days],
            weekly_target: q('#re-weekly').value,
            time_of_day: q('#re-time').value,
            duration_minutes: q('#re-duration').value,
            start_date: q('#re-start').value,
            end_date: q('#re-end').value,
            goal_id: q('#re-goal') ? q('#re-goal').value : (routine ? routine.goal_id : null),
            space_id: q('#re-space') ? q('#re-space').value : (routine ? routine.space_id : null),
            notes: q('#re-notes').value,
          }, today);
          showErrors(b, { 're-title': v.errors.title, 're-weekly': v.errors.weekly_target, 're-duration': v.errors.duration_minutes, 're-end': v.errors.end_date });
          q('#re-days-error').textContent = v.errors.days_of_week ? t(v.errors.days_of_week) : '';
          if (!v.ok) {
            if (v.errors.end_date) q('details.disclosure').open = true;
            if (v.errors.days_of_week && !v.errors.title) q('#re-days .day-toggle')?.focus();
            else b.querySelector('[aria-invalid="true"]')?.focus();
            return;
          }
          if (!q('#re-space')) delete v.fields.space_id;
          if (!q('#re-goal') && !has('goals')) delete v.fields.goal_id;
          btn.textContent = t('common.saving');
          api.setBusy(true);
          try {
            const saved = isNew ? await createRoutine(app().userId, v.fields) : await updateRoutine(routine.id, v.fields);
            api.close(true);
            toast(isNew ? t('routines.created') : t('common.savedShort'), { kind: 'success' });
            if (onSaved) onSaved(saved);
          } catch (err) {
            console.error('Could not save routine', err);
            q('#re-form-error').textContent = t('v3.saveError');
            btn.textContent = isNew ? t('routines.create') : t('common.save');
            api.setBusy(false);
          }
        },
      },
    ],
  });
}
