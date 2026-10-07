// Exam and revision-topic drawers.

import { openDrawer, confirmAction } from '../ui/drawer.js';
import { h } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { t } from '../shared/i18n.js';
import { app } from '../app/context.js';
import { has } from '../shared/capabilities.js';
import { addDays, todayStr } from '../shared/dates.js';
import { listCourses } from '../academics/academicsData.js';
import { sortCourses } from '../academics/courseModel.js';
import { validateExamFields, validateTopicFields } from './revisionPlanner.js';
import { createExam, updateExam, deleteExam, createTopic, updateTopic, deleteTopic } from './examsData.js';

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

export async function openExamEditor({ exam = null, defaultCourseId = null, onSaved } = {}) {
  const isNew = !exam;
  let courses = [];
  if (has('courses')) {
    try {
      courses = sortCourses((await listCourses(app().userId)).filter((c) => !c.archived || (exam && exam.course_id === c.id)));
    } catch { /* optional */ }
  }
  openDrawer({
    title: isNew ? t('exams.newTitle') : t('exams.editTitle'),
    render: (body) => {
      body.appendChild(field('ex-name', 'exams.fieldName', h('input', { type: 'text', id: 'ex-name', maxlength: '120', 'data-autofocus': true, value: exam ? exam.name : '', placeholder: t('exams.namePlaceholder') })));
      const g = h('div', { class: 'field-grid' });
      g.appendChild(field('ex-date', 'common.date', h('input', { type: 'date', id: 'ex-date', value: exam ? exam.exam_date : addDays(todayStr(), 14) })));
      g.appendChild(field('ex-time', 'common.time', h('input', { type: 'time', id: 'ex-time', value: exam && exam.start_time ? String(exam.start_time).slice(0, 5) : '' })));
      body.appendChild(g);
      if (courses.length) {
        const sel = h('select', { id: 'ex-course' }, h('option', { value: '' }, t('tasks.noCourse')));
        courses.forEach((c) => sel.appendChild(h('option', { value: c.id }, c.code ? `${c.code} — ${c.name}` : c.name)));
        sel.value = exam ? exam.course_id || '' : defaultCourseId || '';
        body.appendChild(field('ex-course', 'tasks.fieldCourse', sel));
      }
      const more = h('details', { class: 'disclosure' }, h('summary', {}, t('common.moreOptions')));
      const mb = h('div', { class: 'disclosure-body' });
      const g2 = h('div', { class: 'field-grid' });
      g2.appendChild(field('ex-weight', 'exams.fieldWeight', h('input', { type: 'number', id: 'ex-weight', min: '0', max: '100', step: '0.5', inputmode: 'decimal', value: exam && exam.weight !== null && exam.weight !== undefined ? String(exam.weight) : '' }), t('exams.weightHint')));
      g2.appendChild(field('ex-duration', 'exams.fieldDuration', h('input', { type: 'number', id: 'ex-duration', min: '5', max: '720', step: '5', inputmode: 'numeric', value: exam && exam.duration_minutes ? String(exam.duration_minutes) : '' })));
      mb.appendChild(g2);
      mb.appendChild(field('ex-location', 'courses.fieldLocation', h('input', { type: 'text', id: 'ex-location', maxlength: '120', value: exam ? exam.location || '' : '' })));
      const notes = h('textarea', { id: 'ex-notes', rows: '3', maxlength: '5000', placeholder: t('exams.notesPlaceholder') });
      notes.value = exam ? exam.notes || '' : '';
      mb.appendChild(field('ex-notes', 'common.notes', notes));
      more.appendChild(mb);
      if (exam && (exam.weight !== null || exam.location || exam.notes)) more.open = true;
      body.appendChild(more);
    },
    actions: [
      ...(isNew ? [] : [{
        label: t('common.delete'), variant: 'danger', start: true,
        onClick: async (api) => {
          const ok = await confirmAction({ title: t('exams.deleteTitle'), message: t('exams.deleteBody').replace('{name}', exam.name), confirmLabel: t('common.delete'), danger: true });
          if (!ok) return;
          try {
            await deleteExam(exam.id);
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
        label: isNew ? t('exams.create') : t('common.save'), variant: 'primary',
        onClick: async (api) => {
          const b = api.body;
          const v = (id) => (b.querySelector(`#${id}`) ? b.querySelector(`#${id}`).value : '');
          const { ok, errors, fields } = validateExamFields({
            name: v('ex-name'), exam_date: v('ex-date'), start_time: v('ex-time'), course_id: v('ex-course'),
            weight: v('ex-weight'), duration_minutes: v('ex-duration'), location: v('ex-location'), notes: v('ex-notes'),
          });
          showErrors(b, { 'ex-name': errors.name, 'ex-date': errors.exam_date, 'ex-weight': errors.weight, 'ex-duration': errors.duration_minutes });
          if (!ok) {
            if (errors.weight || errors.duration_minutes) b.querySelector('details.disclosure').open = true;
            return;
          }
          if (!courses.length) delete fields.course_id;
          api.setBusy(true);
          try {
            const saved = isNew ? await createExam(app().userId, fields) : await updateExam(exam.id, fields);
            api.close(true);
            toast(isNew ? t('exams.created') : t('common.savedShort'), { kind: 'success' });
            if (onSaved) onSaved(saved);
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

function scale(id, labelKey, max, value, labels) {
  const group = h('div', { class: 'scale', role: 'radiogroup', id, 'aria-label': t(labelKey) });
  for (let i = 1; i <= max; i += 1) {
    const b = h('button', { type: 'button', class: 'scale-btn', role: 'radio', 'aria-checked': i === value ? 'true' : 'false', 'data-value': String(i), tabindex: i === value ? '0' : '-1', title: labels[i - 1] }, String(i));
    b.addEventListener('click', () => select(i));
    b.addEventListener('keydown', (e) => {
      const delta = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
      if (!delta) return;
      e.preventDefault();
      select(Math.min(max, Math.max(1, Number(group.dataset.value) + delta)), true);
    });
    group.appendChild(b);
  }
  const caption = h('span', { class: 'scale-caption' });
  function select(n, focus = false) {
    group.dataset.value = String(n);
    group.querySelectorAll('.scale-btn').forEach((b) => {
      const on = Number(b.dataset.value) === n;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    caption.textContent = labels[n - 1];
  }
  select(value);
  return h('div', { class: 'field' }, h('span', { class: 'field-label' }, t(labelKey)), h('div', { class: 'row' }, group, caption));
}

export function openTopicEditor({ exam, topic = null, nextSortOrder = 0, onSaved }) {
  const isNew = !topic;
  openDrawer({
    title: isNew ? t('exams.newTopic') : t('exams.editTopic'),
    subtitle: exam.name,
    render: (body) => {
      body.appendChild(field('tp-name', 'exams.topicName', h('input', { type: 'text', id: 'tp-name', maxlength: '120', 'data-autofocus': true, value: topic ? topic.name : '', placeholder: t('exams.topicPlaceholder') })));
      body.appendChild(scale('tp-difficulty', 'exams.difficulty', 3, topic ? topic.difficulty : 2, [t('exams.diff1'), t('exams.diff2'), t('exams.diff3')]));
      body.appendChild(scale('tp-confidence', 'exams.confidence', 5, topic ? topic.confidence : 3, [t('exams.conf1'), t('exams.conf2'), t('exams.conf3'), t('exams.conf4'), t('exams.conf5')]));
      const g = h('div', { class: 'field-grid' });
      g.appendChild(field('tp-est', 'exams.estimate', h('input', { type: 'number', id: 'tp-est', min: '5', max: '6000', step: '5', inputmode: 'numeric', value: String(topic ? topic.estimated_minutes : 60) })));
      g.appendChild(field('tp-done', 'exams.revised', h('input', { type: 'number', id: 'tp-done', min: '0', max: '20000', step: '5', inputmode: 'numeric', value: String(topic ? topic.completed_minutes : 0) })));
      body.appendChild(g);
    },
    actions: [
      ...(isNew ? [] : [{
        label: t('common.delete'), variant: 'danger', start: true,
        onClick: async (api) => {
          try {
            await deleteTopic(topic.id);
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
          const { ok, errors, fields } = validateTopicFields({
            name: b.querySelector('#tp-name').value,
            difficulty: b.querySelector('#tp-difficulty').dataset.value,
            confidence: b.querySelector('#tp-confidence').dataset.value,
            estimated_minutes: b.querySelector('#tp-est').value,
            completed_minutes: b.querySelector('#tp-done').value,
          });
          showErrors(b, { 'tp-name': errors.name, 'tp-est': errors.estimated_minutes, 'tp-done': errors.completed_minutes });
          if (!ok) return;
          api.setBusy(true);
          try {
            if (isNew) await createTopic(app().userId, { exam_id: exam.id, sort_order: nextSortOrder, ...fields });
            else await updateTopic(topic.id, fields);
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
