// Create / edit a semester (name, dates, optional breaks, current flag).

import { openDrawer, confirmAction } from '../ui/drawer.js';
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { t } from '../shared/i18n.js';
import { app } from '../app/context.js';
import { todayStr, addDays, startOfWeek } from '../shared/dates.js';
import { validateSemesterFields } from '../academics/semesterModel.js';
import { createSemester, updateSemester, deleteSemester, setCurrentSemester } from '../academics/academicsData.js';

function breakRow(b = {}) {
  const row = h('div', { class: 'break-row' });
  const name = h('input', { type: 'text', class: 'v3-input', maxlength: '80', placeholder: t('semester.breakNamePlaceholder'), value: b.name || '', 'aria-label': t('semester.breakName') });
  const from = h('input', { type: 'date', class: 'v3-input', value: b.start_date || '', 'aria-label': t('semester.breakFrom') });
  const to = h('input', { type: 'date', class: 'v3-input', value: b.end_date || '', 'aria-label': t('semester.breakTo') });
  const del = h('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm', 'aria-label': t('semester.removeBreak') });
  del.innerHTML = icon('trash');
  del.addEventListener('click', () => row.remove());
  row.append(name, from, to, del);
  row.read = () => ({ name: name.value.trim(), start_date: from.value, end_date: to.value });
  return row;
}

export function openSemesterEditor({ semester = null, onSaved } = {}) {
  const ctx = app();
  const isNew = !semester;
  const today = todayStr();
  const defStart = startOfWeek(today);
  openDrawer({
    title: isNew ? t('semester.newTitle') : t('semester.editTitle'),
    subtitle: isNew ? t('semester.newSubtitle') : '',
    render: (body) => {
      body.appendChild(h('div', { class: 'field' }, h('label', { for: 'se-name' }, t('common.name')), h('input', { type: 'text', id: 'se-name', maxlength: '120', 'data-autofocus': true, placeholder: t('semester.namePlaceholder'), value: semester ? semester.name : '', 'aria-describedby': 'se-name-error' }), h('p', { class: 'field-error', id: 'se-name-error', role: 'alert' })));
      const g = h('div', { class: 'field-grid' });
      g.appendChild(h('div', { class: 'field' }, h('label', { for: 'se-start' }, t('semester.startDate')), h('input', { type: 'date', id: 'se-start', value: semester ? semester.start_date : defStart, 'aria-describedby': 'se-start-error' }), h('p', { class: 'field-error', id: 'se-start-error', role: 'alert' })));
      g.appendChild(h('div', { class: 'field' }, h('label', { for: 'se-end' }, t('semester.endDate')), h('input', { type: 'date', id: 'se-end', value: semester ? semester.end_date : addDays(defStart, 16 * 7 - 3), 'aria-describedby': 'se-end-error' }), h('p', { class: 'field-error', id: 'se-end-error', role: 'alert' })));
      body.appendChild(g);
      const current = h('input', { type: 'checkbox', id: 'se-current' });
      current.checked = semester ? Boolean(semester.is_current) : true;
      body.appendChild(h('div', { class: 'field-check' }, current, h('label', { for: 'se-current' }, t('semester.makeCurrent'))));

      const breaks = h('div', { class: 'stack-sm', id: 'se-breaks' });
      (semester && Array.isArray(semester.breaks) ? semester.breaks : []).forEach((b) => breaks.appendChild(breakRow(b)));
      const add = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' });
      add.innerHTML = `${icon('plus')}<span></span>`;
      add.querySelector('span').textContent = t('semester.addBreak');
      add.addEventListener('click', () => {
        const row = breakRow();
        breaks.appendChild(row);
        row.querySelector('input').focus();
      });
      const breaksField = h('div', { class: 'field' }, h('span', { class: 'field-label' }, t('semester.breaks')), h('p', { class: 'field-hint' }, t('semester.breaksHint')), breaks, h('div', {}, add), h('p', { class: 'field-error', id: 'se-breaks-error', role: 'alert' }));
      body.appendChild(breaksField);
      body.appendChild(h('p', { class: 'field-error', id: 'se-form-error', role: 'alert' }));
    },
    actions: [
      ...(isNew ? [] : [{
        label: t('common.delete'),
        variant: 'danger',
        start: true,
        onClick: async (api) => {
          const ok = await confirmAction({ title: t('semester.deleteTitle'), message: t('semester.deleteBody'), confirmLabel: t('common.delete'), danger: true });
          if (!ok) return;
          try {
            await deleteSemester(semester.id);
            api.close(true);
            toast(t('common.deleted'));
            if (onSaved) onSaved(null);
          } catch (err) {
            console.error(err);
            toast(t('v3.deleteError'), { kind: 'error' });
          }
        },
      }]),
      { label: t('common.cancel'), variant: 'secondary', onClick: (api) => api.close() },
      {
        label: isNew ? t('semester.create') : t('common.save'),
        variant: 'primary',
        onClick: async (api) => {
          const b = api.body;
          const input = {
            name: b.querySelector('#se-name').value,
            start_date: b.querySelector('#se-start').value,
            end_date: b.querySelector('#se-end').value,
            breaks: [...b.querySelectorAll('.break-row')].map((r) => r.read()).filter((x) => x.name || x.start_date || x.end_date),
          };
          const { ok, fields, errors } = validateSemesterFields(input);
          [['se-name', 'name'], ['se-start', 'start_date'], ['se-end', 'end_date'], ['se-breaks', 'breaks']].forEach(([id, key]) => {
            const el = b.querySelector(`#${id}-error`);
            if (el) el.textContent = errors[key] ? t(errors[key]) : '';
          });
          if (!ok) return;
          const makeCurrent = b.querySelector('#se-current').checked;
          api.setBusy(true);
          try {
            const saved = isNew ? await createSemester(ctx.userId, fields) : await updateSemester(semester.id, fields);
            if (makeCurrent) await setCurrentSemester(ctx.userId, saved.id);
            else if (!isNew && semester.is_current) await updateSemester(saved.id, { is_current: false });
            api.close(true);
            toast(isNew ? t('semester.created') : t('common.savedShort'), { kind: 'success' });
            if (onSaved) onSaved(saved);
          } catch (err) {
            console.error('Could not save semester', err);
            b.querySelector('#se-form-error').textContent = t('v3.saveError');
            api.setBusy(false);
          }
        },
      },
    ],
  });
}
