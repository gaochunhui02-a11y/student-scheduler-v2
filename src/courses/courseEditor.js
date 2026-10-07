// Create / edit a course in a drawer. First layer: name, code, colour.
// "More options": instructor, location, semester, target grade, credits,
// notes. Delete lives here too, with a plain-language confirmation that
// explains tasks and classes are kept.

import { openDrawer, confirmAction } from '../ui/drawer.js';
import { h } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { t } from '../shared/i18n.js';
import { app } from '../app/context.js';
import { has } from '../shared/capabilities.js';
import { COURSE_COLORS, pickCourseColor, validateCourseFields } from '../academics/courseModel.js';
import { listCourses, listSemesters, createCourse, updateCourse, deleteCourse } from '../academics/academicsData.js';
import { pickCurrentSemester } from '../academics/semesterModel.js';
import { todayStr } from '../shared/dates.js';

function field(id, labelKey, control, { hint = '', span = false } = {}) {
  const wrap = h('div', { class: `field${span ? ' field-span' : ''}` });
  wrap.appendChild(h('label', { for: id }, t(labelKey)));
  wrap.appendChild(control);
  if (hint) wrap.appendChild(h('p', { class: 'field-hint' }, hint));
  wrap.appendChild(h('p', { class: 'field-error', id: `${id}-error`, role: 'alert' }));
  control.setAttribute('aria-describedby', `${id}-error`);
  return wrap;
}

function colorPicker(current, onPick) {
  const group = h('div', { class: 'color-swatches', role: 'radiogroup', 'aria-label': t('courses.fieldColor') });
  const buttons = COURSE_COLORS.map((c, i) => {
    const btn = h('button', {
      type: 'button',
      class: 'color-swatch',
      role: 'radio',
      'aria-checked': c === current ? 'true' : 'false',
      'aria-label': `${t('courses.colorOption')} ${i + 1}`,
      tabindex: c === current ? '0' : '-1',
      style: { '--c': c },
    });
    btn.style.setProperty('--c', c);
    btn.addEventListener('click', () => select(i, true));
    btn.addEventListener('keydown', (e) => {
      const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!delta) return;
      e.preventDefault();
      select((i + delta + COURSE_COLORS.length) % COURSE_COLORS.length, true);
    });
    group.appendChild(btn);
    return btn;
  });
  function select(i, focus) {
    buttons.forEach((b, j) => {
      b.setAttribute('aria-checked', i === j ? 'true' : 'false');
      b.tabIndex = i === j ? 0 : -1;
    });
    if (focus) buttons[i].focus();
    onPick(COURSE_COLORS[i]);
  }
  if (!COURSE_COLORS.includes(current)) buttons[0].tabIndex = 0;
  return group;
}

export async function openCourseEditor({ course = null, onSaved } = {}) {
  const ctx = app();
  const isNew = !course;
  let existing = [];
  let semesters = [];
  try {
    existing = await listCourses(ctx.userId);
  } catch { /* create still works */ }
  if (has('semesters')) {
    try {
      semesters = await listSemesters(ctx.userId);
    } catch { /* optional */ }
  }
  let color = course ? course.color || pickCourseColor(existing) : pickCourseColor(existing);
  const defaultSemester = course ? course.semester_id : (pickCurrentSemester(semesters, todayStr()) || {}).id || '';

  openDrawer({
    title: isNew ? t('courses.newTitle') : t('courses.editTitle'),
    render: (body) => {
      const name = h('input', { type: 'text', id: 'ce-name', maxlength: '120', autocomplete: 'off', 'data-autofocus': true, value: course ? course.name : '', placeholder: t('courses.namePlaceholder') });
      const code = h('input', { type: 'text', id: 'ce-code', maxlength: '32', autocomplete: 'off', value: course ? course.code || '' : '', placeholder: t('courses.codePlaceholder') });
      body.appendChild(field('ce-name', 'courses.fieldName', name));
      const grid = h('div', { class: 'field-grid' });
      grid.appendChild(field('ce-code', 'courses.fieldCode', code));
      const colorWrap = h('div', { class: 'field' }, h('span', { class: 'field-label' }, t('courses.fieldColor')), colorPicker(color, (c) => { color = c; }));
      grid.appendChild(colorWrap);
      body.appendChild(grid);

      const more = h('details', { class: 'disclosure' }, h('summary', {}, t('common.moreOptions')));
      const mb = h('div', { class: 'disclosure-body' });
      const g2 = h('div', { class: 'field-grid' });
      g2.appendChild(field('ce-instructor', 'courses.fieldInstructor', h('input', { type: 'text', id: 'ce-instructor', maxlength: '120', value: course ? course.instructor || '' : '' })));
      g2.appendChild(field('ce-location', 'courses.fieldLocation', h('input', { type: 'text', id: 'ce-location', maxlength: '120', value: course ? course.location || '' : '' })));
      if (semesters.length) {
        const sel = h('select', { id: 'ce-semester' }, h('option', { value: '' }, t('courses.noSemester')));
        semesters.forEach((s) => sel.appendChild(h('option', { value: s.id }, s.name)));
        sel.value = defaultSemester || '';
        g2.appendChild(field('ce-semester', 'courses.fieldSemester', sel));
      }
      g2.appendChild(field('ce-target', 'courses.fieldTarget', h('input', { type: 'number', id: 'ce-target', min: '0', max: '100', step: '0.5', inputmode: 'decimal', value: course && course.target_grade !== null && course.target_grade !== undefined ? String(course.target_grade) : '' }), { hint: t('courses.fieldTargetHint') }));
      g2.appendChild(field('ce-credits', 'courses.fieldCredits', h('input', { type: 'number', id: 'ce-credits', min: '0', max: '50', step: '0.5', inputmode: 'decimal', value: course && course.credits !== null && course.credits !== undefined ? String(course.credits) : '' })));
      mb.appendChild(g2);
      const notes = h('textarea', { id: 'ce-notes', rows: '3', maxlength: '5000' });
      notes.value = course ? course.notes || '' : '';
      mb.appendChild(field('ce-notes', 'common.notes', notes));
      more.appendChild(mb);
      body.appendChild(more);
      body.appendChild(h('p', { class: 'field-error', id: 'ce-form-error', role: 'alert' }));
    },
    actions: [
      ...(isNew ? [] : [{
        label: t('common.delete'),
        variant: 'danger',
        start: true,
        onClick: async (api) => {
          const ok = await confirmAction({
            title: t('courses.deleteTitle').replace('{name}', course.name),
            message: t('courses.deleteBody'),
            confirmLabel: t('courses.deleteConfirm'),
            danger: true,
          });
          if (!ok) return;
          try {
            await deleteCourse(course.id);
            api.close(true);
            toast(t('common.deleted'));
            if (onSaved) onSaved(null);
          } catch (err) {
            console.error('Could not delete course', err);
            toast(t('v3.deleteError'), { kind: 'error' });
          }
        },
      }]),
      { label: t('common.cancel'), variant: 'secondary', onClick: (api) => api.close() },
      {
        label: isNew ? t('courses.create') : t('common.save'),
        variant: 'primary',
        onClick: async (api, btn) => {
          const b = api.body;
          const val = (id) => (b.querySelector(`#${id}`) ? b.querySelector(`#${id}`).value : undefined);
          const { ok, fields, errors } = validateCourseFields({
            name: val('ce-name'),
            code: val('ce-code'),
            instructor: val('ce-instructor'),
            location: val('ce-location'),
            notes: val('ce-notes'),
            color,
            target_grade: val('ce-target'),
            credits: val('ce-credits'),
            semester_id: val('ce-semester'),
          });
          [['ce-name', 'name'], ['ce-target', 'target_grade'], ['ce-credits', 'credits']].forEach(([id, key]) => {
            const err = b.querySelector(`#${id}-error`);
            if (err) err.textContent = errors[key] ? t(errors[key]) : '';
            b.querySelector(`#${id}`)?.setAttribute('aria-invalid', errors[key] ? 'true' : 'false');
          });
          if (!ok) {
            if (errors.target_grade || errors.credits) b.querySelector('details.disclosure').open = true;
            b.querySelector('[aria-invalid="true"]')?.focus();
            return;
          }
          if (!semesters.length) delete fields.semester_id;
          btn.textContent = t('common.saving');
          api.setBusy(true);
          try {
            const saved = isNew ? await createCourse(ctx.userId, fields) : await updateCourse(course.id, fields);
            api.close(true);
            toast(isNew ? t('courses.created') : t('common.savedShort'), { kind: 'success' });
            if (onSaved) onSaved(saved);
          } catch (err) {
            console.error('Could not save course', err);
            b.querySelector('#ce-form-error').textContent = t('v3.saveError');
            btn.textContent = isNew ? t('courses.create') : t('common.save');
            api.setBusy(false);
          }
        },
      },
    ],
  });
}
