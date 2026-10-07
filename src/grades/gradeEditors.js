// Drawers for grade categories and graded items.

import { openDrawer, confirmAction } from '../ui/drawer.js';
import { h } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { t } from '../shared/i18n.js';
import { app } from '../app/context.js';
import { validateCategoryFields, validateGradeItemFields } from './gradeModel.js';
import { createCategory, updateCategory, deleteCategory, createGradeItem, updateGradeItem, deleteGradeItem } from './gradesData.js';

function field(id, labelKey, control, hint = '') {
  control.setAttribute('aria-describedby', `${id}-error${hint ? ` ${id}-hint` : ''}`);
  return h('div', { class: 'field' },
    h('label', { for: id }, t(labelKey)),
    control,
    hint ? h('p', { class: 'field-hint', id: `${id}-hint` }, hint) : null,
    h('p', { class: 'field-error', id: `${id}-error`, role: 'alert' }));
}

function showErrors(body, map) {
  Object.entries(map).forEach(([id, key]) => {
    const el = body.querySelector(`#${id}-error`);
    if (el) el.textContent = key ? t(key) : '';
    body.querySelector(`#${id}`)?.setAttribute('aria-invalid', key ? 'true' : 'false');
  });
}

export function openCategoryEditor({ course, category = null, nextSortOrder = 0, onSaved }) {
  const isNew = !category;
  openDrawer({
    title: isNew ? t('grades.newCategory') : t('grades.editCategory'),
    subtitle: course.name,
    size: 'narrow',
    render: (body) => {
      body.appendChild(field('gc-name', 'common.name', h('input', { type: 'text', id: 'gc-name', maxlength: '80', 'data-autofocus': true, value: category ? category.name : '', placeholder: t('grades.categoryPlaceholder') })));
      body.appendChild(field('gc-weight', 'grades.weightField', h('input', { type: 'number', id: 'gc-weight', min: '0', max: '100', step: '0.5', inputmode: 'decimal', value: category ? String(category.weight) : '' }), t('grades.weightHint')));
    },
    actions: [
      ...(isNew ? [] : [{
        label: t('common.delete'), variant: 'danger', start: true,
        onClick: async (api) => {
          const ok = await confirmAction({ title: t('grades.deleteCategoryTitle'), message: t('grades.deleteCategoryBody'), confirmLabel: t('common.delete'), danger: true });
          if (!ok) return;
          try {
            await deleteCategory(category.id);
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
        label: t('common.save'), variant: 'primary',
        onClick: async (api) => {
          const b = api.body;
          const { ok, errors, fields } = validateCategoryFields({ name: b.querySelector('#gc-name').value, weight: b.querySelector('#gc-weight').value });
          showErrors(b, { 'gc-name': errors.name, 'gc-weight': errors.weight });
          if (!ok) return;
          api.setBusy(true);
          try {
            if (isNew) await createCategory(app().userId, course.id, fields, nextSortOrder);
            else await updateCategory(category.id, fields);
            api.close(true);
            toast(t('common.savedShort'), { kind: 'success' });
            if (onSaved) onSaved();
          } catch (err) {
            console.error(err);
            toast(t('v3.saveError'), { kind: 'error' });
            api.setBusy(false);
          }
        },
      },
    ],
  });
}

export function openGradeItemEditor({ course, categories, item = null, defaultCategoryId = null, nextSortOrder = 0, onSaved }) {
  const isNew = !item;
  openDrawer({
    title: isNew ? t('grades.newItem') : t('grades.editItem'),
    subtitle: course.name,
    render: (body) => {
      body.appendChild(field('gi-name', 'common.name', h('input', { type: 'text', id: 'gi-name', maxlength: '120', 'data-autofocus': true, value: item ? item.name : '', placeholder: t('grades.itemPlaceholder') })));
      const g = h('div', { class: 'field-grid' });
      g.appendChild(field('gi-earned', 'grades.earnedField', h('input', { type: 'number', id: 'gi-earned', min: '0', step: '0.5', inputmode: 'decimal', value: item && item.earned_points !== null && item.earned_points !== undefined ? String(item.earned_points) : '' }), t('grades.earnedHint')));
      g.appendChild(field('gi-possible', 'grades.possibleField', h('input', { type: 'number', id: 'gi-possible', min: '0.5', step: '0.5', inputmode: 'decimal', value: item ? String(item.possible_points) : '100' })));
      body.appendChild(g);
      if (categories.length) {
        const sel = h('select', { id: 'gi-category' }, h('option', { value: '' }, t('grades.noCategory')));
        categories.forEach((c) => sel.appendChild(h('option', { value: c.id }, `${c.name} (${Number(c.weight)}%)`)));
        sel.value = item ? item.category_id || '' : defaultCategoryId || categories[0].id;
        body.appendChild(field('gi-category', 'grades.categoryField', sel));
      }
      const more = h('details', { class: 'disclosure' }, h('summary', {}, t('common.moreOptions')));
      const mb = h('div', { class: 'disclosure-body' });
      mb.appendChild(field('gi-due', 'grades.dueField', h('input', { type: 'date', id: 'gi-due', value: item ? item.due_date || '' : '' })));
      const counts = h('input', { type: 'checkbox', id: 'gi-counts' });
      counts.checked = item ? item.counts !== false : true;
      mb.appendChild(h('div', { class: 'field-check' }, counts, h('label', { for: 'gi-counts' }, t('grades.countsField'))));
      mb.appendChild(h('p', { class: 'field-hint' }, t('grades.countsHint')));
      const notes = h('textarea', { id: 'gi-notes', rows: '2', maxlength: '2000' });
      notes.value = item ? item.notes || '' : '';
      mb.appendChild(field('gi-notes', 'common.notes', notes));
      more.appendChild(mb);
      if (item && (item.due_date || item.counts === false || item.notes)) more.open = true;
      body.appendChild(more);
    },
    actions: [
      ...(isNew ? [] : [{
        label: t('common.delete'), variant: 'danger', start: true,
        onClick: async (api) => {
          const ok = await confirmAction({ title: t('grades.deleteItemTitle'), message: t('grades.deleteItemBody').replace('{name}', item.name), confirmLabel: t('common.delete'), danger: true });
          if (!ok) return;
          try {
            await deleteGradeItem(item.id);
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
        label: t('common.save'), variant: 'primary',
        onClick: async (api) => {
          const b = api.body;
          const { ok, errors, fields } = validateGradeItemFields({
            name: b.querySelector('#gi-name').value,
            earned_points: b.querySelector('#gi-earned').value,
            possible_points: b.querySelector('#gi-possible').value,
            category_id: b.querySelector('#gi-category') ? b.querySelector('#gi-category').value : null,
            due_date: b.querySelector('#gi-due').value,
            counts: b.querySelector('#gi-counts').checked,
            notes: b.querySelector('#gi-notes').value,
          });
          showErrors(b, { 'gi-name': errors.name, 'gi-earned': errors.earned_points, 'gi-possible': errors.possible_points });
          if (!ok) return;
          api.setBusy(true);
          try {
            if (isNew) await createGradeItem(app().userId, course.id, fields, nextSortOrder);
            else await updateGradeItem(item.id, fields);
            api.close(true);
            toast(t('common.savedShort'), { kind: 'success' });
            if (onSaved) onSaved();
          } catch (err) {
            console.error(err);
            toast(t('v3.saveError'), { kind: 'error' });
            api.setBusy(false);
          }
        },
      },
    ],
  });
}
