// Tasks (V3-H): every task across days in one place — grouped by when it's
// due, filterable by course/tag/priority, with completion, dependencies
// ("Waiting on Outline"), subtasks, links and recurring academic tasks.
// Tasks are still study_subjects rows that live on a Planner day.

import { t } from '../shared/i18n.js';
import { has } from '../shared/capabilities.js';
import { todayStr, addDays, diffDays, startOfWeek, minutesOfDay } from '../shared/dates.js';
import { app, onChange } from '../app/context.js';
import { html, raw, setHtml, on, h, debounce } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { pageHead, emptyState, button, skeletonRows, errorNotice, segmented, wireSegmented } from '../ui/components.js';
import { fmtMinutes, fmtWeekday, fmtDate } from '../ui/format.js';
import { toast } from '../ui/toast.js';
import { openDrawer, confirmAction } from '../ui/drawer.js';
import { listTaskRowsInWindow, listBlocksForSubjectIds, listCourses } from '../academics/academicsData.js';
import { sortCourses } from '../academics/courseModel.js';
import { buildTaskGroups, sortTaskGroups } from './taskModel.js';
import { computeBlockedState } from './dependencyModel.js';
import { validateRuleFields, describeRuleDays } from './recurringModel.js';
import { listDependencies, setTaskDone, listRecurrenceRules, saveRecurrenceRule, deleteRecurrenceRule, generateRecurringTasks } from './tasksData.js';
import { openTaskEditor } from './taskEditor.js';
import { taskRowHtml } from './taskRow.js';
import { tagLabel } from './taskEditorSections.js';
import { matchesSpace, effectiveSpaceId } from '../workspace/spacesModel.js';
import { currentSpaceFilter, spaceScopeNote } from '../workspace/spaceScope.js';
import { listProjects, listProjectTaskRows } from '../projects/projectsData.js';

const VIEWS = ['today', 'upcoming', 'overdue', 'open', 'done'];
const FILTER_KEY = 'student-scheduler-tasks-filters';

function loadFilters() {
  try {
    const f = JSON.parse(localStorage.getItem(FILTER_KEY) || '{}');
    return { view: VIEWS.includes(f.view) ? f.view : 'open', course: f.course || '', project: f.project || '', tag: f.tag || '', priority: f.priority || '', search: '' };
  } catch {
    return { view: 'open', course: '', project: '', tag: '', priority: '', search: '' };
  }
}

function saveFilters(f) {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify({ view: f.view, course: f.course, project: f.project, tag: f.tag, priority: f.priority }));
  } catch { /* per-viewer convenience only */ }
}

// Which due-date bucket a task falls into.
export function dueBucket(group, today) {
  if (group.done) return 'done';
  if (!group.dueDate) return 'noDate';
  const d = diffDays(today, group.dueDate);
  if (d < 0) return 'overdue';
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (group.dueDate <= addDays(startOfWeek(today), 6)) return 'thisWeek';
  if (d <= 14) return 'nextTwoWeeks';
  return 'later';
}
const BUCKET_ORDER = ['overdue', 'today', 'tomorrow', 'thisWeek', 'nextTwoWeeks', 'later', 'noDate', 'done'];

export function filterTaskGroups(groups, filters, today, courseById = new Map(), projectById = new Map()) {
  const q = (filters.search || '').trim().toLowerCase();
  return groups.filter((g) => {
    // V4: the sidebar's space switcher (a task inherits its project's, then its course's space).
    if (filters.space && !matchesSpace(effectiveSpaceId(g, courseById, projectById), filters.space)) return false;
    if (filters.project === '__none' && g.projectId) return false;
    if (filters.project && filters.project !== '__none' && g.projectId !== filters.project) return false;
    if (filters.view === 'done' && !g.done) return false;
    if (filters.view !== 'done' && g.done) return false;
    if (filters.view === 'today' && !(g.dueDate === today || g.dates.includes(today) || g.overdue)) return false;
    if (filters.view === 'overdue' && !g.overdue) return false;
    if (filters.view === 'upcoming' && !(g.dueDate && g.dueDate > today && g.dueDate <= addDays(today, 14))) return false;
    if (filters.course === '__none' && g.courseId) return false;
    if (filters.course && filters.course !== '__none' && g.courseId !== filters.course) return false;
    if (filters.tag && !g.tags.includes(filters.tag)) return false;
    if (filters.priority && g.priority !== filters.priority) return false;
    if (q) {
      const course = courseById.get(g.courseId);
      const project = projectById.get(g.projectId);
      const hay = [g.name, g.notes, ...(g.tags || []), course ? course.name : '', course ? course.code : '', project ? project.title : ''].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function initTasksPage() {
  const root = document.getElementById('tasksView');
  if (!root) return null;
  let token = 0;
  let filters = loadFilters();
  let last = null;
  let generatedToday = null;

  async function load() {
    const ctx = app();
    const today = todayStr();
    // Recurring tasks for the next two weeks are created on first visit
    // each day (idempotent — never duplicates).
    if (generatedToday !== today) {
      generatedToday = today;
      try {
        const n = await generateRecurringTasks(ctx.userId, today);
        if (n) toast(t('recur.generated').replace('{n}', String(n)), { kind: 'success' });
      } catch (err) {
        console.error('Recurring task generation failed', err);
      }
    }
    const [windowRows, courses, deps, rules, projects, projectRows] = await Promise.all([
      listTaskRowsInWindow(ctx.userId, addDays(today, -60), addDays(today, 120)),
      has('courses') ? listCourses(ctx.userId).catch(() => []) : [],
      listDependencies(ctx.userId).catch(() => []),
      listRecurrenceRules(ctx.userId).catch(() => []),
      listProjects(ctx.userId).catch(() => []),
      listProjectTaskRows(ctx.userId).catch(() => []),
    ]);
    // Every project task belongs on this page, even one planned long ago.
    const byId = new Map(windowRows.map((r) => [r.id, r]));
    projectRows.forEach((r) => { if (!byId.has(r.id)) byId.set(r.id, r); });
    const rows = [...byId.values()];
    const blocks = await listBlocksForSubjectIds(rows.map((r) => r.id));
    const todayScheduleIds = new Set(rows.filter((r) => r.for_date === today).map((r) => r.schedule_id));
    const groups = sortTaskGroups(buildTaskGroups(rows, blocks, { today, nowMinutes: minutesOfDay(), todayScheduleIds }));
    const blocked = computeBlockedState(groups, deps);
    return { today, groups, courses: sortCourses(courses), deps, rules, blocked, projects };
  }

  async function render() {
    const my = ++token;
    const head = pageHead({
      eyebrow: t('nav.sectionWork'),
      title: t('nav.tasks'),
      subtitle: t('tasks.pageSubtitle'),
      actions: [
        has('recurringTasks') ? button(t('recur.manage'), { action: 'manage-rules', iconName: 'repeat' }) : '',
        button(t('tasks.addTask'), { variant: 'primary', action: 'add-task', iconName: 'plus' }),
      ],
    });
    if (!last) setHtml(root, [head, skeletonRows(6, 52)]);
    let data;
    try {
      data = await load();
    } catch (err) {
      console.error('Could not load tasks', err);
      if (my === token) setHtml(root, [head, errorNotice('', { retryAction: 'retry' })]);
      return;
    }
    if (my !== token) return;
    last = data;
    draw(head);
  }

  function draw(head) {
    const data = last;
    const courseById = new Map(data.courses.map((c) => [c.id, c]));
    const projectById = new Map(data.projects.map((p) => [p.id, p]));
    const scoped = { ...filters, space: currentSpaceFilter() };
    const filtered = filterTaskGroups(data.groups, scoped, data.today, courseById, projectById);
    const counts = Object.fromEntries(VIEWS.map((v) => [v, filterTaskGroups(data.groups, { ...scoped, view: v, search: '' }, data.today, courseById, projectById).length]));
    const tags = [...new Set(data.groups.flatMap((g) => g.tags))].sort();
    const remaining = filtered.filter((g) => !g.done).reduce((s, g) => s + g.remainingMinutes, 0);

    const toolbar = html`<div class="toolbar tasks-toolbar">
      ${segmented('taskView', VIEWS.map((v) => ({ value: v, label: `${t(`tasks.view_${v}`)}${counts[v] ? ` ${counts[v]}` : ''}` })), filters.view, { label: t('tasks.filterLabel') })}
      <span class="toolbar-spacer"></span>
      <label class="sr-only" for="tasksSearch">${t('tasks.search')}</label>
      <input type="search" id="tasksSearch" class="search-input" placeholder="${t('tasks.search')}" value="${filters.search}" autocomplete="off">
    </div>
    <div class="toolbar tasks-filters">
      ${data.courses.length ? html`<label class="sr-only" for="tasksCourse">${t('tasks.fieldCourse')}</label><select id="tasksCourse" class="v3-input filter-select">
        <option value="">${t('tasks.allCourses')}</option>
        ${data.courses.filter((c) => !c.archived).map((c) => html`<option value="${c.id}"${filters.course === c.id ? raw(' selected') : ''}>${c.code || c.name}</option>`)}
        <option value="__none"${filters.course === '__none' ? raw(' selected') : ''}>${t('tasks.noCourse')}</option>
      </select>` : ''}
      ${data.projects.length ? html`<label class="sr-only" for="tasksProject">${t('tasks.fieldProject')}</label><select id="tasksProject" class="v3-input filter-select">
        <option value="">${t('tasks.allProjects')}</option>
        ${data.projects.filter((p) => p.status !== 'archived').map((p) => html`<option value="${p.id}"${filters.project === p.id ? raw(' selected') : ''}>${p.title}</option>`)}
        <option value="__none"${filters.project === '__none' ? raw(' selected') : ''}>${t('tasks.noProject')}</option>
      </select>` : ''}
      ${tags.length ? html`<label class="sr-only" for="tasksTag">${t('tasks.sectionTags')}</label><select id="tasksTag" class="v3-input filter-select">
        <option value="">${t('tasks.allTags')}</option>
        ${tags.map((tag) => html`<option value="${tag}"${filters.tag === tag ? raw(' selected') : ''}>${tagLabel(tag)}</option>`)}
      </select>` : ''}
      <label class="sr-only" for="tasksPriority">${t('tasks.fieldPriority')}</label>
      <select id="tasksPriority" class="v3-input filter-select">
        <option value="">${t('tasks.allPriorities')}</option>
        ${['high', 'medium', 'low'].map((p) => html`<option value="${p}"${filters.priority === p ? raw(' selected') : ''}>${t(`taskFilter.priority${p[0].toUpperCase()}${p.slice(1)}`)}</option>`)}
      </select>
      <span class="toolbar-spacer"></span>
      <span class="small muted">${filters.view === 'done' ? t('tasks.countDone').replace('{n}', String(filtered.length)) : t('tasks.countOpen').replace('{n}', String(filtered.length)).replace('{time}', fmtMinutes(remaining))}</span>
    </div>`;

    let body;
    if (!data.groups.length) {
      body = html`<div class="card">${emptyState({ iconName: 'tasks', title: t('tasks.emptyTitle'), body: t('tasks.emptyBody'), actions: button(t('tasks.addTask'), { variant: 'primary', action: 'add-task', iconName: 'plus' }) })}</div>`;
    } else if (!filtered.length) {
      body = html`<div class="card">${emptyState({ iconName: 'check', title: filters.view === 'overdue' ? t('tasks.noneOverdue') : filters.view === 'today' ? t('tasks.noneToday') : t('tasks.noneMatch'), body: t('tasks.noneMatchBody'), compact: true })}</div>`;
    } else {
      const buckets = {};
      filtered.forEach((g) => { (buckets[dueBucket(g, data.today)] ||= []).push(g); });
      body = BUCKET_ORDER.filter((b) => buckets[b]).map((b) => html`<section class="task-bucket">
        <h2 class="task-bucket-title${b === 'overdue' ? ' is-danger' : ''}">${t(`tasks.bucket_${b}`)} <span class="muted">${buckets[b].length}</span></h2>
        <div class="card card-flush"><div class="list">${buckets[b].map((g) => taskRowHtml(g, { course: courseById.get(g.courseId), showCourse: true, project: projectById.get(g.projectId), blockedInfo: data.blocked.get(g.id), today: data.today }))}</div></div>
      </section>`);
    }
    setHtml(root, [head || pageHead({ eyebrow: t('nav.sectionWork'), title: t('nav.tasks') }), spaceScopeNote(), toolbar, body]);
    wireSegmented(root, 'taskView', (v) => { filters.view = v; saveFilters(filters); draw(headCache); });
    const search = root.querySelector('#tasksSearch');
    search.addEventListener('input', debounce(() => {
      filters.search = search.value;
      draw(headCache);
      const again = root.querySelector('#tasksSearch');
      again.focus();
      again.setSelectionRange(again.value.length, again.value.length);
    }, 150));
    [['#tasksCourse', 'course'], ['#tasksProject', 'project'], ['#tasksTag', 'tag'], ['#tasksPriority', 'priority']].forEach(([sel, key]) => {
      const el = root.querySelector(sel);
      if (el) el.addEventListener('change', () => { filters[key] = el.value; saveFilters(filters); draw(headCache); });
    });
    headCache = head || headCache;
  }
  let headCache = null;

  // ---------------- recurring rules drawer ----------------
  function openRulesDrawer() {
    openDrawer({
      title: t('recur.manage'),
      subtitle: t('recur.manageHint'),
      size: 'wide',
      render: async (body, api) => {
        const rules = await listRecurrenceRules(app().userId);
        const courseById = new Map((last ? last.courses : []).map((c) => [c.id, c]));
        body.innerHTML = '';
        if (!rules.length) {
          const empty = document.createElement('div');
          setHtml(empty, emptyState({ iconName: 'repeat', title: t('recur.emptyTitle'), body: t('recur.emptyBody'), compact: true }));
          body.appendChild(empty);
        }
        rules.forEach((rule) => {
          const course = courseById.get(rule.course_id);
          const edit = h('button', { type: 'button', class: 'btn btn--secondary btn--sm' }, t('common.edit'));
          edit.addEventListener('click', () => { api.close(true); openRuleEditor(rule); });
          body.appendChild(h('div', { class: 'list-row' },
            h('span', { class: 'list-row-main' },
              h('span', { class: 'list-row-title' }, rule.name),
              h('span', { class: 'list-row-meta' }, `${describeRuleDays(rule, (d) => fmtWeekday(addDays('2026-10-04', d), 'short'))} · ${fmtMinutes(rule.minutes)}${course ? ` · ${course.code || course.name}` : ''} · ${fmtDate(rule.start_date)} – ${fmtDate(rule.end_date)}${rule.active ? '' : ` · ${t('recur.paused')}`}`)),
            edit));
        });
      },
      actions: [
        { label: t('common.close'), variant: 'secondary', onClick: (api) => api.close() },
        { label: t('recur.newRule'), variant: 'primary', onClick: (api) => { api.close(true); openRuleEditor(null); } },
      ],
    });
  }

  function openRuleEditor(rule) {
    const today = todayStr();
    const days = new Set(rule ? rule.days_of_week.map(Number) : []);
    openDrawer({
      title: rule ? t('recur.editRule') : t('recur.newRule'),
      subtitle: t('recur.ruleHint'),
      render: (body) => {
        body.appendChild(h('div', { class: 'field' }, h('label', { for: 'rr-name' }, t('common.name')), h('input', { type: 'text', id: 'rr-name', maxlength: '200', 'data-autofocus': true, value: rule ? rule.name : '', placeholder: t('recur.namePlaceholder') })));
        const dayRow = h('div', { class: 'day-toggle-row', role: 'group', 'aria-label': t('courses.meetingDays') });
        [1, 2, 3, 4, 5, 6, 0].forEach((d) => {
          const b = h('button', { type: 'button', class: 'day-toggle', 'aria-pressed': days.has(d) ? 'true' : 'false' }, fmtWeekday(addDays('2026-10-04', d), 'short'));
          b.addEventListener('click', () => { if (days.has(d)) days.delete(d); else days.add(d); b.setAttribute('aria-pressed', days.has(d) ? 'true' : 'false'); });
          dayRow.appendChild(b);
        });
        body.appendChild(h('div', { class: 'field' }, h('span', { class: 'field-label' }, t('courses.meetingDays')), dayRow));
        const g = h('div', { class: 'field-grid' });
        g.appendChild(h('div', { class: 'field' }, h('label', { for: 'rr-min' }, t('tasks.fieldMinutes')), h('input', { type: 'number', id: 'rr-min', min: '5', max: '1440', step: '5', value: String(rule ? rule.minutes : 45) })));
        g.appendChild(h('div', { class: 'field' }, h('label', { for: 'rr-offset' }, t('recur.dueOffset')), h('input', { type: 'number', id: 'rr-offset', min: '0', max: '30', step: '1', value: String(rule ? rule.due_offset_days : 0) })));
        g.appendChild(h('div', { class: 'field' }, h('label', { for: 'rr-start' }, t('courses.fromDate')), h('input', { type: 'date', id: 'rr-start', value: rule ? rule.start_date : today })));
        g.appendChild(h('div', { class: 'field' }, h('label', { for: 'rr-end' }, t('courses.toDate')), h('input', { type: 'date', id: 'rr-end', value: rule ? rule.end_date : addDays(today, 84) })));
        body.appendChild(g);
        if (last && last.courses.length) {
          const sel = h('select', { id: 'rr-course' }, h('option', { value: '' }, t('tasks.noCourse')));
          last.courses.filter((c) => !c.archived).forEach((c) => sel.appendChild(h('option', { value: c.id }, c.code ? `${c.code} — ${c.name}` : c.name)));
          sel.value = rule ? rule.course_id || '' : '';
          body.appendChild(h('div', { class: 'field' }, h('label', { for: 'rr-course' }, t('tasks.fieldCourse')), sel));
        }
        const active = h('input', { type: 'checkbox', id: 'rr-active' });
        active.checked = rule ? rule.active : true;
        body.appendChild(h('div', { class: 'field-check' }, active, h('label', { for: 'rr-active' }, t('recur.active'))));
        body.appendChild(h('p', { class: 'field-error', id: 'rr-error', role: 'alert' }));
      },
      actions: [
        ...(rule ? [{
          label: t('common.delete'), variant: 'danger', start: true,
          onClick: async (api) => {
            const ok = await confirmAction({ title: t('recur.deleteTitle'), message: t('recur.deleteBody'), confirmLabel: t('common.delete'), danger: true });
            if (!ok) return;
            try {
              await deleteRecurrenceRule(rule.id);
              api.close(true);
              toast(t('common.deleted'));
              render();
            } catch {
              toast(t('v3.deleteError'), { kind: 'error' });
            }
          },
        }] : []),
        { label: t('common.cancel'), variant: 'secondary', onClick: (api) => api.close() },
        {
          label: t('common.save'), variant: 'primary',
          onClick: async (api) => {
            const b = api.body;
            const { ok, errors, fields } = validateRuleFields({
              name: b.querySelector('#rr-name').value,
              days_of_week: [...days],
              minutes: b.querySelector('#rr-min').value,
              due_offset_days: Number(b.querySelector('#rr-offset').value),
              start_date: b.querySelector('#rr-start').value,
              end_date: b.querySelector('#rr-end').value,
              course_id: b.querySelector('#rr-course') ? b.querySelector('#rr-course').value : null,
              priority: rule ? rule.priority : 'medium',
              tags: rule ? rule.tags : [],
              active: b.querySelector('#rr-active').checked,
            });
            b.querySelector('#rr-error').textContent = ok ? '' : Object.values(errors).map((k) => t(k)).join(' ');
            if (!ok) return;
            api.setBusy(true);
            try {
              await saveRecurrenceRule(app().userId, rule ? rule.id : null, fields);
              const n = await generateRecurringTasks(app().userId, todayStr());
              api.close(true);
              toast(n ? t('recur.generated').replace('{n}', String(n)) : t('common.savedShort'), { kind: 'success' });
              render();
            } catch (err) {
              console.error(err);
              b.querySelector('#rr-error').textContent = t('v3.saveError');
              api.setBusy(false);
            }
          },
        },
      ],
    });
  }

  on(root, 'click', '[data-action]', async (e, el) => {
    const action = el.dataset.action;
    if (action === 'retry') render();
    else if (action === 'add-task') openTaskEditor({ defaults: { courseId: filters.course && filters.course !== '__none' ? filters.course : null, projectId: filters.project && filters.project !== '__none' ? filters.project : null }, onSaved: () => render() });
    else if (action === 'manage-rules') openRulesDrawer();
    else if (action === 'open-task' || action === 'toggle-done') {
      const id = el.closest('[data-task-id]').dataset.taskId;
      const group = last && last.groups.find((g) => g.id === id);
      if (!group) return;
      if (action === 'open-task') {
        openTaskEditor({ task: group, onSaved: () => render() });
        return;
      }
      el.disabled = true;
      try {
        await setTaskDone(group.root.id, !group.done);
        const blockedDependents = !group.done ? (last.blocked.get(group.id) || { dependentIds: [] }).dependentIds.length : 0;
        toast(group.done ? t('tasks.reopened') : blockedDependents ? t('deps.unlockedToast').replace('{n}', String(blockedDependents)) : t('tasks.markedDone'), {
          kind: 'success',
          actionLabel: t('common.undo'),
          onAction: async () => {
            await setTaskDone(group.root.id, group.done);
            render();
          },
        });
        render();
      } catch (err) {
        console.error(err);
        el.disabled = false;
        toast(t('v3.saveError'), { kind: 'error' });
      }
    }
  });

  onChange((topic) => {
    if (!root.hidden && ['tasks', 'courses'].includes(topic)) render();
  });

  return { onShow: () => render() };
}
