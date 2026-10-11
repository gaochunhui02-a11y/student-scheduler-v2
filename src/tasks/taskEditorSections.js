// Extra sections for the task editor's "More options" (V3-H): tags,
// subtasks, dependencies, links, actual time and weekly repeat. Each is
// registered once and only appears when its database feature exists.

import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { t } from '../shared/i18n.js';
import { has } from '../shared/capabilities.js';
import { app } from '../app/context.js';
import { todayStr, addDays, dayOfWeek } from '../shared/dates.js';
import { registerTaskEditorSection } from './taskEditor.js';
import { PRESET_TASK_TAGS, toggleTag, addCustomTag, normalizeTagList } from '../dashboard/tagsModel.js';
import { insertSubtask, updateSubtask, deleteSubtask } from '../dashboard/data.js';
import { isValidSubtaskTitle } from '../dashboard/subtasksModel.js';
import { listTaskRowsInWindow, listBlocksForSubjectIds } from '../academics/academicsData.js';
import { buildTaskGroups } from './taskModel.js';
import { wouldCreateCycle } from './dependencyModel.js';
import { listDependencies, addDependency, removeDependency, listSubtasksFor, saveRecurrenceRule, generateRecurringTasks, updateTask } from './tasksData.js';
import { listResources, createResource, deleteResource } from '../resources/resourcesData.js';
import { validateResourceFields, hostOf, normalizeUrl } from '../resources/resourceModel.js';
import { fmtWeekday } from '../ui/format.js';

const PRESET_TAG_KEYS = { Exam: 'study.tagExam', Homework: 'study.tagHomework', Reading: 'study.tagReading', Project: 'study.tagProject', Review: 'study.tagReview' };
export function tagLabel(tag) {
  return PRESET_TAG_KEYS[tag] ? t(PRESET_TAG_KEYS[tag]) : tag;
}

function sectionShell(container, titleKey, hintKey = '') {
  container.classList.add('editor-section');
  container.appendChild(h('p', { class: 'section-label' }, t(titleKey)));
  if (hintKey) container.appendChild(h('p', { class: 'field-hint', style: { marginTop: '-4px' } }, t(hintKey)));
}

// ---------------- tags ----------------
registerTaskEditorSection({
  id: 'tags',
  render(container, { task }) {
    let tags = normalizeTagList(task ? task.tags : []);
    sectionShell(container, 'tasks.sectionTags');
    const chips = h('div', { class: 'chip-toggle-row', role: 'group', 'aria-label': t('tasks.sectionTags') });
    const custom = h('input', { type: 'text', class: 'v3-input', maxlength: '30', placeholder: t('tasks.customTag'), 'aria-label': t('tasks.customTag'), style: { maxWidth: '180px', height: '30px' } });
    function draw() {
      chips.innerHTML = '';
      const all = [...new Set([...PRESET_TASK_TAGS, ...tags])];
      all.forEach((tag) => {
        const on = tags.includes(tag);
        const b = h('button', { type: 'button', class: 'chip-toggle', 'aria-pressed': on ? 'true' : 'false' }, tagLabel(tag));
        b.addEventListener('click', () => { tags = toggleTag(tags, tag); draw(); });
        chips.appendChild(b);
      });
      chips.appendChild(custom);
    }
    custom.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      tags = addCustomTag(tags, custom.value);
      custom.value = '';
      draw();
      custom.focus();
    });
    draw();
    container.appendChild(chips);
    return { collect: () => ({ tags: custom.value.trim() ? addCustomTag(tags, custom.value) : tags }) };
  },
});

// ---------------- subtasks (existing tasks only; saved immediately) ----------------
registerTaskEditorSection({
  id: 'subtasks',
  render(container, { task }) {
    if (!task) return {};
    sectionShell(container, 'tasks.sectionSubtasks');
    const list = h('ul', { class: 'subtask-edit-list' });
    const input = h('input', { type: 'text', class: 'v3-input', maxlength: '200', placeholder: t('tasks.addSubtask'), 'aria-label': t('tasks.addSubtask'), style: { height: '32px' } });
    let items = [];
    async function load() {
      items = await listSubtasksFor(task.root.id);
      draw();
    }
    function draw() {
      list.innerHTML = '';
      items.forEach((st) => {
        const cb = h('input', { type: 'checkbox', id: `st-${st.id}` });
        cb.checked = Boolean(st.completed);
        cb.addEventListener('change', async () => {
          try {
            await updateSubtask(st.id, { completed: cb.checked });
            st.completed = cb.checked;
          } catch {
            cb.checked = !cb.checked;
            toast(t('v3.saveError'), { kind: 'error' });
          }
        });
        const del = h('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm', 'aria-label': t('tasks.removeSubtask') });
        del.innerHTML = icon('close');
        del.addEventListener('click', async () => {
          try {
            await deleteSubtask(st.id);
            items = items.filter((x) => x.id !== st.id);
            draw();
          } catch {
            toast(t('v3.deleteError'), { kind: 'error' });
          }
        });
        list.appendChild(h('li', {}, h('span', { class: 'field-check' }, cb, h('label', { for: `st-${st.id}` }, st.title)), del));
      });
    }
    input.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const title = input.value.trim();
      if (!isValidSubtaskTitle(title)) return;
      input.disabled = true;
      try {
        const row = await insertSubtask(task.root.id, app().userId, { title, completed: false }, items.length);
        items.push(row);
        input.value = '';
        draw();
      } catch {
        toast(t('v3.saveError'), { kind: 'error' });
      } finally {
        input.disabled = false;
        input.focus();
      }
    });
    container.append(list, input);
    load();
    return {};
  },
});

// ---------------- dependencies ----------------
registerTaskEditorSection({
  id: 'dependencies',
  render(container, { task }) {
    if (!task || !has('dependencies')) return {};
    sectionShell(container, 'deps.sectionTitle', 'deps.sectionHint');
    const list = h('ul', { class: 'dep-list' });
    const select = h('select', { class: 'v3-input', 'aria-label': t('deps.addLabel') });
    const err = h('p', { class: 'field-error', role: 'alert' });
    const override = h('input', { type: 'checkbox', id: 'te-dep-override' });
    override.checked = Boolean(task.dependencyOverride);
    let deps = [];
    let groups = [];
    async function load() {
      const today = todayStr();
      const [d, rows] = await Promise.all([listDependencies(app().userId), listTaskRowsInWindow(app().userId, addDays(today, -90), addDays(today, 180))]);
      const blocks = await listBlocksForSubjectIds(rows.map((r) => r.id));
      deps = d;
      groups = buildTaskGroups(rows, blocks, { today });
      draw();
    }
    function draw() {
      list.innerHTML = '';
      const mine = deps.filter((d) => d.task_id === task.id);
      if (!mine.length) list.appendChild(h('li', { class: 'muted small' }, t('deps.none')));
      mine.forEach((d) => {
        const g = groups.find((x) => x.id === d.depends_on_id);
        const rm = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, t('deps.remove'));
        rm.addEventListener('click', async () => {
          try {
            await removeDependency(d.id);
            deps = deps.filter((x) => x.id !== d.id);
            draw();
          } catch {
            toast(t('v3.deleteError'), { kind: 'error' });
          }
        });
        list.appendChild(h('li', {}, h('span', { class: `dep-name${g && g.done ? ' is-done' : ''}` }, g ? g.name : t('deps.unknownTask')), g && g.done ? h('span', { class: 'badge badge--success' }, t('common.done')) : h('span', { class: 'badge badge--warning' }, t('deps.notDone')), rm));
      });
      const blockers = deps.filter((d) => d.depends_on_id === task.id).map((d) => groups.find((x) => x.id === d.task_id)).filter(Boolean);
      if (blockers.length) list.appendChild(h('li', { class: 'muted small' }, t('deps.unlocks').replace('{names}', blockers.map((b) => b.name).join(', '))));
      select.innerHTML = '';
      select.appendChild(h('option', { value: '' }, t('deps.addPlaceholder')));
      groups
        .filter((g) => g.id !== task.id && !mine.some((d) => d.depends_on_id === g.id))
        .sort((a, b) => (a.courseId === task.courseId ? -1 : 0) - (b.courseId === task.courseId ? -1 : 0) || String(a.name).localeCompare(String(b.name)))
        .slice(0, 200)
        .forEach((g) => select.appendChild(h('option', { value: g.id }, `${g.name}${g.done ? ` (${t('common.done')})` : ''}`)));
    }
    select.addEventListener('change', async () => {
      const prereqId = select.value;
      err.textContent = '';
      if (!prereqId) return;
      if (wouldCreateCycle(deps, task.id, prereqId)) {
        err.textContent = t('deps.cycle');
        select.value = '';
        return;
      }
      select.disabled = true;
      try {
        await addDependency(app().userId, task.id, prereqId);
        deps = await listDependencies(app().userId);
        draw();
      } catch (e) {
        err.textContent = e && e.code === '23514' ? t('deps.cycle') : t('v3.saveError');
      } finally {
        select.disabled = false;
        select.value = '';
      }
    });
    container.append(list, select, err, h('div', { class: 'field-check' }, override, h('label', { for: 'te-dep-override' }, t('deps.override'))), h('p', { class: 'field-hint' }, t('deps.overrideHint')));
    load().catch(() => { list.textContent = t('v3.loadErrorBody'); });
    return { collect: () => (has('taskExtensions') ? { dependency_override: override.checked } : {}) };
  },
});

// ---------------- links ----------------
registerTaskEditorSection({
  id: 'links',
  render(container, { task }) {
    if (!task || !has('resources')) return {};
    sectionShell(container, 'resources.taskLinks');
    const list = h('ul', { class: 'link-list' });
    const url = h('input', { type: 'url', class: 'v3-input', placeholder: 'https://', 'aria-label': t('resources.url'), inputmode: 'url' });
    const add = h('button', { type: 'button', class: 'btn btn--secondary btn--sm' }, t('common.add'));
    const err = h('p', { class: 'field-error', role: 'alert' });
    let items = [];
    async function load() {
      items = (await listResources(app().userId)).filter((r) => r.task_id === task.root.id);
      draw();
    }
    function draw() {
      list.innerHTML = '';
      items.forEach((r) => {
        const safe = normalizeUrl(r.url);
        const a = safe ? h('a', { href: safe, target: '_blank', rel: 'noopener noreferrer' }, r.title) : h('span', {}, r.title);
        const del = h('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm', 'aria-label': t('resources.remove') });
        del.innerHTML = icon('close');
        del.addEventListener('click', async () => {
          try {
            await deleteResource(r.id);
            items = items.filter((x) => x.id !== r.id);
            draw();
          } catch {
            toast(t('v3.deleteError'), { kind: 'error' });
          }
        });
        list.appendChild(h('li', {}, a, h('span', { class: 'muted small' }, hostOf(r.url)), del));
      });
    }
    async function submit() {
      const { ok, fields, errors } = validateResourceFields({ url: url.value, title: '' });
      err.textContent = ok ? '' : t(errors.url || errors.title);
      if (!ok) return;
      add.disabled = true;
      try {
        items.push(await createResource(app().userId, { ...fields, task_id: task.root.id, course_id: null }));
        url.value = '';
        draw();
      } catch {
        err.textContent = t('v3.saveError');
      } finally {
        add.disabled = false;
      }
    }
    add.addEventListener('click', submit);
    url.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    container.append(list, h('div', { class: 'row' }, url, add), err);
    load();
    return {};
  },
});

// ---------------- actual time ----------------
registerTaskEditorSection({
  id: 'actual',
  render(container, { task }) {
    if (!task || !has('taskExtensions')) return {};
    const input = h('input', { type: 'number', id: 'te-actual', min: '0', max: '10000', step: '5', inputmode: 'numeric', value: task.actualMinutes !== null && task.actualMinutes !== undefined ? String(task.actualMinutes) : '' });
    container.appendChild(h('div', { class: 'field' }, h('label', { for: 'te-actual' }, t('tasks.fieldActual')), input, h('p', { class: 'field-hint' }, t('tasks.fieldActualHint'))));
    return {
      collect: () => {
        const v = input.value.trim();
        const n = Number(v);
        return { actual_minutes: v === '' || !Number.isFinite(n) || n < 0 ? null : Math.min(10000, Math.round(n)) };
      },
    };
  },
});

// ---------------- repeat weekly (new tasks) ----------------
registerTaskEditorSection({
  id: 'repeat',
  render(container, { task }) {
    if (task || !has('recurringTasks') || !has('taskExtensions')) return {};
    const toggle = h('input', { type: 'checkbox', id: 'te-repeat' });
    const days = new Set();
    const dayRow = h('div', { class: 'day-toggle-row', role: 'group', 'aria-label': t('courses.meetingDays'), hidden: true });
    [1, 2, 3, 4, 5, 6, 0].forEach((d) => {
      const b = h('button', { type: 'button', class: 'day-toggle', 'aria-pressed': 'false' }, fmtWeekday(addDays('2026-10-04', d), 'short'));
      b.addEventListener('click', () => {
        if (days.has(d)) days.delete(d); else days.add(d);
        b.setAttribute('aria-pressed', days.has(d) ? 'true' : 'false');
      });
      dayRow.appendChild(b);
    });
    const until = h('input', { type: 'date', class: 'v3-input', value: addDays(todayStr(), 84), 'aria-label': t('recur.until'), style: { maxWidth: '190px' } });
    const untilWrap = h('div', { class: 'row', hidden: true }, h('span', { class: 'small muted' }, t('recur.until')), until);
    toggle.addEventListener('change', () => {
      dayRow.hidden = !toggle.checked;
      untilWrap.hidden = !toggle.checked;
    });
    container.append(h('div', { class: 'field-check' }, toggle, h('label', { for: 'te-repeat' }, t('recur.repeatWeekly'))), dayRow, untilWrap);
    return {
      async afterSave(taskId, { fields, planDate }) {
        if (!toggle.checked) return;
        const dows = days.size ? [...days] : [dayOfWeek(planDate)];
        const rule = await saveRecurrenceRule(app().userId, null, {
          name: fields.name,
          minutes: fields.minutes_requested,
          priority: fields.priority,
          tags: fields.tags || [],
          course_id: fields.course_id || null,
          days_of_week: dows,
          start_date: planDate,
          end_date: until.value && until.value >= planDate ? until.value : addDays(planDate, 84),
          due_offset_days: fields.due_date && fields.due_date >= planDate ? Math.min(30, Math.round((Date.parse(fields.due_date) - Date.parse(planDate)) / 86400000)) : 0,
          active: true,
        });
        if (dows.includes(dayOfWeek(planDate))) await updateTask(taskId, { recurrence_rule_id: rule.id, recurrence_date: planDate });
        await generateRecurringTasks(app().userId, todayStr());
      },
    };
  },
});

// ---------------- break it down (V4-G) ----------------
registerTaskEditorSection({
  id: 'breakdown',
  render(container, { task }) {
    if (!task || task.done) return {};
    const btn = h('button', { type: 'button', class: 'btn btn--secondary btn--sm' });
    btn.innerHTML = icon('branch');
    btn.appendChild(h('span', {}, t('breakdown.open')));
    btn.addEventListener('click', async () => {
      const [{ closeAllDrawers }, { openBreakdown }] = await Promise.all([import('../ui/drawer.js'), import('./breakdownUI.js')]);
      closeAllDrawers();
      openBreakdown(task);
    });
    container.appendChild(h('div', { class: 'field' }, h('span', { class: 'field-label' }, t('breakdown.sectionTitle')), h('p', { class: 'field-hint' }, t('breakdown.sectionHint')), btn));
    return {};
  },
});
