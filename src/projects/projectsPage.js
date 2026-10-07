// Projects (V4-B): a list of projects (status views, search, space filter)
// and a project page with its tasks and milestones. Project tasks are the
// same tasks as everywhere else (study_subjects with a project_id) — they
// show in Tasks, the Planner and the Dashboard too.

import { t, tCount } from '../shared/i18n.js';
import { has } from '../shared/capabilities.js';
import { todayStr, addDays, minutesOfDay } from '../shared/dates.js';
import { app, onChange } from '../app/context.js';
import { html, raw, setHtml, on, safeColor } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { pageHead, emptyState, button, badge, progressBar, ring, skeletonRows, migrationNotice, errorNotice, segmented, wireSegmented } from '../ui/components.js';
import { fmtDate, fmtMinutes } from '../ui/format.js';
import { toast } from '../ui/toast.js';
import { listCourses, listBlocksForSubjectIds } from '../academics/academicsData.js';
import { buildTaskGroups } from '../tasks/taskModel.js';
import { setTaskDone } from '../tasks/tasksData.js';
import { openTaskEditor } from '../tasks/taskEditor.js';
import { taskRowHtml } from '../tasks/taskRow.js';
import { listProjects, listMilestones, listProjectTaskRows, updateProject, updateMilestone, saveProjectTaskOrder } from './projectsData.js';
import { computeProjectProgress, filterProjects, sortProjects, sortProjectTasks, reorderProjectTasks, projectDueState } from './projectModel.js';
import { openProjectEditor, openMilestoneEditor } from './projectEditors.js';
import { matchesSpace } from '../workspace/spacesModel.js';
import { currentSpaceFilter, spaceScopeNote } from '../workspace/spaceScope.js';

const VIEWS = ['open', 'all', 'completed', 'archived'];
const FILTER_KEY = 'student-scheduler-projects-filter';
const STATUS_KIND = { planned: 'outline', active: 'accent', on_hold: 'warning', completed: 'success', archived: 'outline' };

export function projectStatusBadge(status) {
  return badge(t(`projects.status_${status}`), STATUS_KIND[status] || 'outline');
}

function loadFilters() {
  try {
    const f = JSON.parse(localStorage.getItem(FILTER_KEY));
    return { view: VIEWS.includes(f && f.view) ? f.view : 'open', search: '' };
  } catch {
    return { view: 'open', search: '' };
  }
}
function saveFilters(f) {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify({ view: f.view })); } catch { /* per-viewer */ }
}

function spaceOf(id) {
  return (app().spaces() || []).find((s) => s.id === id) || null;
}

function headFor(subtitle = true) {
  return pageHead({
    eyebrow: t('nav.sectionWork'),
    title: t('nav.projects'),
    subtitle: subtitle ? t('projects.subtitle') : '',
    actions: has('projects') ? button(t('projects.new'), { variant: 'primary', action: 'new-project', iconName: 'plus' }) : '',
  });
}

async function loadAll() {
  const ctx = app();
  const today = todayStr();
  const [projects, milestones, rows, courses] = await Promise.all([
    listProjects(ctx.userId),
    listMilestones(ctx.userId),
    listProjectTaskRows(ctx.userId),
    has('courses') ? listCourses(ctx.userId).catch(() => []) : [],
  ]);
  const blocks = await listBlocksForSubjectIds(rows.map((r) => r.id)).catch(() => []);
  const groups = buildTaskGroups(rows, blocks, { today, nowMinutes: minutesOfDay(), todayScheduleIds: new Set(rows.filter((r) => r.for_date === today).map((r) => r.schedule_id)) });
  return { today, projects, milestones, groups, courses };
}

function progressOf(data, project) {
  return computeProjectProgress(project, data.groups.filter((g) => g.projectId === project.id), data.milestones.filter((m) => m.project_id === project.id));
}

function progressLine(p) {
  const parts = [tCount('projects.tasksDone', p.tasksTotal).replace('{done}', String(p.tasksDone))];
  if (p.milestonesTotal) parts.push(tCount('projects.milestonesDone', p.milestonesTotal).replace('{done}', String(p.milestonesDone)));
  return parts.join(' · ');
}

function dueBadge(project, today) {
  if (!project.due_date) return '';
  const st = projectDueState(project, today);
  return badge(st === 'overdue' ? t('projects.overdue') : t('projects.due').replace('{date}', fmtDate(project.due_date)), st === 'overdue' ? 'danger' : st === 'soon' ? 'warning' : 'outline');
}

export function initProjectsPage() {
  const root = document.getElementById('projectsView');
  if (!root) return null;
  let token = 0;
  let last = null;
  let currentId = null;
  let filters = loadFilters();

  async function render(id = currentId) {
    currentId = id;
    const my = ++token;
    if (!has('projects') || !has('projectLinks')) {
      setHtml(root, [headFor(), migrationNotice('projects')]);
      return;
    }
    if (!last) setHtml(root, [headFor(), skeletonRows(3, 110)]);
    let data;
    try {
      data = await loadAll();
    } catch (err) {
      console.error('Could not load projects', err);
      if (my === token) setHtml(root, [headFor(), errorNotice('', { retryAction: 'retry' })]);
      return;
    }
    if (my !== token) return;
    last = data;
    const project = id ? data.projects.find((p) => p.id === id) : null;
    if (project) renderDetail(project, data);
    else renderList(data);
  }

  // ---------------- list ----------------
  function renderList(data) {
    const space = currentSpaceFilter();
    const visible = sortProjects(filterProjects(data.projects, filters, (p) => matchesSpace(p.space_id || null, space)));
    const counts = Object.fromEntries(VIEWS.map((v) => [v, filterProjects(data.projects, { view: v }, (p) => matchesSpace(p.space_id || null, space)).length]));
    const toolbar = data.projects.length ? html`<div class="toolbar projects-toolbar">
      ${segmented('projectView', VIEWS.map((v) => ({ value: v, label: `${t(`projects.view_${v}`)}${counts[v] ? ` ${counts[v]}` : ''}` })), filters.view, { label: t('projects.filterLabel') })}
      <label class="sr-only" for="projectSearch">${t('projects.search')}</label>
      <input type="search" id="projectSearch" class="v3-input projects-search" placeholder="${t('projects.search')}" value="${filters.search}">
    </div>` : '';
    let body;
    if (!data.projects.length) {
      body = html`<div class="card">${emptyState({ iconName: 'briefcase', title: t('projects.emptyTitle'), body: t('projects.emptyBody'), actions: button(t('projects.new'), { variant: 'primary', action: 'new-project', iconName: 'plus' }) })}</div>`;
    } else if (!visible.length) {
      body = html`<div class="card">${emptyState({ iconName: 'search', title: t('projects.noneInFilter'), body: t('projects.noneInFilterBody'), compact: true })}</div>`;
    } else {
      body = html`<div class="project-grid">${visible.map((p) => {
        const pr = progressOf(data, p);
        const sp = spaceOf(p.space_id);
        return html`<a class="project-card${p.status === 'archived' ? ' is-archived' : ''}" href="#/projects/${p.id}" style="--c:${safeColor(sp && sp.color, '#335cff')}">
          <span class="project-card-top">
            ${projectStatusBadge(p.status)}
            ${p.priority === 'high' ? badge(t('projects.priority_high'), 'danger') : ''}
            ${sp ? html`<span class="project-space"><span class="project-space-dot" aria-hidden="true"></span>${sp.name}</span>` : ''}
          </span>
          <span class="project-card-title">${p.title}</span>
          ${p.description ? html`<span class="project-card-desc">${p.description}</span>` : ''}
          <span class="project-card-progress">
            ${progressBar(pr.percent / 100, { color: sp && sp.color ? sp.color : '', label: t('projects.progressLabel').replace('{n}', String(pr.percent)) })}
            <span class="project-card-stats"><strong>${t('projects.percent').replace('{n}', String(pr.percent))}</strong> · ${progressLine(pr)}</span>
          </span>
          <span class="project-card-foot">
            ${pr.next ? html`<span class="project-next">${raw(icon('target'))}${t('projects.nextMilestone').replace('{name}', pr.next.title)}${pr.next.due_date ? ` — ${fmtDate(pr.next.due_date)}` : ''}</span>` : html`<span></span>`}
            ${dueBadge(p, data.today)}
          </span>
        </a>`;
      })}</div>`;
    }
    setHtml(root, [headFor(), spaceScopeNote(), toolbar, body]);
    wireSegmented(root, 'projectView', (v) => {
      filters = { ...filters, view: v };
      saveFilters(filters);
      renderList(last);
    });
    const search = root.querySelector('#projectSearch');
    if (search) {
      search.addEventListener('input', () => {
        filters = { ...filters, search: search.value };
        const pos = search.selectionStart;
        renderList(last);
        const again = root.querySelector('#projectSearch');
        again.focus();
        again.setSelectionRange(pos, pos);
      });
    }
  }

  // ---------------- detail ----------------
  function renderDetail(project, data) {
    const groups = sortProjectTasks(data.groups.filter((g) => g.projectId === project.id));
    const milestones = data.milestones.filter((m) => m.project_id === project.id)
      .sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')));
    const pr = computeProjectProgress(project, groups, milestones);
    const sp = spaceOf(project.space_id);
    const courseById = new Map(data.courses.map((c) => [c.id, c]));
    const openTasks = groups.filter((g) => !g.done);
    const milestoneName = new Map(milestones.map((m) => [m.id, m.title]));
    const archived = project.status === 'archived';

    const header = html`<div class="project-head" style="--c:${safeColor(sp && sp.color, '#335cff')}">
      <a href="#/projects" class="back-link">${raw(icon('chevronLeft'))}${t('projects.all')}</a>
      <div class="project-head-row">
        <div class="project-head-text">
          <p class="page-eyebrow">${t('nav.projects')}</p>
          <h1 class="page-heading">${project.title}</h1>
          <p class="project-head-meta">
            ${projectStatusBadge(project.status)}
            ${badge(t(`projects.priority_${project.priority}`), project.priority === 'high' ? 'danger' : 'outline')}
            ${sp ? html`<span class="project-space"><span class="project-space-dot" aria-hidden="true"></span>${sp.name}</span>` : ''}
            ${project.start_date || project.due_date ? html`<span class="muted">${project.start_date ? fmtDate(project.start_date) : ''}${project.start_date && project.due_date ? ' – ' : ''}${project.due_date ? fmtDate(project.due_date) : ''}</span>` : ''}
            ${dueBadge(project, data.today)}
          </p>
        </div>
        <div class="page-head-actions">
          ${button(archived ? t('projects.unarchive') : t('projects.archive'), { action: 'toggle-archive', iconName: 'archive' })}
          ${button(t('common.edit'), { variant: 'primary', action: 'edit-project', iconName: 'edit' })}
        </div>
      </div>
      ${project.description ? html`<p class="project-desc">${project.description}</p>` : ''}
    </div>`;

    const summary = html`<section class="card project-summary" aria-label="${t('projects.progressTitle')}">
      ${ring(pr.percent / 100, { size: 72, stroke: 7, label: t('projects.percent').replace('{n}', String(pr.percent)) })}
      <div class="project-summary-text">
        <p class="project-summary-main"><strong>${t('projects.percentComplete').replace('{n}', String(pr.percent))}</strong>${pr.mode === 'manual' ? html` <span class="muted">· ${t('projects.setManually')}</span>` : ''}</p>
        <p>${progressLine(pr)}</p>
        ${pr.next ? html`<p>${t('projects.nextMilestone').replace('{name}', pr.next.title)}${pr.next.due_date ? ` — ${fmtDate(pr.next.due_date)}` : ''}</p>` : ''}
      </div>
      <dl class="project-times">
        <div><dt>${t('projects.timeEstimated')}</dt><dd>${pr.estimatedMinutes ? fmtMinutes(pr.estimatedMinutes) : '—'}</dd></div>
        <div><dt>${t('projects.timeActual')}</dt><dd>${pr.actualMinutes ? fmtMinutes(pr.actualMinutes) : '—'}</dd></div>
        <div><dt>${t('projects.timeRemaining')}</dt><dd>${pr.remainingMinutes ? fmtMinutes(pr.remainingMinutes) : '—'}</dd></div>
      </dl>
    </section>`;

    const tasksCard = html`<section class="card card-flush project-tasks" aria-labelledby="projTasksHead">
      <div class="card-head">
        <h2 class="card-title" id="projTasksHead">${t('projects.tasksTitle')} <span class="muted">${groups.length ? `${pr.tasksDone}/${groups.length}` : ''}</span></h2>
        ${button(t('projects.addTask'), { size: 'sm', action: 'add-task', iconName: 'plus' })}
      </div>
      ${groups.length ? html`<div class="list">${groups.map((g) => {
        const idx = openTasks.findIndex((x) => x.id === g.id);
        return html`<div class="project-task">
          ${taskRowHtml(g, { course: courseById.get(g.courseId), showCourse: Boolean(g.courseId), today: data.today })}
          ${g.milestoneId && milestoneName.get(g.milestoneId) ? html`<span class="project-task-ms">${raw(icon('target'))}${milestoneName.get(g.milestoneId)}</span>` : ''}
          ${!g.done && openTasks.length > 1 ? html`<span class="project-task-order">
            <button type="button" class="btn btn--ghost btn--icon btn--sm" data-action="move-up" data-task="${g.id}" aria-label="${t('projects.moveUp').replace('{name}', g.name)}"${idx === 0 ? raw(' disabled') : ''}>${raw(icon('chevronUp'))}</button>
            <button type="button" class="btn btn--ghost btn--icon btn--sm" data-action="move-down" data-task="${g.id}" aria-label="${t('projects.moveDown').replace('{name}', g.name)}"${idx === openTasks.length - 1 ? raw(' disabled') : ''}>${raw(icon('chevronDown'))}</button>
          </span>` : ''}
        </div>`;
      })}</div>` : emptyState({ iconName: 'tasks', title: t('projects.noTasksTitle'), body: t('projects.noTasksBody'), compact: true })}
    </section>`;

    const msCard = html`<section class="card card-flush project-milestones" aria-labelledby="projMsHead">
      <div class="card-head">
        <h2 class="card-title" id="projMsHead">${t('projects.milestonesTitle')} <span class="muted">${milestones.length ? `${pr.milestonesDone}/${milestones.length}` : ''}</span></h2>
        ${button(t('projects.addMilestone'), { size: 'sm', action: 'add-milestone', iconName: 'plus' })}
      </div>
      ${milestones.length ? html`<ul class="list milestone-list">${milestones.map((m) => html`<li class="list-row milestone-row${m.status === 'done' ? ' is-done' : ''}">
        <button type="button" class="task-check${m.status === 'done' ? ' is-checked' : ''}" data-action="toggle-milestone" data-ms="${m.id}" aria-pressed="${m.status === 'done' ? 'true' : 'false'}" aria-label="${m.status === 'done' ? t('projects.milestoneReopen') : t('projects.milestoneComplete')}: ${m.title}">${raw(icon('check'))}</button>
        <button type="button" class="list-row-main task-open" data-action="edit-milestone" data-ms="${m.id}">
          <span class="list-row-title">${m.title}</span>
          ${m.description ? html`<span class="list-row-meta"><span>${m.description}</span></span>` : ''}
        </button>
        <span class="list-row-side">${m.due_date ? badge(fmtDate(m.due_date), m.status !== 'done' && m.due_date < data.today ? 'danger' : 'outline') : ''}</span>
      </li>`)}</ul>` : emptyState({ iconName: 'target', title: t('projects.noMilestonesTitle'), body: t('projects.noMilestonesBody'), compact: true })}
    </section>`;

    setHtml(root, [header, summary, html`<div class="project-columns">${tasksCard}${msCard}</div>`]);
    root.dataset.projectId = project.id;
  }

  // ---------------- actions ----------------
  on(root, 'click', '[data-action]', async (e, el) => {
    const a = el.dataset.action;
    const data = last;
    const project = data && currentId ? data.projects.find((p) => p.id === currentId) : null;
    if (a === 'retry') render();
    else if (a === 'new-project') openProjectEditor({ onSaved: (p) => p && app().navigate('projectsView', p.id) });
    else if (a === 'edit-project' && project) openProjectEditor({ project, onSaved: () => render(), onDeleted: () => app().navigate('projectsView') });
    else if (a === 'toggle-archive' && project) {
      const next = project.status === 'archived' ? 'active' : 'archived';
      try {
        await updateProject(project.id, { status: next });
        toast(next === 'archived' ? t('projects.archivedToast') : t('projects.unarchivedToast'), { kind: 'success' });
        render();
      } catch (err) {
        console.error(err);
        toast(t('v3.saveError'), { kind: 'error' });
      }
    } else if (a === 'add-task' && project) {
      openTaskEditor({ defaults: { projectId: project.id, spaceId: project.space_id || '', planDate: todayStr() }, onSaved: () => render() });
    } else if (a === 'add-milestone' && project) openMilestoneEditor({ projectId: project.id, onSaved: () => render() });
    else if (a === 'edit-milestone') {
      const m = data.milestones.find((x) => x.id === el.dataset.ms);
      if (m) openMilestoneEditor({ projectId: m.project_id, milestone: m, onSaved: () => render() });
    } else if (a === 'toggle-milestone') {
      const m = data.milestones.find((x) => x.id === el.dataset.ms);
      if (!m) return;
      try {
        await updateMilestone(m.id, { status: m.status === 'done' ? 'open' : 'done' });
        if (m.status !== 'done') toast(t('projects.milestoneDone').replace('{name}', m.title), { kind: 'success' });
        await render();
        root.querySelector(`[data-action="toggle-milestone"][data-ms="${m.id}"]`)?.focus();
      } catch (err) {
        console.error(err);
        toast(t('v3.saveError'), { kind: 'error' });
      }
    } else if (a === 'open-task' || a === 'toggle-done') {
      const row = el.closest('[data-task-id]');
      const g = row && data.groups.find((x) => x.id === row.dataset.taskId);
      if (!g) return;
      if (a === 'open-task') openTaskEditor({ task: g, onSaved: () => render() });
      else {
        try {
          await setTaskDone(g.root.id, !g.done);
          // Same feedback as the Tasks page: Marked done / Reopened, with Undo.
          toast(g.done ? t('tasks.reopened') : t('tasks.markedDone'), {
            kind: 'success',
            actionLabel: t('common.undo'),
            onAction: async () => {
              await setTaskDone(g.root.id, g.done);
              render();
            },
          });
          await render();
          root.querySelector(`[data-task-id="${g.id}"] [data-action="toggle-done"]`)?.focus();
        } catch (err) {
          console.error(err);
          toast(err.code === 'needs_migration' ? t('v3.needsUpdateTitle') : t('v3.saveError'), { kind: 'error' });
        }
      }
    } else if ((a === 'move-up' || a === 'move-down') && project) {
      const groups = data.groups.filter((g) => g.projectId === project.id);
      const updates = reorderProjectTasks(groups, el.dataset.task, a === 'move-up' ? 'up' : 'down');
      if (!updates.length) return;
      try {
        await saveProjectTaskOrder(updates);
        await render();
        root.querySelector(`[data-action="${a}"][data-task="${el.dataset.task}"]:not([disabled])`)?.focus();
      } catch (err) {
        console.error(err);
        toast(t('v3.saveError'), { kind: 'error' });
      }
    }
  });

  onChange((topic) => {
    if (!root.hidden && ['projects', 'tasks', 'spaces'].includes(topic)) render();
  });

  return { onShow: (param) => render(param || null) };
}
