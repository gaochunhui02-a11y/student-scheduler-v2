// Goals (V4-C): a list of goals (status views, search, space filter) and a
// goal page showing what moves it forward — linked projects, linked tasks,
// goal milestones, check-ins (numeric goals) and routines that serve it.
// Tasks and projects stay what they are everywhere else; a goal only links.

import { t, tCount } from '../shared/i18n.js';
import { has } from '../shared/capabilities.js';
import { todayStr, minutesOfDay } from '../shared/dates.js';
import { app, onChange } from '../app/context.js';
import { html, raw, setHtml, on, safeColor } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { pageHead, emptyState, button, badge, progressBar, ring, skeletonRows, migrationNotice, errorNotice, segmented, wireSegmented } from '../ui/components.js';
import { fmtDate } from '../ui/format.js';
import { toast } from '../ui/toast.js';
import { confirmAction } from '../ui/drawer.js';
import { listCourses, listBlocksForSubjectIds } from '../academics/academicsData.js';
import { buildTaskGroups } from '../tasks/taskModel.js';
import { setTaskDone } from '../tasks/tasksData.js';
import { openTaskEditor } from '../tasks/taskEditor.js';
import { taskRowHtml } from '../tasks/taskRow.js';
import { listProjects, listMilestones, listProjectTaskRows, updateProject } from '../projects/projectsData.js';
import { computeProjectProgress } from '../projects/projectModel.js';
import { projectStatusBadge } from '../projects/projectsPage.js';
import { openProjectEditor } from '../projects/projectEditors.js';
import { listRoutines, listRecentCompletions } from '../routines/routinesData.js';
import { computeStreak, completionRate } from '../routines/routineModel.js';
import { listGoals, listGoalMilestones, listGoalLogs, listGoalTaskRows, updateGoal, updateGoalMilestone, deleteCheckIn } from './goalsData.js';
import { computeGoalProgress, goalPace, filterGoals, sortGoals, nextGoalMilestone, formatValue, sortLogs } from './goalModel.js';
import { openGoalEditor, openGoalMilestoneEditor, openCheckInEditor, openLinkProjectDialog } from './goalEditors.js';
import { matchesSpace } from '../workspace/spacesModel.js';
import { currentSpaceFilter, spaceScopeNote } from '../workspace/spaceScope.js';

const VIEWS = ['active', 'all', 'achieved', 'archived'];
const FILTER_KEY = 'student-scheduler-goals-filter';
const STATUS_KIND = { active: 'accent', on_hold: 'warning', achieved: 'success', archived: 'outline' };
const PACE_KIND = { ahead: 'success', on_track: 'accent', behind: 'warning', overdue: 'danger' };

export function goalStatusBadge(status) {
  return badge(t(`goals.status_${status}`), STATUS_KIND[status] || 'outline');
}

function loadFilters() {
  try {
    const f = JSON.parse(localStorage.getItem(FILTER_KEY));
    return { view: VIEWS.includes(f && f.view) ? f.view : 'active', search: '' };
  } catch {
    return { view: 'active', search: '' };
  }
}
function saveFilters(f) {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify({ view: f.view })); } catch { /* per-viewer */ }
}

const spaceOf = (id) => (app().spaces() || []).find((s) => s.id === id) || null;

function headFor() {
  return pageHead({
    eyebrow: t('nav.sectionWork'),
    title: t('nav.goals'),
    subtitle: t('goals.subtitle'),
    actions: has('goals') ? button(t('goals.new'), { variant: 'primary', action: 'new-goal', iconName: 'plus' }) : '',
  });
}

export async function loadGoalsData() {
  const ctx = app();
  const today = todayStr();
  const projectsOn = has('projects') && has('projectLinks');
  const [goals, milestones, logs, goalRows, projects, projMilestones, projRows, routines, completions, courses] = await Promise.all([
    listGoals(ctx.userId),
    listGoalMilestones(ctx.userId),
    listGoalLogs(ctx.userId),
    listGoalTaskRows(ctx.userId),
    projectsOn ? listProjects(ctx.userId).catch(() => []) : [],
    projectsOn ? listMilestones(ctx.userId).catch(() => []) : [],
    projectsOn ? listProjectTaskRows(ctx.userId).catch(() => []) : [],
    has('routines') ? listRoutines(ctx.userId).catch(() => []) : [],
    has('routines') ? listRecentCompletions(ctx.userId, today).catch(() => []) : [],
    has('courses') ? listCourses(ctx.userId).catch(() => []) : [],
  ]);
  // One set of task groups for goal tasks and project tasks (a row can be both).
  const byId = new Map([...goalRows, ...projRows].map((r) => [r.id, r]));
  const rows = [...byId.values()];
  const blocks = await listBlocksForSubjectIds(rows.map((r) => r.id)).catch(() => []);
  const groups = buildTaskGroups(rows, blocks, { today, nowMinutes: minutesOfDay(), todayScheduleIds: new Set(rows.filter((r) => r.for_date === today).map((r) => r.schedule_id)) });
  const projectPct = new Map(projects.map((p) => [p.id, computeProjectProgress(p, groups.filter((g) => g.projectId === p.id), projMilestones.filter((m) => m.project_id === p.id)).percent]));
  return { today, goals, milestones, logs, groups, projects, projectPct, routines, completions, courses };
}

function linkedOf(data, goal) {
  const projects = data.projects.filter((p) => p.goal_id === goal.id && p.status !== 'archived');
  return {
    tasks: data.groups.filter((g) => g.goalId === goal.id),
    projects,
    projectInputs: projects.map((p) => ({ percent: data.projectPct.get(p.id) || 0 })),
    milestones: data.milestones.filter((m) => m.goal_id === goal.id),
    logs: data.logs.filter((l) => l.goal_id === goal.id),
    routines: data.routines.filter((r) => r.goal_id === goal.id && !r.archived),
  };
}

export function goalProgressOf(data, goal) {
  const l = linkedOf(data, goal);
  const pr = computeGoalProgress(goal, { tasks: l.tasks, projects: l.projectInputs, milestones: l.milestones, logs: l.logs });
  return { pr, l, pace: goalPace(goal, pr, data.today) };
}

function measureLine(goal, pr) {
  if (pr.mode === 'numeric') {
    const unit = goal.unit ? ` ${goal.unit}` : '';
    return t('goals.measureNumeric').replace('{value}', formatValue(pr.value)).replace('{target}', formatValue(goal.target_value)).replace('{unit}', unit);
  }
  const parts = [];
  if (pr.projectsTotal) parts.push(tCount('goals.projectsCount', pr.projectsTotal).replace('{done}', String(pr.projectsDone)));
  if (pr.tasksTotal) parts.push(tCount('goals.tasksCount', pr.tasksTotal).replace('{done}', String(pr.tasksDone)));
  if (pr.milestonesTotal) parts.push(tCount('goals.milestonesCount', pr.milestonesTotal).replace('{done}', String(pr.milestonesDone)));
  if (!parts.length && pr.mode === 'auto') return t('goals.nothingLinked');
  return parts.join(' · ');
}

function paceBadge(pace) {
  return pace ? badge(t(`goals.pace_${pace.state}`), PACE_KIND[pace.state]) : '';
}

export function initGoalsPage() {
  const root = document.getElementById('goalsView');
  if (!root) return null;
  let token = 0;
  let last = null;
  let currentId = null;
  let filters = loadFilters();

  async function render(id = currentId) {
    currentId = id;
    const my = ++token;
    if (!has('goals') || !has('goalLinks')) {
      setHtml(root, [headFor(), migrationNotice('goals')]);
      return;
    }
    if (!last) setHtml(root, [headFor(), skeletonRows(3, 110)]);
    let data;
    try {
      data = await loadGoalsData();
    } catch (err) {
      console.error('Could not load goals', err);
      if (my === token) setHtml(root, [headFor(), errorNotice('', { retryAction: 'retry' })]);
      return;
    }
    if (my !== token) return;
    last = data;
    const goal = id ? data.goals.find((g) => g.id === id) : null;
    if (goal) renderDetail(goal, data);
    else renderList(data);
  }

  // ---------------- list ----------------
  function renderList(data) {
    const space = currentSpaceFilter();
    const inSpace = (g) => matchesSpace(g.space_id || null, space);
    const visible = sortGoals(filterGoals(data.goals, filters, inSpace));
    const counts = Object.fromEntries(VIEWS.map((v) => [v, filterGoals(data.goals, { view: v }, inSpace).length]));
    const toolbar = data.goals.length ? html`<div class="toolbar projects-toolbar">
      ${segmented('goalView', VIEWS.map((v) => ({ value: v, label: `${t(`goals.view_${v}`)}${counts[v] ? ` ${counts[v]}` : ''}` })), filters.view, { label: t('goals.filterLabel') })}
      <label class="sr-only" for="goalSearch">${t('goals.search')}</label>
      <input type="search" id="goalSearch" class="v3-input projects-search" placeholder="${t('goals.search')}" value="${filters.search}">
    </div>` : '';
    let body;
    if (!data.goals.length) {
      body = html`<div class="card">${emptyState({ iconName: 'target', title: t('goals.emptyTitle'), body: t('goals.emptyBody'), actions: button(t('goals.new'), { variant: 'primary', action: 'new-goal', iconName: 'plus' }) })}</div>`;
    } else if (!visible.length) {
      body = html`<div class="card">${emptyState({ iconName: 'search', title: t('goals.noneInFilter'), body: t('goals.noneInFilterBody'), compact: true })}</div>`;
    } else {
      body = html`<div class="project-grid">${visible.map((g) => {
        const { pr, pace } = goalProgressOf(data, g);
        const sp = spaceOf(g.space_id);
        const next = nextGoalMilestone(data.milestones.filter((m) => m.goal_id === g.id));
        return html`<a class="project-card goal-card${g.status === 'archived' ? ' is-archived' : ''}" href="#/goals/${g.id}" style="--c:${safeColor(sp && sp.color, '#7c5cff')}">
          <span class="project-card-top">
            ${goalStatusBadge(g.status)}
            ${paceBadge(pace)}
            ${sp ? html`<span class="project-space"><span class="project-space-dot" aria-hidden="true"></span>${sp.name}</span>` : ''}
          </span>
          <span class="project-card-title">${g.title}</span>
          ${g.description ? html`<span class="project-card-desc">${g.description}</span>` : ''}
          <span class="project-card-progress">
            ${progressBar(pr.fraction, { color: sp && sp.color ? sp.color : '', label: t('goals.progressLabel').replace('{n}', String(pr.percent)) })}
            <span class="project-card-stats"><strong>${t('goals.percent').replace('{n}', String(pr.percent))}</strong> · ${measureLine(g, pr)}</span>
          </span>
          <span class="project-card-foot">
            ${next ? html`<span class="project-next">${raw(icon('flag'))}${t('goals.nextMilestone').replace('{name}', next.title)}${next.due_date ? ` — ${fmtDate(next.due_date)}` : ''}</span>` : html`<span></span>`}
            ${g.target_date ? badge(t('goals.by').replace('{date}', fmtDate(g.target_date)), pace && pace.state === 'overdue' ? 'danger' : 'outline') : ''}
          </span>
        </a>`;
      })}</div>`;
    }
    setHtml(root, [headFor(), spaceScopeNote(), toolbar, body]);
    wireSegmented(root, 'goalView', (v) => {
      filters = { ...filters, view: v };
      saveFilters(filters);
      renderList(last);
    });
    const search = root.querySelector('#goalSearch');
    if (search) {
      search.addEventListener('input', () => {
        filters = { ...filters, search: search.value };
        const pos = search.selectionStart;
        renderList(last);
        const again = root.querySelector('#goalSearch');
        again.focus();
        again.setSelectionRange(pos, pos);
      });
    }
  }

  // ---------------- detail ----------------
  function renderDetail(goal, data) {
    const { pr, l, pace } = goalProgressOf(data, goal);
    const sp = spaceOf(goal.space_id);
    const courseById = new Map(data.courses.map((c) => [c.id, c]));
    const archived = goal.status === 'archived';
    const achieved = goal.status === 'achieved';
    const milestones = l.milestones.slice().sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')));
    const tasks = l.tasks.slice().sort((a, b) => Number(a.done) - Number(b.done) || String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')));

    const header = html`<div class="project-head" style="--c:${safeColor(sp && sp.color, '#7c5cff')}">
      <a href="#/goals" class="back-link">${raw(icon('chevronLeft'))}${t('goals.all')}</a>
      <div class="project-head-row">
        <div class="project-head-text">
          <p class="page-eyebrow">${t('nav.goals')}</p>
          <h1 class="page-heading">${goal.title}</h1>
          <p class="project-head-meta">
            ${goalStatusBadge(goal.status)}
            ${paceBadge(pace)}
            ${sp ? html`<span class="project-space"><span class="project-space-dot" aria-hidden="true"></span>${sp.name}</span>` : ''}
            ${goal.start_date || goal.target_date ? html`<span class="muted">${goal.start_date ? fmtDate(goal.start_date) : ''}${goal.start_date && goal.target_date ? ' – ' : ''}${goal.target_date ? fmtDate(goal.target_date) : ''}</span>` : ''}
          </p>
        </div>
        <div class="page-head-actions">
          ${!archived && !achieved ? button(t('goals.markAchieved'), { action: 'achieve', iconName: 'check' }) : ''}
          ${button(archived ? t('goals.unarchive') : t('goals.archive'), { action: 'toggle-archive', iconName: 'archive' })}
          ${button(t('common.edit'), { variant: 'primary', action: 'edit-goal', iconName: 'edit' })}
        </div>
      </div>
      ${goal.description ? html`<p class="project-desc">${goal.description}</p>` : ''}
    </div>`;

    const paceText = pace && pace.state !== 'overdue' ? t('goals.paceExpected').replace('{n}', String(Math.round(pace.expected * 100))) : '';
    const summary = html`<section class="card project-summary goal-summary" aria-label="${t('goals.progressTitle')}">
      ${ring(pr.fraction, { size: 72, stroke: 7, label: t('goals.percent').replace('{n}', String(pr.percent)) })}
      <div class="project-summary-text">
        <p class="project-summary-main"><strong>${t('goals.percentComplete').replace('{n}', String(pr.percent))}</strong>${pr.mode === 'manual' ? html` <span class="muted">· ${t('goals.setManually')}</span>` : ''}</p>
        <p>${measureLine(goal, pr)}</p>
        ${paceText ? html`<p>${paceText}</p>` : ''}
        ${pr.empty ? html`<p class="muted">${t('goals.emptyAutoHint')}</p>` : ''}
      </div>
      ${pr.mode === 'numeric' && !archived ? html`<div class="goal-checkin-cta">${button(t('goals.checkIn'), { variant: 'primary', action: 'check-in', iconName: 'plus' })}</div>` : ''}
    </section>`;

    const projectsCard = has('projects') ? html`<section class="card card-flush v4-flush" aria-labelledby="goalProjHead">
      <div class="card-head">
        <h2 class="card-title" id="goalProjHead">${t('goals.projectsTitle')} <span class="muted">${l.projects.length ? `${pr.projectsDone}/${l.projects.length}` : ''}</span></h2>
        <span class="card-head-actions">
          ${button(t('goals.linkProject'), { size: 'sm', action: 'link-project', iconName: 'link' })}
          ${button(t('goals.newProject'), { size: 'sm', action: 'new-project', iconName: 'plus' })}
        </span>
      </div>
      ${l.projects.length ? html`<ul class="list goal-links">${l.projects.map((p) => {
        const pct = data.projectPct.get(p.id) || 0;
        return html`<li class="list-row">
          <a class="list-row-main goal-link-main" href="#/projects/${p.id}">
            <span class="list-row-title">${p.title}</span>
            <span class="list-row-meta">${projectStatusBadge(p.status)}<span>${t('goals.percent').replace('{n}', String(pct))}</span></span>
            ${progressBar(pct / 100, { thin: true, label: t('goals.progressLabel').replace('{n}', String(pct)) })}
          </a>
          <button type="button" class="btn btn--ghost btn--sm" data-action="unlink-project" data-project="${p.id}" aria-label="${t('goals.unlinkProjectLabel').replace('{name}', p.title)}">${t('goals.unlink')}</button>
        </li>`;
      })}</ul>` : emptyState({ iconName: 'briefcase', title: t('goals.noProjectsTitle'), body: t('goals.noProjectsBody'), compact: true })}
    </section>` : '';

    const tasksCard = html`<section class="card card-flush project-tasks" aria-labelledby="goalTasksHead">
      <div class="card-head">
        <h2 class="card-title" id="goalTasksHead">${t('goals.tasksTitle')} <span class="muted">${tasks.length ? `${pr.tasksDone}/${tasks.length}` : ''}</span></h2>
        ${button(t('goals.addTask'), { size: 'sm', action: 'add-task', iconName: 'plus' })}
      </div>
      ${tasks.length ? html`<div class="list">${tasks.map((g) => html`<div class="project-task">${taskRowHtml(g, { course: courseById.get(g.courseId), showCourse: Boolean(g.courseId), today: data.today })}</div>`)}</div>`
        : emptyState({ iconName: 'tasks', title: t('goals.noTasksTitle'), body: t('goals.noTasksBody'), compact: true })}
    </section>`;

    const msCard = html`<section class="card card-flush project-milestones" aria-labelledby="goalMsHead">
      <div class="card-head">
        <h2 class="card-title" id="goalMsHead">${t('goals.milestonesTitle')} <span class="muted">${milestones.length ? `${pr.milestonesDone}/${milestones.length}` : ''}</span></h2>
        ${button(t('goals.addMilestone'), { size: 'sm', action: 'add-milestone', iconName: 'plus' })}
      </div>
      ${milestones.length ? html`<ul class="list milestone-list">${milestones.map((m) => html`<li class="list-row milestone-row${m.status === 'done' ? ' is-done' : ''}">
        <button type="button" class="task-check${m.status === 'done' ? ' is-checked' : ''}" data-action="toggle-milestone" data-ms="${m.id}" aria-pressed="${m.status === 'done' ? 'true' : 'false'}" aria-label="${m.status === 'done' ? t('goals.milestoneReopen') : t('goals.milestoneComplete')}: ${m.title}">${raw(icon('check'))}</button>
        <button type="button" class="list-row-main task-open" data-action="edit-milestone" data-ms="${m.id}"><span class="list-row-title">${m.title}</span></button>
        <span class="list-row-side">${m.due_date ? badge(fmtDate(m.due_date), m.status !== 'done' && m.due_date < data.today ? 'danger' : 'outline') : ''}</span>
      </li>`)}</ul>` : emptyState({ iconName: 'flag', title: t('goals.noMilestonesTitle'), body: t('goals.noMilestonesBody'), compact: true })}
    </section>`;

    const logs = sortLogs(l.logs).reverse();
    const logsCard = pr.mode === 'numeric' ? html`<section class="card card-flush v4-flush" aria-labelledby="goalLogHead">
      <div class="card-head"><h2 class="card-title" id="goalLogHead">${t('goals.checkInsTitle')} <span class="muted">${logs.length || ''}</span></h2></div>
      ${logs.length ? html`<ul class="list goal-log">${logs.slice(0, 30).map((x) => html`<li class="list-row">
        <span class="list-row-main">
          <span class="list-row-title">${goal.aggregate === 'latest' ? '' : (Number(x.value) >= 0 ? '+' : '')}${formatValue(x.value)}${goal.unit ? ` ${goal.unit}` : ''}</span>
          <span class="list-row-meta"><span>${fmtDate(x.logged_on)}</span>${x.note ? html`<span>${x.note}</span>` : ''}</span>
        </span>
        <button type="button" class="btn btn--ghost btn--icon btn--sm" data-action="delete-log" data-log="${x.id}" aria-label="${t('goals.deleteCheckIn').replace('{date}', fmtDate(x.logged_on))}">${raw(icon('trash'))}</button>
      </li>`)}</ul>` : emptyState({ iconName: 'semester', title: t('goals.noCheckInsTitle'), body: t('goals.noCheckInsBody'), compact: true })}
    </section>` : '';

    const routinesCard = has('routines') ? html`<section class="card card-flush v4-flush" aria-labelledby="goalRoutinesHead">
      <div class="card-head">
        <h2 class="card-title" id="goalRoutinesHead">${t('goals.routinesTitle')}</h2>
        <a class="btn btn--secondary btn--sm" href="#/routines">${t('goals.manageRoutines')}</a>
      </div>
      ${l.routines.length ? html`<ul class="list">${l.routines.map((r) => {
        const s = computeStreak(r, data.completions, data.today);
        const rate = completionRate(r, data.completions, data.today);
        return html`<li class="list-row"><span class="list-row-main">
          <span class="list-row-title">${r.title}</span>
          <span class="list-row-meta">
            <span>${raw(icon('flame'))} ${tCount(s.unit === 'week' ? 'routines.streakWeeks' : 'routines.streakDays', s.current)}</span>
            ${rate.rate !== null ? html`<span>${t('routines.rate30').replace('{n}', String(Math.round(rate.rate * 100)))}</span>` : ''}
            ${r.paused ? badge(t('routines.paused'), 'outline') : ''}
          </span>
        </span></li>`;
      })}</ul>` : emptyState({ iconName: 'repeat', title: t('goals.noRoutinesTitle'), body: t('goals.noRoutinesBody'), compact: true })}
    </section>` : '';

    setHtml(root, [header, summary, html`<div class="project-columns goal-columns">
      <div class="stack">${projectsCard}${tasksCard}</div>
      <div class="stack">${logsCard}${msCard}${routinesCard}</div>
    </div>`]);
  }

  // ---------------- actions ----------------
  async function guarded(fn) {
    try {
      await fn();
    } catch (err) {
      console.error(err);
      toast(t('v3.saveError'), { kind: 'error' });
    }
  }

  on(root, 'click', '[data-action]', async (e, el) => {
    const a = el.dataset.action;
    const data = last;
    const goal = data && currentId ? data.goals.find((g) => g.id === currentId) : null;
    if (a === 'retry') render();
    else if (a === 'new-goal') openGoalEditor({ onSaved: (g) => g && app().navigate('goalsView', g.id) });
    else if (a === 'edit-goal' && goal) openGoalEditor({ goal, onSaved: () => render(), onDeleted: () => app().navigate('goalsView') });
    else if (a === 'toggle-archive' && goal) {
      const next = goal.status === 'archived' ? 'active' : 'archived';
      await guarded(async () => {
        await updateGoal(goal.id, { status: next });
        toast(next === 'archived' ? t('goals.archivedToast') : t('goals.unarchivedToast'), { kind: 'success' });
        render();
      });
    } else if (a === 'achieve' && goal) {
      await guarded(async () => {
        await updateGoal(goal.id, { status: 'achieved' });
        toast(t('goals.achievedToast').replace('{name}', goal.title), {
          kind: 'success',
          actionLabel: t('common.undo'),
          onAction: async () => { await updateGoal(goal.id, { status: goal.status }); render(); },
        });
        render();
      });
    } else if (a === 'check-in' && goal) {
      const { pr } = goalProgressOf(data, goal);
      openCheckInEditor({ goal, current: pr.value, onSaved: () => render() });
    } else if (a === 'delete-log') {
      const ok = await confirmAction({ title: t('goals.deleteCheckInTitle'), message: t('goals.deleteCheckInBody'), confirmLabel: t('common.delete'), danger: true });
      if (ok) await guarded(async () => { await deleteCheckIn(el.dataset.log); render(); });
    } else if (a === 'add-task' && goal) {
      openTaskEditor({ defaults: { goalId: goal.id, spaceId: goal.space_id || '' }, onSaved: () => render() });
    } else if (a === 'new-project' && goal) {
      openProjectEditor({ defaults: { goalId: goal.id }, onSaved: () => render() });
    } else if (a === 'link-project' && goal) {
      openLinkProjectDialog({ goal, projects: data.projects, onSaved: () => render() });
    } else if (a === 'unlink-project') {
      await guarded(async () => {
        await updateProject(el.dataset.project, { goal_id: null });
        toast(t('goals.projectUnlinked'));
        render();
      });
    } else if (a === 'add-milestone' && goal) openGoalMilestoneEditor({ goalId: goal.id, onSaved: () => render() });
    else if (a === 'edit-milestone') {
      const m = data.milestones.find((x) => x.id === el.dataset.ms);
      if (m) openGoalMilestoneEditor({ goalId: m.goal_id, milestone: m, onSaved: () => render() });
    } else if (a === 'toggle-milestone') {
      const m = data.milestones.find((x) => x.id === el.dataset.ms);
      if (!m) return;
      await guarded(async () => {
        await updateGoalMilestone(m.id, { status: m.status === 'done' ? 'open' : 'done' });
        if (m.status !== 'done') toast(t('goals.milestoneDone').replace('{name}', m.title), { kind: 'success' });
        await render();
        root.querySelector(`[data-action="toggle-milestone"][data-ms="${m.id}"]`)?.focus();
      });
    } else if (a === 'open-task' || a === 'toggle-done') {
      const row = el.closest('[data-task-id]');
      const g = row && data.groups.find((x) => x.id === row.dataset.taskId);
      if (!g) return;
      if (a === 'open-task') openTaskEditor({ task: g, onSaved: () => render() });
      else {
        await guarded(async () => {
          await setTaskDone(g.root.id, !g.done);
          toast(g.done ? t('tasks.reopened') : t('tasks.markedDone'), {
            kind: 'success',
            actionLabel: t('common.undo'),
            onAction: async () => { await setTaskDone(g.root.id, g.done); render(); },
          });
          await render();
          root.querySelector(`[data-task-id="${g.id}"] [data-action="toggle-done"]`)?.focus();
        });
      }
    }
  });

  onChange((topic) => {
    if (!root.hidden && ['goals', 'projects', 'tasks', 'routines', 'spaces'].includes(topic)) render();
  });

  return { onShow: (param) => render(param || null) };
}
