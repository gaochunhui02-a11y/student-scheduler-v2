// Quick Add (V3-R): one entry point for task / class / course / exam /
// study block. The first screen is just five choices (each with a one-key
// shortcut); each opens a short form with sensible defaults, and details
// stay behind "More options".

import { openDrawer } from '../ui/drawer.js';
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { t } from '../shared/i18n.js';
import { app } from '../app/context.js';
import { has } from '../shared/capabilities.js';
import { todayStr, addDays, clockToMinutes, minutesOfDay, dayOfWeek } from '../shared/dates.js';
import { openTaskEditor } from '../tasks/taskEditor.js';
import { openCourseEditor } from '../courses/courseEditor.js';
import { openExamEditor } from '../exams/examEditors.js';
import { listCourses, createCourseMeeting, listTaskRowsInWindow } from '../academics/academicsData.js';
import { sortCourses } from '../academics/courseModel.js';
import { getOrCreateScheduleForDate, insertClass } from '../dashboard/data.js';
import { pinStudyBlock } from '../planner/pinBlock.js';
import { openProjectEditor } from '../projects/projectEditors.js';
import { openGoalEditor } from '../goals/goalEditors.js';
import { openRoutineEditor } from '../routines/routineEditor.js';
import { buildSeriesFields, validateSeriesFields } from '../dashboard/recurringClasses.js';
import { supabase } from '../lib/supabaseClient.js';
import { invalidate } from '../app/store.js';
import { emitChange } from '../app/context.js';

const TYPES = [
  { id: 'task', key: 't', iconName: 'tasks', labelKey: 'qa.task', hintKey: 'qa.taskHint' },
  { id: 'project', key: 'p', iconName: 'briefcase', labelKey: 'qa.project', hintKey: 'qa.projectHint' },
  { id: 'goal', key: 'g', iconName: 'target', labelKey: 'qa.goal', hintKey: 'qa.goalHint' },
  { id: 'routine', key: 'r', iconName: 'repeat', labelKey: 'qa.routine', hintKey: 'qa.routineHint' },
  { id: 'class', key: 'c', iconName: 'calendar', labelKey: 'qa.class', hintKey: 'qa.classHint' },
  { id: 'course', key: 'o', iconName: 'book', labelKey: 'qa.course', hintKey: 'qa.courseHint' },
  { id: 'exam', key: 'e', iconName: 'exam', labelKey: 'qa.exam', hintKey: 'qa.examHint' },
  { id: 'study', key: 's', iconName: 'clock', labelKey: 'qa.study', hintKey: 'qa.studyHint' },
];

function pad(m) {
  const v = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}

async function courseSelect(id) {
  if (!has('courses')) return null;
  const courses = sortCourses((await listCourses(app().userId).catch(() => [])).filter((c) => !c.archived));
  if (!courses.length) return null;
  const sel = h('select', { id }, h('option', { value: '' }, t('tasks.noCourse')));
  courses.forEach((c) => sel.appendChild(h('option', { value: c.id }, c.code ? `${c.code} — ${c.name}` : c.name)));
  return sel;
}

function field(id, labelKey, control) {
  return h('div', { class: 'field' }, h('label', { for: id }, t(labelKey)), control);
}

function afterPlannerWrite(date) {
  invalidate('schedules');
  invalidate('tasks');
  emitChange('classes');
  const ctx = app();
  if (ctx.plannerDate() === date) ctx.refreshPlanner();
}

// ---------------- class (one-off or weekly) ----------------
async function openClassForm() {
  const today = todayStr();
  const courseSel = await courseSelect('qa-class-course');
  let weekly = false;
  openDrawer({
    title: t('qa.newClass'),
    render: (b) => {
      b.appendChild(field('qa-class-name', 'common.name', h('input', { type: 'text', id: 'qa-class-name', maxlength: '100', 'data-autofocus': true, placeholder: t('qa.classPlaceholder') })));
      const g = h('div', { class: 'field-grid' });
      g.appendChild(field('qa-class-date', 'common.date', h('input', { type: 'date', id: 'qa-class-date', value: today })));
      g.appendChild(h('div', { class: 'field' }));
      g.appendChild(field('qa-class-start', 'courses.startTime', h('input', { type: 'time', id: 'qa-class-start', value: '09:00' })));
      g.appendChild(field('qa-class-end', 'courses.endTime', h('input', { type: 'time', id: 'qa-class-end', value: '10:00' })));
      b.appendChild(g);
      if (courseSel) b.appendChild(field('qa-class-course', 'tasks.fieldCourse', courseSel));
      const rep = h('input', { type: 'checkbox', id: 'qa-class-weekly' });
      rep.addEventListener('change', () => { weekly = rep.checked; until.hidden = !weekly; });
      const until = h('div', { class: 'field', hidden: true }, h('label', { for: 'qa-class-until' }, t('recur.until')), h('input', { type: 'date', id: 'qa-class-until', value: addDays(today, 98) }));
      b.appendChild(h('div', { class: 'field-check' }, rep, h('label', { for: 'qa-class-weekly' }, t('qa.everyWeek'))));
      b.appendChild(until);
      b.appendChild(h('p', { class: 'field-error', id: 'qa-class-error', role: 'alert' }));
    },
    actions: [
      { label: t('common.cancel'), variant: 'secondary', onClick: (api) => api.close() },
      {
        label: t('common.add'), variant: 'primary',
        onClick: async (api) => {
          const b = api.body;
          const name = b.querySelector('#qa-class-name').value.trim();
          const date = b.querySelector('#qa-class-date').value;
          const start = b.querySelector('#qa-class-start').value;
          const end = b.querySelector('#qa-class-end').value;
          const courseId = b.querySelector('#qa-class-course') ? b.querySelector('#qa-class-course').value || null : null;
          const err = b.querySelector('#qa-class-error');
          const fields = buildSeriesFields({ name, daysOfWeek: [dayOfWeek(date || today)], startTime: start, endTime: end, startDate: date, endDate: weekly ? b.querySelector('#qa-class-until').value : date });
          const v = validateSeriesFields(fields);
          if (!v.valid) {
            err.textContent = t(v.errorKey);
            return;
          }
          api.setBusy(true);
          try {
            if (weekly) {
              await createCourseMeeting(app().userId, { ...fields, ...(courseId && has('classCourseLinks') ? { course_id: courseId } : {}) });
            } else {
              const sched = await getOrCreateScheduleForDate(app().userId, date);
              await insertClass(sched.id, app().userId, { name, start_time: start, end_time: end, ...(courseId && has('courseLinks') ? { course_id: courseId } : {}) }, 99);
            }
            afterPlannerWrite(date);
            api.close(true);
            toast(t('qa.classAdded'), { kind: 'success' });
          } catch (e) {
            console.error(e);
            err.textContent = t('v3.saveError');
            api.setBusy(false);
          }
        },
      },
    ],
  });
}

// ---------------- study block (pinned) ----------------
async function openStudyForm() {
  const ctx = app();
  const today = todayStr();
  const rows = await listTaskRowsInWindow(ctx.userId, addDays(today, -14), addDays(today, 60)).catch(() => []);
  const tasks = rows.filter((r) => !r.origin_subject_id && !r.completed_at).sort((a, b) => String(a.due_date || '9').localeCompare(String(b.due_date || '9')));
  const startDefault = Math.ceil((minutesOfDay() + 15) / 15) * 15;
  openDrawer({
    title: t('qa.newStudy'),
    subtitle: t('qa.studySub'),
    render: (b) => {
      const sel = h('select', { id: 'qa-study-task' }, h('option', { value: '' }, t('qa.studyFree')));
      tasks.slice(0, 150).forEach((r) => sel.appendChild(h('option', { value: r.id }, r.name)));
      b.appendChild(field('qa-study-task', 'qa.studyFor', sel));
      b.appendChild(field('qa-study-name', 'common.name', h('input', { type: 'text', id: 'qa-study-name', maxlength: '120', placeholder: t('qa.studyNamePlaceholder') })));
      sel.addEventListener('change', () => { b.querySelector('#qa-study-name').closest('.field').hidden = Boolean(sel.value); });
      const g = h('div', { class: 'field-grid-3' });
      g.appendChild(field('qa-study-date', 'common.date', h('input', { type: 'date', id: 'qa-study-date', value: startDefault >= 1380 ? addDays(today, 1) : today })));
      g.appendChild(field('qa-study-start', 'courses.startTime', h('input', { type: 'time', id: 'qa-study-start', value: pad(startDefault >= 1380 ? 9 * 60 : startDefault) })));
      g.appendChild(field('qa-study-min', 'manualEdit.durationLabel', h('input', { type: 'number', id: 'qa-study-min', min: '10', max: '600', step: '5', value: '60' })));
      b.appendChild(g);
      b.appendChild(h('p', { class: 'field-hint' }, t('qa.studyPinnedHint')));
      b.appendChild(h('p', { class: 'field-error', id: 'qa-study-error', role: 'alert' }));
    },
    actions: [
      { label: t('common.cancel'), variant: 'secondary', onClick: (api) => api.close() },
      {
        label: t('common.add'), variant: 'primary',
        onClick: async (api) => {
          const b = api.body;
          const taskId = b.querySelector('#qa-study-task').value || null;
          const task = tasks.find((r) => r.id === taskId);
          const name = task ? task.name : b.querySelector('#qa-study-name').value.trim();
          const date = b.querySelector('#qa-study-date').value;
          const start = clockToMinutes(b.querySelector('#qa-study-start').value);
          const mins = Number(b.querySelector('#qa-study-min').value);
          const err = b.querySelector('#qa-study-error');
          if (!name) { err.textContent = t('tasks.errNameRequired'); return; }
          if (!date || start === null || !Number.isFinite(mins) || mins < 10 || start + mins > 1440) { err.textContent = t('errors.invalidTime'); return; }
          api.setBusy(true);
          try {
            const res = await pinStudyBlock({ userId: ctx.userId, date, start, minutes: mins, name, taskId });
            if (!res.ok) {
              err.textContent = t('calendar3.dropOverlap').replace('{name}', res.clash);
              api.setBusy(false);
              return;
            }
            afterPlannerWrite(date);
            api.close(true);
            toast(t('qa.studyAdded'), { kind: 'success' });
          } catch (e) {
            console.error(e);
            err.textContent = t('v3.saveError');
            api.setBusy(false);
          }
        },
      },
    ],
  });
}

export function openQuickAdd(initialType = null) {
  const go = (type, api) => {
    if (api) api.close(true);
    if (type === 'task') openTaskEditor({});
    else if (type === 'course') openCourseEditor({ onSaved: (c) => c && app().openCourse(c.id) });
    else if (type === 'project') openProjectEditor({ onSaved: (p) => p && app().navigate('projectsView', p.id) });
    else if (type === 'goal') openGoalEditor({ onSaved: (g) => g && app().navigate('goalsView', g.id) });
    else if (type === 'routine') openRoutineEditor({ onSaved: () => app().navigate('routinesView') });
    else if (type === 'exam') openExamEditor({ onSaved: (x) => x && app().navigate('examsView', x.id) });
    else if (type === 'class') openClassForm();
    else if (type === 'study') openStudyForm();
  };
  if (initialType) {
    go(initialType, null);
    return;
  }
  let onKey = null;
  openDrawer({
    onClose: () => { if (onKey) document.removeEventListener('keydown', onKey); },
    title: t('palette.quickAdd'),
    subtitle: t('qa.subtitle'),
    size: 'narrow',
    render: (body, api) => {
      const grid = h('div', { class: 'qa-grid', role: 'list' });
      TYPES.forEach((tp) => {
        if ((tp.id === 'course' && !has('courses')) || (tp.id === 'exam' && !has('exams')) || (tp.id === 'project' && !has('projects')) || (tp.id === 'goal' && !(has('goals') && has('goalLinks'))) || (tp.id === 'routine' && !has('routines'))) return;
        const btn = h('button', { type: 'button', class: 'qa-tile', role: 'listitem', 'data-qa': tp.id });
        btn.innerHTML = `<span class="qa-tile-icon">${icon(tp.iconName)}</span><span class="qa-tile-text"><strong></strong><span></span></span><kbd class="kbd"></kbd>`;
        btn.querySelector('strong').textContent = t(tp.labelKey);
        btn.querySelector('.qa-tile-text span').textContent = t(tp.hintKey);
        btn.querySelector('kbd').textContent = tp.key.toUpperCase();
        btn.addEventListener('click', () => go(tp.id, api));
        grid.appendChild(btn);
      });
      body.appendChild(grid);
      // Letter keys work wherever focus is while the sheet is open.
      onKey = (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey || !document.body.contains(api.panel)) return;
        const tp = TYPES.find((x) => x.key === String(e.key).toLowerCase());
        if (tp && body.querySelector(`[data-qa="${tp.id}"]`)) {
          e.preventDefault();
          document.removeEventListener('keydown', onKey);
          go(tp.id, api);
        }
      };
      document.addEventListener('keydown', onKey);
    },
  });
}

