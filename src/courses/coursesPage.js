// Courses (V3-A): the list of courses and each course's own workspace
// (#/courses/<id>). A course organises existing systems — tasks are
// study_subjects with a course_id, meetings are recurring class series
// with a course_id — it never keeps a second copy of them.

import { t } from '../shared/i18n.js';
import { has } from '../shared/capabilities.js';
import { todayStr, addDays, minutesOfDay, diffDays } from '../shared/dates.js';
import { app, onChange } from '../app/context.js';
import { html, raw, setHtml, on, safeColor, h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { pageHead, emptyState, button, badge, progressBar, ring, skeletonRows, migrationNotice, errorNotice, tabList, wireTabs, segmented, wireSegmented } from '../ui/components.js';
import { fmtDate, fmtDue, fmtMinutes, fmtClockStr, fmtRelativeDay, fmtWeekday, fmtPercent } from '../ui/format.js';
import { toast } from '../ui/toast.js';
import { openDrawer, confirmAction } from '../ui/drawer.js';
import {
  listCourses, listSemesters, listAllClassSeries, listAllClassSeriesExceptions, listAllCourseTaskRows, listBlocksForSubjectIds,
  createCourseMeeting, updateClassSeriesCourse, deleteCourseMeeting, updateCourse,
} from '../academics/academicsData.js';
import { sortCourses, summarizeMeetings, nextMeeting, filterCoursesBySemester, weeklyMeetingMinutes } from '../academics/courseModel.js';
import { pickCurrentSemester } from '../academics/semesterModel.js';
import { buildTaskGroups, sortTaskGroups, courseProgress, blockCompletedMinutes } from '../tasks/taskModel.js';
import { openTaskEditor } from '../tasks/taskEditor.js';
import { setTaskDone } from '../tasks/tasksData.js';
import { openCourseEditor } from './courseEditor.js';
import { courseTabs, courseOverviewWidgets, courseCardProviders } from './courseTabs.js';
import { buildSeriesFields, validateSeriesFields } from '../dashboard/recurringClasses.js';
import { statusBadgeHtml, statusLabelKey } from '../shared/statusModel.js';

const ROOT_ID = 'coursesView';
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];
const REF_SUNDAY = '2026-10-04';

function weekdayShort(dow) {
  return fmtWeekday(addDays(REF_SUNDAY, dow), 'short');
}

function meetingLine(m) {
  const days = m.days.map(weekdayShort).join(' ');
  return `${days} · ${fmtClockStr(m.start)}–${fmtClockStr(m.end)}`;
}

function taskStatusBadge(group) {
  if (group.status === 'unscheduled') return badge(t('tasks.statusUnscheduled'), 'outline');
  if (group.status === 'blocked') return badge(t('tasks.statusBlocked'), 'warning');
  return raw(statusBadgeHtml(group.status, t(statusLabelKey(group.status)), { compact: true }));
}

export function taskRowHtml(group, { course = null, showCourse = false, today = todayStr() } = {}) {
  const dueText = group.dueDate ? fmtDue(group.dueDate, today) : '';
  const dueClass = group.overdue ? 'badge--danger' : group.dueDate && diffDays(today, group.dueDate) <= 2 && !group.done ? 'badge--warning' : 'badge--outline';
  return html`<div class="list-row task-row${group.done ? ' is-done' : ''}" data-task-id="${group.id}">
    ${has('taskExtensions') ? html`<button type="button" class="task-check${group.done ? ' is-checked' : ''}" data-action="toggle-done" aria-pressed="${group.done ? 'true' : 'false'}" aria-label="${group.done ? t('tasks.markNotDone') : t('tasks.markDone')}">${raw(icon('check'))}</button>` : ''}
    <button type="button" class="list-row-main task-open" data-action="open-task">
      <span class="list-row-title">${group.name}</span>
      <span class="list-row-meta">
        ${showCourse && course ? html`<span class="course-chip" style="--c:${safeColor(course.color)}"><span class="course-dot"></span>${course.code || course.name}</span>` : ''}
        ${group.remainingMinutes > 0 ? html`<span>${t('tasks.leftShort').replace('{time}', fmtMinutes(group.remainingMinutes))}</span>` : ''}
        ${group.tags.slice(0, 2).map((tag) => html`<span class="muted">#${tag}</span>`)}
      </span>
    </button>
    <span class="list-row-side">
      ${dueText ? html`<span class="badge ${dueClass}">${group.overdue ? t('tasks.overdueShort') : dueText}</span>` : ''}
      ${taskStatusBadge(group)}
    </span>
  </div>`;
}

export function initCoursesPage() {
  const root = document.getElementById(ROOT_ID);
  if (!root) return null;
  let token = 0;
  let state = { semesterFilter: null, showArchived: false, detailTab: 'overview', taskFilter: 'open' };
  let current = { courseId: null };
  let lastData = null;

  async function loadAll() {
    const ctx = app();
    const [courses, semesters, series, exceptions] = await Promise.all([
      listCourses(ctx.userId),
      has('semesters') ? listSemesters(ctx.userId).catch(() => []) : Promise.resolve([]),
      listAllClassSeries(ctx.userId).catch(() => []),
      listAllClassSeriesExceptions(ctx.userId).catch(() => []),
    ]);
    let taskRows = [];
    let blocks = [];
    if (has('courseLinks')) {
      taskRows = await listAllCourseTaskRows(ctx.userId).catch(() => []);
      blocks = await listBlocksForSubjectIds(taskRows.map((r) => r.id)).catch(() => []);
    }
    const today = todayStr();
    const todayScheduleIds = new Set(taskRows.filter((r) => r.for_date === today).map((r) => r.schedule_id));
    const groups = buildTaskGroups(taskRows, blocks, { today, nowMinutes: minutesOfDay(), todayScheduleIds });
    return { courses: sortCourses(courses), semesters, series, exceptions, groups, today, rowsById: new Map(taskRows.map((r) => [r.id, r])) };
  }

  function groupsForCourse(data, courseId) {
    return data.groups.filter((g) => g.courseId === courseId);
  }

  // ---------------------------------------------------------------- list
  async function renderList() {
    const my = ++token;
    if (!has('courses')) {
      setHtml(root, [pageHead({ eyebrow: t('nav.sectionAcademics'), title: t('nav.courses') }), migrationNotice('courses')]);
      return;
    }
    if (!lastData) setHtml(root, [pageHead({ eyebrow: t('nav.sectionAcademics'), title: t('nav.courses') }), skeletonRows(3, 140)]);
    let data;
    try {
      data = await loadAll();
    } catch (err) {
      console.error('Could not load courses', err);
      if (my === token) setHtml(root, [pageHead({ eyebrow: t('nav.sectionAcademics'), title: t('nav.courses') }), errorNotice('', { retryAction: 'retry' })]);
      return;
    }
    if (my !== token) return;
    lastData = data;
    const currentSemester = pickCurrentSemester(data.semesters, data.today);
    if (state.semesterFilter === null) state.semesterFilter = currentSemester && data.courses.some((c) => c.semester_id === currentSemester.id) ? currentSemester.id : 'all';
    const visible = filterCoursesBySemester(data.courses, state.semesterFilter).filter((c) => state.showArchived || !c.archived);
    const archivedCount = data.courses.filter((c) => c.archived).length;

    const providerResults = {};
    await Promise.all(courseCardProviders().map(async (p) => {
      try {
        providerResults[p.id] = await p.load(visible);
      } catch (err) {
        console.error('course card provider failed', p.id, err);
      }
    }));
    if (my !== token) return;

    const semesterSelect = data.semesters.length
      ? html`<label class="sr-only" for="coursesSemesterFilter">${t('courses.semesterFilter')}</label>
        <select id="coursesSemesterFilter" class="v3-input" style="width:auto;min-width:160px">
          <option value="all"${state.semesterFilter === 'all' ? raw(' selected') : ''}>${t('courses.allSemesters')}</option>
          ${data.semesters.map((s) => html`<option value="${s.id}"${state.semesterFilter === s.id ? raw(' selected') : ''}>${s.name}${s.is_current ? ` · ${t('semester.currentShort')}` : ''}</option>`)}
          <option value="none"${state.semesterFilter === 'none' ? raw(' selected') : ''}>${t('courses.noSemester')}</option>
        </select>`
      : '';

    const head = pageHead({
      eyebrow: t('nav.sectionAcademics'),
      title: t('nav.courses'),
      subtitle: t('courses.subtitle'),
      actions: [semesterSelect, button(t('courses.newCourse'), { variant: 'primary', action: 'new-course', iconName: 'plus' })],
    });

    let body;
    if (data.courses.length === 0) {
      body = html`<div class="card">${emptyState({
        iconName: 'book',
        title: t('courses.emptyTitle'),
        body: t('courses.emptyBody'),
        actions: button(t('courses.addFirst'), { variant: 'primary', action: 'new-course', iconName: 'plus' }),
      })}</div>`;
    } else if (visible.length === 0) {
      body = html`<div class="card">${emptyState({ iconName: 'book', title: t('courses.noneInFilter'), body: t('courses.noneInFilterBody'), compact: true })}</div>`;
    } else {
      body = html`<div class="course-grid">${visible.map((c) => courseCard(c, data, providerResults))}</div>`;
    }
    const footer = archivedCount
      ? html`<div class="row" style="margin-top:var(--space-4)"><label class="field-check"><input type="checkbox" id="coursesShowArchived"${state.showArchived ? raw(' checked') : ''}><span>${t('courses.showArchived').replace('{n}', String(archivedCount))}</span></label></div>`
      : '';
    setHtml(root, [head, body, footer]);
    const sel = root.querySelector('#coursesSemesterFilter');
    if (sel) sel.addEventListener('change', () => { state.semesterFilter = sel.value; renderList(); });
    const arch = root.querySelector('#coursesShowArchived');
    if (arch) arch.addEventListener('change', () => { state.showArchived = arch.checked; renderList(); });
  }

  function courseCard(course, data, providerResults) {
    const groups = groupsForCourse(data, course.id);
    const progress = courseProgress(groups);
    const open = groups.filter((g) => !g.done);
    const dueSoon = open.filter((g) => g.dueDate && g.dueDate >= data.today && g.dueDate <= addDays(data.today, 7)).length;
    const overdue = open.filter((g) => g.overdue).length;
    const series = data.series.filter((s) => s.course_id === course.id);
    const meetings = summarizeMeetings(series);
    const next = nextMeeting(series, data.exceptions, data.today, minutesOfDay());
    const extras = courseCardProviders().map((p) => (providerResults[p.id] && providerResults[p.id][course.id]) || '').filter(Boolean);
    return html`<a class="course-card${course.archived ? ' is-archived' : ''}" href="#/courses/${course.id}" style="--c:${safeColor(course.color)}">
      <span class="course-card-top">
        <span class="course-card-code">${course.code || t('courses.noCode')}</span>
        ${extras.length ? html`<span class="course-card-extra">${extras.map((x) => raw(x))}</span>` : ''}
      </span>
      <span class="course-card-name">${course.name}</span>
      <span class="course-card-meta">${[course.instructor, meetings.length ? meetingLine(meetings[0]) : ''].filter(Boolean).join(' · ') || t('courses.noMeetings')}</span>
      ${next ? html`<span class="course-card-next">${raw(icon('clock'))}<span>${t('courses.nextClass')}: ${fmtRelativeDay(next.date, data.today)} ${fmtClockStr(next.start)}</span></span>` : ''}
      <span class="course-card-stats">
        <span><strong>${open.length}</strong> ${t('courses.statOpen')}</span>
        <span><strong>${dueSoon}</strong> ${t('courses.statDueWeek')}</span>
        ${overdue ? html`<span class="is-danger"><strong>${overdue}</strong> ${t('courses.statOverdue')}</span>` : ''}
      </span>
      ${progressBar(progress.fraction, { color: course.color, thin: true, label: t('courses.progressLabel') })}
      <span class="course-card-foot">${t('courses.tasksDone').replace('{done}', String(progress.done)).replace('{total}', String(progress.total))}${course.archived ? ` · ${t('courses.archived')}` : ''}</span>
    </a>`;
  }

  // -------------------------------------------------------------- detail
  async function renderDetail(courseId) {
    const my = ++token;
    if (!has('courses')) {
      setHtml(root, [pageHead({ title: t('nav.courses') }), migrationNotice('courses')]);
      return;
    }
    if (!lastData || current.courseId !== courseId) setHtml(root, skeletonRows(4, 90));
    current.courseId = courseId;
    let data;
    try {
      data = await loadAll();
    } catch (err) {
      console.error('Could not load course', err);
      if (my === token) setHtml(root, errorNotice('', { retryAction: 'retry' }));
      return;
    }
    if (my !== token) return;
    lastData = data;
    const course = data.courses.find((c) => c.id === courseId);
    if (!course) {
      setHtml(root, html`<a class="back-link" href="#/courses">${raw(icon('chevronLeft'))}${t('nav.courses')}</a>
        <div class="card">${emptyState({ iconName: 'book', title: t('courses.notFound'), body: t('courses.notFoundBody'), actions: html`<a class="btn btn--secondary" href="#/courses">${t('courses.backToCourses')}</a>` })}</div>`);
      return;
    }
    const groups = sortTaskGroups(groupsForCourse(data, course.id));
    const series = data.series.filter((s) => s.course_id === course.id);
    const allTabs = [
      { id: 'overview', label: t('courses.tabOverview') },
      { id: 'tasks', label: t('courses.tabTasks'), count: groups.filter((g) => !g.done).length },
      { id: 'schedule', label: t('courses.tabSchedule') },
      ...courseTabs().map((tab) => ({ id: tab.id, label: t(tab.labelKey) })),
    ];
    if (!allTabs.some((x) => x.id === state.detailTab)) state.detailTab = 'overview';

    const header = html`<a class="back-link" href="#/courses">${raw(icon('chevronLeft'))}${t('nav.courses')}</a>
      <header class="course-hero" style="--c:${safeColor(course.color)}">
        <div class="course-hero-main">
          <span class="course-hero-badge">${(course.code || course.name).slice(0, 10)}</span>
          <div class="course-hero-text">
            <h1 class="page-heading">${course.name}</h1>
            <p class="page-subtitle">${[course.code, course.instructor, course.location].filter(Boolean).join(' · ') || t('courses.addDetailsHint')}</p>
          </div>
        </div>
        <div class="page-head-actions">
          ${button(t('tasks.addTask'), { variant: 'primary', action: 'add-task', iconName: 'plus' })}
          ${button(t('common.edit'), { variant: 'secondary', action: 'edit-course', iconName: 'edit' })}
          ${button(course.archived ? t('courses.unarchive') : t('courses.archive'), { variant: 'ghost', action: 'toggle-archive' })}
        </div>
      </header>`;
    setHtml(root, [header, tabList('course', allTabs, state.detailTab), html`<div id="courseTabPanel" role="tabpanel" aria-labelledby="tab-course-${state.detailTab}"></div>`]);
    wireTabs(root, 'course', (id) => {
      state.detailTab = id;
      renderDetail(courseId);
    });
    const panel = root.querySelector('#courseTabPanel');
    const refresh = () => renderDetail(courseId);
    if (state.detailTab === 'overview') renderOverview(panel, course, data, groups, series);
    else if (state.detailTab === 'tasks') renderTasksTab(panel, course, data, groups);
    else if (state.detailTab === 'schedule') renderScheduleTab(panel, course, data, series);
    else {
      const tab = courseTabs().find((x) => x.id === state.detailTab);
      if (tab) {
        try {
          await tab.render(panel, { course, refresh, data });
        } catch (err) {
          console.error('course tab failed', tab.id, err);
          setHtml(panel, errorNotice('', { retryAction: 'retry' }));
        }
      }
    }
  }

  function studyMinutesSince(groups, fromDate, today) {
    let total = 0;
    groups.forEach((g) => {
      g.blocks.forEach((b) => {
        const row = g.rows.find((r) => r.id === b.source_subject_id);
        const d = row ? row.for_date : null;
        if (d && d >= fromDate && d <= today) total += blockCompletedMinutes(b);
      });
    });
    return total;
  }

  function renderOverview(panel, course, data, groups, series) {
    const today = data.today;
    const open = groups.filter((g) => !g.done);
    const progress = courseProgress(groups);
    const next = nextMeeting(series, data.exceptions, today, minutesOfDay());
    const nextDeadline = open.filter((g) => g.dueDate && g.dueDate >= today).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
    const week = studyMinutesSince(groups, addDays(today, -6), today);
    const total = studyMinutesSince(groups, '0000-01-01', today);
    const meetingMinutes = weeklyMeetingMinutes(series);
    const remaining = open.reduce((s, g) => s + g.remainingMinutes, 0);
    const widgets = courseOverviewWidgets();

    setHtml(panel, html`<div class="grid-main-side">
      <div class="stack">
        <section class="card">
          <div class="card-head"><h2 class="card-title">${t('courses.upNext')}</h2></div>
          <div class="up-next">
            <div class="up-next-item">
              <span class="up-next-icon">${raw(icon('clock'))}</span>
              <span class="up-next-label">${t('courses.nextClass')}</span>
              <span class="up-next-value">${next ? `${fmtRelativeDay(next.date, today)} · ${fmtClockStr(next.start)}–${fmtClockStr(next.end)}` : t('courses.noUpcomingClass')}</span>
            </div>
            <div class="up-next-item">
              <span class="up-next-icon">${raw(icon('tasks'))}</span>
              <span class="up-next-label">${t('courses.nextDeadline')}</span>
              <span class="up-next-value">${nextDeadline ? `${nextDeadline.name} · ${fmtDue(nextDeadline.dueDate, today)}` : t('courses.noDeadlines')}</span>
            </div>
            <div id="courseOverviewExtraUpNext"></div>
          </div>
        </section>
        <section class="card">
          <div class="card-head">
            <h2 class="card-title">${t('courses.upcomingWork')}</h2>
            <button type="button" class="card-link" data-action="goto-tab" data-tab-target="tasks">${t('common.viewAll')}</button>
          </div>
          ${open.length
            ? html`<div class="list">${open.slice(0, 6).map((g) => taskRowHtml(g, { today }))}</div>`
            : emptyState({ iconName: 'tasks', title: t('courses.noOpenTasks'), body: t('courses.noOpenTasksBody'), actions: button(t('tasks.addTask'), { action: 'add-task', iconName: 'plus' }), compact: true })}
        </section>
        <div id="courseOverviewWidgetsMain" class="stack"></div>
      </div>
      <div class="stack">
        <section class="card">
          <div class="card-head"><h2 class="card-title">${t('courses.progressTitle')}</h2></div>
          <div class="row" style="gap:var(--space-4);align-items:center">
            ${ring(progress.fraction, { size: 72, stroke: 7, color: course.color, label: fmtPercent(progress.fraction * 100, 0) })}
            <div class="stack-sm">
              <span class="strong">${t('courses.tasksDone').replace('{done}', String(progress.done)).replace('{total}', String(progress.total))}</span>
              <span class="muted small">${remaining ? t('courses.remainingWork').replace('{time}', fmtMinutes(remaining)) : t('courses.nothingRemaining')}</span>
            </div>
          </div>
        </section>
        <section class="card">
          <div class="card-head"><h2 class="card-title">${t('courses.studyTime')}</h2></div>
          <div class="stat-row">
            <div class="stat"><span class="stat-label">${t('courses.last7')}</span><span class="stat-value">${fmtMinutes(week)}</span></div>
            <div class="stat"><span class="stat-label">${t('courses.allTime')}</span><span class="stat-value">${fmtMinutes(total)}</span></div>
          </div>
          ${meetingMinutes ? html`<p class="muted small" style="margin:var(--space-3) 0 0">${t('courses.classTimeWeekly').replace('{time}', fmtMinutes(meetingMinutes))}</p>` : ''}
        </section>
        <div id="courseOverviewWidgetsSide" class="stack"></div>
        <section class="card">
          <div class="card-head"><h2 class="card-title">${t('courses.details')}</h2><button type="button" class="card-link" data-action="edit-course">${t('common.edit')}</button></div>
          <dl class="detail-list">
            ${detailRow(t('courses.fieldInstructor'), course.instructor)}
            ${detailRow(t('courses.fieldLocation'), course.location)}
            ${detailRow(t('courses.fieldSemester'), (data.semesters.find((s) => s.id === course.semester_id) || {}).name)}
            ${detailRow(t('courses.fieldTarget'), course.target_grade !== null && course.target_grade !== undefined ? fmtPercent(Number(course.target_grade), 1) : '')}
            ${detailRow(t('courses.fieldCredits'), course.credits !== null && course.credits !== undefined ? String(course.credits) : '')}
          </dl>
          ${course.notes ? html`<p class="course-notes">${course.notes}</p>` : ''}
        </section>
      </div>
    </div>`);
    const mainSlot = panel.querySelector('#courseOverviewWidgetsMain');
    const sideSlot = panel.querySelector('#courseOverviewWidgetsSide');
    const upNextSlot = panel.querySelector('#courseOverviewExtraUpNext');
    widgets.forEach(async (w) => {
      try {
        const frag = await w.render({ course, data, today });
        if (!frag) return;
        const slot = w.slot === 'upNext' ? upNextSlot : w.slot === 'main' ? mainSlot : sideSlot;
        const holder = document.createElement('div');
        setHtml(holder, frag);
        while (holder.firstChild) slot.appendChild(holder.firstChild);
      } catch (err) {
        console.error('overview widget failed', w.id, err);
      }
    });
  }

  function detailRow(label, value) {
    return html`<div class="detail-row"><dt>${label}</dt><dd>${value || html`<span class="muted">—</span>`}</dd></div>`;
  }

  function renderTasksTab(panel, course, data, groups) {
    const filtered = groups.filter((g) => (state.taskFilter === 'open' ? !g.done : state.taskFilter === 'done' ? g.done : true));
    setHtml(panel, html`<div class="toolbar">
        ${segmented('courseTaskFilter', [
          { value: 'open', label: `${t('tasks.filterOpen')} (${groups.filter((g) => !g.done).length})` },
          { value: 'done', label: `${t('tasks.filterDone')} (${groups.filter((g) => g.done).length})` },
          { value: 'all', label: t('tasks.filterAll') },
        ], state.taskFilter, { label: t('tasks.filterLabel') })}
        <span class="toolbar-spacer"></span>
        ${button(t('tasks.addTask'), { variant: 'primary', action: 'add-task', iconName: 'plus' })}
      </div>
      <section class="card">
        ${filtered.length
          ? html`<div class="list">${filtered.map((g) => taskRowHtml(g, { today: data.today }))}</div>`
          : emptyState({ iconName: 'tasks', title: state.taskFilter === 'done' ? t('courses.noDoneTasks') : t('courses.noOpenTasks'), body: t('courses.noOpenTasksBody'), compact: true })}
      </section>`);
    wireSegmented(panel, 'courseTaskFilter', (v) => {
      state.taskFilter = v;
      renderTasksTab(panel, course, data, groups);
    });
  }

  function renderScheduleTab(panel, course, data, series) {
    const meetings = summarizeMeetings(series);
    const unlinked = data.series.filter((s) => !s.course_id);
    setHtml(panel, html`<div class="grid-main-side">
      <section class="card">
        <div class="card-head">
          <div><h2 class="card-title">${t('courses.weeklyMeetings')}</h2><p class="card-sub">${t('courses.weeklyMeetingsHint')}</p></div>
          ${button(t('courses.addMeeting'), { variant: 'primary', size: 'sm', action: 'add-meeting', iconName: 'plus' })}
        </div>
        ${meetings.length
          ? html`<div class="list">${meetings.map((m) => html`<div class="list-row" data-series-id="${m.seriesId}">
              <span class="meeting-days">${DOW_ORDER.map((d) => html`<span class="meeting-day${m.days.includes(d) ? ' is-on' : ''}" aria-hidden="true">${weekdayShort(d).slice(0, 2)}</span>`)}</span>
              <span class="list-row-main"><span class="list-row-title">${m.name}</span><span class="list-row-meta">${meetingLine(m)} · ${fmtDate(m.startDate)} – ${fmtDate(m.endDate)}</span></span>
              <span class="list-row-side">
                <button type="button" class="btn btn--ghost btn--sm" data-action="unlink-meeting">${t('courses.unlink')}</button>
                <button type="button" class="btn btn--ghost btn--icon btn--sm" data-action="delete-meeting" aria-label="${t('courses.deleteMeeting')}">${raw(icon('trash'))}</button>
              </span>
            </div>`)}</div>`
          : emptyState({ iconName: 'calendar', title: t('courses.noMeetingsTitle'), body: t('courses.noMeetingsBody'), actions: button(t('courses.addMeeting'), { action: 'add-meeting', iconName: 'plus' }), compact: true })}
      </section>
      <section class="card">
        <div class="card-head"><h2 class="card-title">${t('courses.linkExisting')}</h2></div>
        ${unlinked.length
          ? html`<p class="card-sub" style="margin-bottom:var(--space-3)">${t('courses.linkExistingHint')}</p>
            <div class="list">${unlinked.map((s) => html`<div class="list-row" data-series-id="${s.id}">
              <span class="list-row-main"><span class="list-row-title">${s.name}</span><span class="list-row-meta">${meetingLine(summarizeMeetings([s])[0])}</span></span>
              <button type="button" class="btn btn--secondary btn--sm" data-action="link-meeting">${t('courses.link')}</button>
            </div>`)}</div>`
          : html`<p class="muted small" style="margin:0">${t('courses.noUnlinked')}</p>`}
      </section>
    </div>`);
  }

  function openMeetingEditor(course) {
    const semester = (lastData.semesters || []).find((s) => s.id === course.semester_id) || pickCurrentSemester(lastData.semesters || [], todayStr());
    const today = todayStr();
    const selected = new Set();
    openDrawer({
      title: t('courses.addMeeting'),
      subtitle: course.name,
      render: (body) => {
        const name = h('input', { type: 'text', id: 'me-name', maxlength: '100', value: `${course.code || course.name}`, 'data-autofocus': true });
        body.appendChild(h('div', { class: 'field' }, h('label', { for: 'me-name' }, t('common.name')), name));
        const days = h('div', { class: 'day-toggle-row', role: 'group', 'aria-label': t('courses.meetingDays') });
        DOW_ORDER.forEach((d) => {
          const b = h('button', { type: 'button', class: 'day-toggle', 'aria-pressed': 'false', 'data-dow': String(d) }, weekdayShort(d));
          b.addEventListener('click', () => {
            if (selected.has(d)) selected.delete(d); else selected.add(d);
            b.setAttribute('aria-pressed', selected.has(d) ? 'true' : 'false');
          });
          days.appendChild(b);
        });
        body.appendChild(h('div', { class: 'field' }, h('span', { class: 'field-label' }, t('courses.meetingDays')), days));
        const g = h('div', { class: 'field-grid' });
        g.appendChild(h('div', { class: 'field' }, h('label', { for: 'me-start' }, t('courses.startTime')), h('input', { type: 'time', id: 'me-start', value: '09:00' })));
        g.appendChild(h('div', { class: 'field' }, h('label', { for: 'me-end' }, t('courses.endTime')), h('input', { type: 'time', id: 'me-end', value: '10:15' })));
        g.appendChild(h('div', { class: 'field' }, h('label', { for: 'me-from' }, t('courses.fromDate')), h('input', { type: 'date', id: 'me-from', value: semester ? (semester.start_date > today ? semester.start_date : today) : today })));
        g.appendChild(h('div', { class: 'field' }, h('label', { for: 'me-to' }, t('courses.toDate')), h('input', { type: 'date', id: 'me-to', value: semester ? semester.end_date : addDays(today, 112) })));
        body.appendChild(g);
        body.appendChild(h('p', { class: 'field-error', id: 'me-error', role: 'alert' }));
      },
      actions: [
        { label: t('common.cancel'), variant: 'secondary', onClick: (api) => api.close() },
        {
          label: t('common.add'),
          variant: 'primary',
          onClick: async (api) => {
            const b = api.body;
            const fields = buildSeriesFields({
              name: b.querySelector('#me-name').value,
              daysOfWeek: [...selected],
              startTime: b.querySelector('#me-start').value,
              endTime: b.querySelector('#me-end').value,
              startDate: b.querySelector('#me-from').value,
              endDate: b.querySelector('#me-to').value,
            });
            const v = validateSeriesFields(fields);
            const errEl = b.querySelector('#me-error');
            if (!v.valid) {
              errEl.textContent = t(v.errorKey);
              return;
            }
            api.setBusy(true);
            try {
              await createCourseMeeting(app().userId, { ...fields, ...(has('classCourseLinks') ? { course_id: course.id } : {}) });
              api.close(true);
              toast(t('courses.meetingAdded'), { kind: 'success' });
              app().refreshPlanner();
              renderDetail(course.id);
            } catch (err) {
              console.error('Could not add meeting', err);
              errEl.textContent = t('v3.saveError');
              api.setBusy(false);
            }
          },
        },
      ],
    });
  }

  // ------------------------------------------------------------- actions
  on(root, 'click', '[data-action]', async (e, el) => {
    const action = el.dataset.action;
    const data = lastData;
    const course = data && current.courseId ? data.courses.find((c) => c.id === current.courseId) : null;
    if (action === 'retry') {
      if (current.courseId) renderDetail(current.courseId);
      else renderList();
    } else if (action === 'new-course') {
      openCourseEditor({ onSaved: (saved) => (saved ? app().openCourse(saved.id) : renderList()) });
    } else if (action === 'edit-course' && course) {
      openCourseEditor({ course, onSaved: (saved) => (saved ? renderDetail(course.id) : (current.courseId = null, app().navigate('coursesView'))) });
    } else if (action === 'toggle-archive' && course) {
      try {
        await updateCourse(course.id, { archived: !course.archived });
        toast(course.archived ? t('courses.unarchived') : t('courses.archivedToast'));
        renderDetail(course.id);
      } catch (err) {
        console.error(err);
        toast(t('v3.saveError'), { kind: 'error' });
      }
    } else if (action === 'add-task') {
      openTaskEditor({ defaults: { courseId: course ? course.id : null }, onSaved: () => (current.courseId ? renderDetail(current.courseId) : renderList()) });
    } else if (action === 'open-task') {
      const id = el.closest('[data-task-id]').dataset.taskId;
      const group = data.groups.find((g) => g.id === id);
      if (group) openTaskEditor({ task: group, onSaved: () => renderDetail(current.courseId) });
    } else if (action === 'toggle-done') {
      const id = el.closest('[data-task-id]').dataset.taskId;
      const group = data.groups.find((g) => g.id === id);
      if (!group) return;
      el.disabled = true;
      try {
        await setTaskDone(group.root.id, !group.done);
        toast(group.done ? t('tasks.reopened') : t('tasks.markedDone'), {
          kind: 'success',
          actionLabel: t('common.undo'),
          onAction: async () => {
            await setTaskDone(group.root.id, group.done);
            renderDetail(current.courseId);
          },
        });
        renderDetail(current.courseId);
      } catch (err) {
        console.error(err);
        el.disabled = false;
        toast(t('v3.saveError'), { kind: 'error' });
      }
    } else if (action === 'goto-tab') {
      state.detailTab = el.dataset.tabTarget;
      renderDetail(current.courseId);
    } else if (action === 'add-meeting' && course) {
      openMeetingEditor(course);
    } else if ((action === 'link-meeting' || action === 'unlink-meeting') && course) {
      const seriesId = el.closest('[data-series-id]').dataset.seriesId;
      if (!has('classCourseLinks')) {
        toast(t('v3.needsUpdateTitle'), { kind: 'error' });
        return;
      }
      try {
        await updateClassSeriesCourse(seriesId, action === 'link-meeting' ? course.id : null);
        renderDetail(course.id);
      } catch (err) {
        console.error(err);
        toast(t('v3.saveError'), { kind: 'error' });
      }
    } else if (action === 'delete-meeting' && course) {
      const seriesId = el.closest('[data-series-id]').dataset.seriesId;
      const ok = await confirmAction({ title: t('courses.deleteMeetingTitle'), message: t('courses.deleteMeetingBody'), confirmLabel: t('common.delete'), danger: true });
      if (!ok) return;
      try {
        await deleteCourseMeeting(seriesId);
        toast(t('common.deleted'));
        app().refreshPlanner();
        renderDetail(course.id);
      } catch (err) {
        console.error(err);
        toast(t('v3.deleteError'), { kind: 'error' });
      }
    }
  });

  onChange((topic) => {
    if (root.hidden) return;
    if (['courses', 'tasks', 'grades', 'exams', 'classes', 'semesters'].includes(topic)) {
      if (current.courseId) renderDetail(current.courseId);
      else renderList();
    }
  });

  return {
    onShow(param) {
      if (param) {
        if (current.courseId !== param) state.detailTab = 'overview';
        renderDetail(param);
      } else {
        current.courseId = null;
        renderList();
      }
    },
  };
}
