// Dashboard (V3-S): what a student needs TODAY, scannable in ~5 seconds.
//   1. Today   — now/next, today's progress, urgent tasks
//   2. Upcoming — deadlines, exams, days that are overloaded
//   3. Academic overview — courses, semester progress, one useful insight
// Built from the same data as every other page; read-only except for
// ticking a task done.

import { t, tCount } from '../shared/i18n.js';
import { has } from '../shared/capabilities.js';
import { todayStr, addDays, minutesOfDay } from '../shared/dates.js';
import { app, onChange } from '../app/context.js';
import { html, raw, setHtml, h, on, safeColor } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { button, ring, progressBar, badge, skeletonRows, errorNotice, emptyState } from '../ui/components.js';
import { fmtMinutes, fmtClock, fmtDate, fmtDateLong, fmtDue, fmtPercent } from '../ui/format.js';
import { toast } from '../ui/toast.js';
import { listCourses, listTaskRowsInWindow, listBlocksForSubjectIds, listSemesters } from '../academics/academicsData.js';
import { sortCourses } from '../academics/courseModel.js';
import { pickCurrentSemester, semesterProgress } from '../academics/semesterModel.js';
import { buildTaskGroups, blockCompletedMinutes } from '../tasks/taskModel.js';
import { setTaskDone, listDependencies } from '../tasks/tasksData.js';
import { computeBlockedState } from '../tasks/dependencyModel.js';
import { listExams, listExamTopics } from '../exams/examsData.js';
import { examProgress, examCountdown } from '../exams/revisionPlanner.js';
import { loadForecastInput } from '../workload/workloadData.js';
import { buildWorkloadForecast, deadlineRisks } from '../workload/workloadModel.js';
import { loadGradeData } from '../grades/gradesData.js';
import { computeCourseGrade } from '../grades/gradeModel.js';
import { listFocusSessions } from '../focus/focusHistory.js';
import { computeEstimateAccuracy, estimateStatement } from '../insights/estimateModel.js';
import { buildCalendarEvents } from '../calendar/calendarEvents.js';
import { listClassesForScheduleIds } from '../dashboard/data.js';
import { listAllClassSeries, listAllClassSeriesExceptions } from '../academics/academicsData.js';

function greetingKey(now = new Date()) {
  const hour = now.getHours();
  if (hour < 5) return 'home3.greetNight';
  if (hour < 12) return 'home3.greetMorning';
  if (hour < 18) return 'home3.greetAfternoon';
  return 'home3.greetEvening';
}

function fill(key, params) {
  let text = t(key);
  Object.entries(params || {}).forEach(([k, v]) => { text = text.split(`{${k}}`).join(String(v)); });
  return text;
}

export function initHomeV3() {
  const view = document.getElementById('analyticsView');
  if (!view) return null;
  // The V2 Home blocks stay in the DOM (analytics.js still owns them) but
  // are replaced visually by this dashboard.
  [...view.children].forEach((el) => el.classList.add('v3-hidden'));
  const root = h('div', { class: 'home3', id: 'homeV3' });
  view.prepend(root);
  let token = 0;
  let last = null;

  async function load() {
    const ctx = app();
    const today = todayStr();
    const [rows, courses, exams, topics, semesters, forecast, deps] = await Promise.all([
      listTaskRowsInWindow(ctx.userId, addDays(today, -60), addDays(today, 45)),
      has('courses') ? listCourses(ctx.userId).catch(() => []) : [],
      has('exams') ? listExams(ctx.userId).catch(() => []) : [],
      has('exams') ? listExamTopics(ctx.userId).catch(() => []) : [],
      has('semesters') ? listSemesters(ctx.userId).catch(() => []) : [],
      loadForecastInput(ctx.userId, today, 7).catch(() => null),
      listDependencies(ctx.userId).catch(() => []),
    ]);
    const blocks = await listBlocksForSubjectIds(rows.map((r) => r.id)).catch(() => []);
    const todayScheduleIds = new Set(rows.filter((r) => r.for_date === today).map((r) => r.schedule_id));
    const groups = buildTaskGroups(rows, blocks, { today, nowMinutes: minutesOfDay(), todayScheduleIds });
    const blocked = computeBlockedState(groups, deps);
    let days = [];
    let risks = [];
    let todayEvents = [];
    if (forecast) {
      days = buildWorkloadForecast(forecast.input);
      risks = deadlineRisks(days, forecast.input.groups, today);
      const todaySched = forecast.input.schedules.filter((s) => s.for_date === today);
      const [classes, series, exceptions] = await Promise.all([
        listClassesForScheduleIds(todaySched.map((s) => s.id)).catch(() => []),
        listAllClassSeries(ctx.userId).catch(() => []),
        listAllClassSeriesExceptions(ctx.userId).catch(() => []),
      ]);
      todayEvents = buildCalendarEvents({
        from: today, to: today, schedules: todaySched, items: forecast.input.items.filter((i) => todaySched.some((s) => s.id === i.schedule_id)),
        classes, series, exceptions, subjects: forecast.input.subjects, groups, exams, courses,
      }).filter((e) => !e.allDay && (e.kind === 'class' || e.kind === 'study' || e.kind === 'external' || e.kind === 'exam'));
    }
    // Optional enrichments — never block the dashboard.
    const [grades, sessions] = await Promise.all([
      has('grades') ? loadGradeData(ctx.userId).catch(() => null) : null,
      has('focusSessions') ? listFocusSessions(ctx.userId).catch(() => []) : [],
    ]);
    return { today, groups, blocked, courses: sortCourses(courses).filter((c) => !c.archived), exams, topics, semester: pickCurrentSemester(semesters, today), days, risks, todayEvents, grades, sessions };
  }

  async function render() {
    const my = ++token;
    if (!last) setHtml(root, skeletonRows(4, 110));
    let d;
    try {
      d = await load();
    } catch (err) {
      console.error('Could not load the dashboard', err);
      if (my === token) setHtml(root, errorNotice('', { retryAction: 'home-retry' }));
      return;
    }
    if (my !== token) return;
    last = d;
    draw(d);
  }

  function draw(d) {
    const ctx = app();
    const name = (ctx.displayName || '').split(/[\s@]/)[0];
    const courseById = new Map(d.courses.map((c) => [c.id, c]));
    const now = minutesOfDay();
    const isNewUser = !d.groups.length && !d.courses.length && !d.todayEvents.length;

    // ---------------- hero ----------------
    const studyToday = d.todayEvents.filter((e) => e.kind === 'study');
    const plannedToday = studyToday.reduce((s, e) => s + (e.end - e.start), 0);
    const doneToday = studyToday.reduce((s, e) => s + (e.completed ? e.end - e.start : 0), 0);
    const classesToday = d.todayEvents.filter((e) => e.kind === 'class' || e.kind === 'external').length;
    const dueToday = d.groups.filter((g) => !g.done && g.dueDate === d.today).length;
    const summaryLine = [
      classesToday ? tCount('home3.sumClasses', classesToday) : '',
      plannedToday ? fill('home3.sumStudy', { time: fmtMinutes(plannedToday) }) : '',
      dueToday ? tCount('home3.sumDue', dueToday) : '',
    ].filter(Boolean).join(' · ') || t('home3.sumFree');
    const hero = html`<header class="home3-hero">
      <div>
        <p class="page-eyebrow">${fmtDateLong(d.today)}</p>
        <h1 class="home3-greeting">${fill(greetingKey(), { name })}</h1>
        <p class="page-subtitle">${summaryLine}</p>
      </div>
      <div class="page-head-actions">
        ${button(t('palette.quickAdd'), { variant: 'secondary', action: 'home-quickadd', iconName: 'plus' })}
        ${button(t('home3.openToday'), { variant: 'primary', action: 'home-planner', iconName: 'arrowRight' })}
      </div>
    </header>`;

    if (isNewUser) {
      setHtml(root, [hero, html`<section class="card">${emptyState({
        iconName: 'sparkle',
        title: t('home3.welcomeTitle'),
        body: t('home3.welcomeBody'),
        actions: [button(t('courses.addFirst'), { variant: 'primary', action: 'home-add-course', iconName: 'plus' }), button(t('tasks.addTask'), { action: 'home-add-task' }), button(t('home3.openToday'), { variant: 'ghost', action: 'home-planner' })],
      })}</section>`]);
      return;
    }

    // ---------------- today: now / next ----------------
    const current = d.todayEvents.find((e) => e.start <= now && e.end > now);
    const next = d.todayEvents.find((e) => e.start > now);
    const nextStudy = studyToday.find((e) => e.end > now && !e.completed);
    const eventLine = (e, label) => {
      const course = courseById.get(e.courseId);
      return html`<div class="home3-event" style="--c:${safeColor(course ? course.color : e.kind === 'study' ? '' : '', '#8a91a0')}">
        <span class="home3-event-label">${label}</span>
        <span class="home3-event-title">${e.title}</span>
        <span class="home3-event-meta">${fmtClock(e.start)}–${fmtClock(e.end)}${course ? ` · ${course.code || course.name}` : ''} · ${t(`calendar3.kind${e.kind === 'external' ? 'External' : e.kind[0].toUpperCase() + e.kind.slice(1)}`)}</span>
      </div>`;
    };
    const nowCard = html`<section class="card home3-now">
      <div class="card-head"><h2 class="card-title">${t('home3.nowTitle')}</h2>${current ? badge(t('home3.happeningNow'), 'now') : ''}</div>
      ${current ? eventLine(current, fill('home3.endsIn', { time: fmtMinutes(current.end - now) })) : ''}
      ${next ? eventLine(next, fill('home3.startsIn', { time: fmtMinutes(next.start - now) })) : ''}
      ${!current && !next ? html`<p class="muted small" style="margin:0">${t('home3.nothingLeft')}</p>` : ''}
      ${nextStudy ? html`<div class="row" style="margin-top:var(--space-3)">${button(t('home3.focusNext'), { size: 'sm', variant: 'primary', action: 'home-planner', iconName: 'play' })}<span class="small muted">${fill('home3.nextStudy', { name: nextStudy.title, time: fmtClock(nextStudy.start) })}</span></div>` : ''}
    </section>`;

    // ---------------- today: progress ----------------
    const fraction = plannedToday ? doneToday / plannedToday : 0;
    const remainingToday = Math.max(0, plannedToday - doneToday);
    const progressCard = html`<section class="card home3-progress">
      <div class="card-head"><h2 class="card-title">${t('home3.progressTitle')}</h2></div>
      ${plannedToday ? html`<div class="row" style="gap:var(--space-4)">
          ${ring(fraction, { size: 76, stroke: 8, label: fmtPercent(fraction * 100, 0) })}
          <div class="stack-sm">
            <span class="strong">${fill('home3.doneOf', { done: fmtMinutes(doneToday), total: fmtMinutes(plannedToday) })}</span>
            <span class="small muted">${remainingToday ? fill('home3.leftToday', { time: fmtMinutes(remainingToday) }) : t('home3.allDoneToday')}</span>
            <span class="small muted">${fill('home3.sessions', { done: studyToday.filter((e) => e.completed).length, total: studyToday.length })}</span>
          </div>
        </div>`
        : html`<p class="muted small" style="margin:0 0 var(--space-3)">${t('home3.noPlanToday')}</p>${button(t('home3.planToday'), { size: 'sm', action: 'home-planner' })}`}
    </section>`;

    // ---------------- today: urgent ----------------
    const urgent = d.groups
      .filter((g) => !g.done && g.dueDate && g.dueDate <= addDays(d.today, 1))
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      .slice(0, 5);
    const urgentCard = html`<section class="card home3-urgent">
      <div class="card-head"><h2 class="card-title">${t('home3.urgentTitle')}</h2><a class="card-link" href="#/tasks">${t('common.viewAll')}</a></div>
      ${urgent.length ? html`<div class="list">${urgent.map((g) => {
          const course = courseById.get(g.courseId);
          const st = d.blocked.get(g.id);
          return html`<div class="list-row task-row" data-task-id="${g.id}">
            ${has('taskExtensions') ? html`<button type="button" class="task-check" data-action="home-done" aria-label="${t('tasks.markDone')}: ${g.name}">${raw(icon('check'))}</button>` : ''}
            <span class="list-row-main"><span class="list-row-title">${g.name}</span>
              <span class="list-row-meta">${course ? html`<span class="course-chip" style="--c:${safeColor(course.color)}"><span class="course-dot"></span>${course.code || course.name}</span>` : ''}${g.remainingMinutes ? html`<span>${fill('tasks.leftShort', { time: fmtMinutes(g.remainingMinutes) })}</span>` : ''}${st && st.blocked ? html`<span class="task-waiting">${raw(icon('branch'))}${t('tasks.statusBlocked')}</span>` : ''}</span></span>
            ${badge(g.overdue ? t('tasks.overdueShort') : fmtDue(g.dueDate, d.today), g.overdue ? 'danger' : 'warning')}
          </div>`;
        })}</div>`
        : html`<p class="muted small" style="margin:0">${t('home3.noUrgent')}</p>`}
    </section>`;

    // ---------------- upcoming ----------------
    const upcomingDeadlines = d.groups.filter((g) => !g.done && g.dueDate && g.dueDate > addDays(d.today, 1) && g.dueDate <= addDays(d.today, 7)).sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 6);
    const deadlinesCard = html`<section class="card">
      <div class="card-head"><h2 class="card-title">${t('home3.deadlinesTitle')}</h2></div>
      ${upcomingDeadlines.length ? html`<ul class="home3-timeline">${upcomingDeadlines.map((g) => {
          const course = courseById.get(g.courseId);
          return html`<li style="--c:${safeColor(course ? course.color : '', '#8a91a0')}"><span class="home3-tl-date">${fmtDate(g.dueDate, { weekday: 'short', day: 'numeric' })}</span><span class="home3-tl-title">${g.name}</span>${course ? html`<span class="small muted">${course.code || course.name}</span>` : ''}</li>`;
        })}</ul>` : html`<p class="muted small" style="margin:0">${t('home3.noDeadlines')}</p>`}
    </section>`;
    const nextExams = d.exams.filter((e) => e.exam_date >= d.today).slice(0, 3);
    const examsCard = html`<section class="card">
      <div class="card-head"><h2 class="card-title">${t('nav.exams')}</h2><a class="card-link" href="#/exams">${t('common.viewAll')}</a></div>
      ${!has('exams') ? html`<p class="muted small" style="margin:0">${t('home3.examsNeedUpdate')}</p>`
        : nextExams.length ? html`<div class="list">${nextExams.map((e) => {
          const course = courseById.get(e.course_id);
          const pr = examProgress(e, d.topics, { today: d.today });
          const days = examCountdown(e, d.today);
          return html`<a class="list-row" href="#/exams/${e.id}">
            <span class="exam-mini-count tabular" style="--c:${safeColor(course ? course.color : '', '#8a91a0')}">${days}<small>${days === 1 ? t('exams.dayLeft') : t('exams.daysLeft')}</small></span>
            <span class="list-row-main"><span class="list-row-title">${e.name}</span><span class="list-row-meta">${course ? course.code || course.name : ''}${pr.topicCount ? ` · ${fill('insights3.revised', { pct: fmtPercent(pr.fraction * 100, 0) })}` : ''}</span></span>
          </a>`;
        })}</div>` : html`<p class="muted small" style="margin:0">${t('exams.noUpcoming')}</p>`}
    </section>`;
    const heavy = d.days.filter((x) => x.level === 'overloaded' || x.level === 'busy');
    const headsUpCard = html`<section class="card">
      <div class="card-head"><h2 class="card-title">${t('home3.headsUpTitle')}</h2><a class="card-link" href="#/week" data-action="home-forecast">${t('home3.openForecast')}</a></div>
      <div class="home3-mini-heat" aria-label="${t('workload.heatTitle')}">${d.days.map((x) => html`<span class="home3-mini-day heat-cell--${x.level}${x.isToday ? ' is-today' : ''}" data-tip="${fmtDateLong(x.date)} · ${t(`workload.${x.level}`)} · ${fmtMinutes(x.studyLoad)}" tabindex="0"><span>${fmtDate(x.date, { weekday: 'narrow' })}</span></span>`)}</div>
      ${heavy.length ? html`<ul class="why-list">${heavy.slice(0, 3).map((x) => html`<li>${fmtDate(x.date, { weekday: 'long' })}: ${x.level === 'overloaded' ? fill('workload.overBy', { time: fmtMinutes(x.overBy) }) : t('workload.busy')}</li>`)}</ul>`
        : html`<p class="muted small" style="margin:0">${t('home3.weekFits')}</p>`}
      ${d.risks.length ? html`<p class="small is-danger-text" style="margin:var(--space-2) 0 0">${fill('home3.riskLine', { name: d.risks[0].name, time: fmtMinutes(d.risks[0].shortBy) })}</p>` : ''}
    </section>`;

    // ---------------- academic overview ----------------
    const courseCards = d.courses.slice(0, 6).map((c) => {
      const open = d.groups.filter((g) => g.courseId === c.id && !g.done).length;
      let grade = null;
      if (d.grades) {
        const s = computeCourseGrade({ categories: d.grades.categories.filter((x) => x.course_id === c.id), items: d.grades.items.filter((x) => x.course_id === c.id) });
        grade = s.current;
      }
      return html`<a class="home3-course" href="#/courses/${c.id}" style="--c:${safeColor(c.color)}">
        <span class="home3-course-code">${c.code || c.name}</span>
        <span class="home3-course-grade tabular">${grade !== null ? fmtPercent(grade, 1) : '—'}</span>
        <span class="small muted">${fill('home3.openTasks', { n: open })}</span>
      </a>`;
    });
    const sp = d.semester ? semesterProgress(d.semester, d.today) : null;
    let insightText = '';
    const acc = computeEstimateAccuracy({ groups: d.groups, sessions: d.sessions });
    const st = estimateStatement(acc.overall, null);
    if (st) insightText = fill(st.key, st.params);
    const overviewCard = html`<section class="card home3-overview">
      <div class="card-head"><h2 class="card-title">${t('home3.overviewTitle')}</h2><a class="card-link" href="#/courses">${t('nav.courses')}</a></div>
      ${courseCards.length ? html`<div class="home3-courses">${courseCards}</div>` : html`<p class="muted small">${t('home3.noCourses')}</p>`}
      <div class="home3-overview-foot">
        ${sp ? html`<div class="home3-sem"><div class="row-between small"><span class="strong">${d.semester.name}</span><span class="muted">${sp.notStarted ? fill('semester.startsOn', { date: fmtDate(d.semester.start_date) }) : sp.finished ? t('semester.finished') : fill('semester.weekOf', { n: sp.weekIndex, total: sp.totalWeeks })}</span></div>${progressBar(sp.fraction, { thin: true, label: t('semester.progressLabel') })}</div>` : ''}
        ${insightText ? html`<p class="home3-insight">${raw(icon('sparkle'))}<span>${insightText}</span></p>` : ''}
      </div>
    </section>`;

    setHtml(root, html`${hero}
      <p class="section-label home3-section">${t('home3.sectionToday')}</p>
      <div class="home3-grid">${nowCard}${progressCard}${urgentCard}</div>
      <p class="section-label home3-section">${t('home3.sectionUpcoming')}</p>
      <div class="home3-grid">${deadlinesCard}${examsCard}${headsUpCard}</div>
      <p class="section-label home3-section">${t('home3.sectionOverview')}</p>
      ${overviewCard}`);
  }

  on(root, 'click', '[data-action]', async (e, el) => {
    const a = el.dataset.action;
    const ctx = app();
    if (a === 'home-retry') render();
    else if (a === 'home-quickadd') ctx.openQuickAdd();
    else if (a === 'home-planner') ctx.openPlannerForDate(todayStr());
    else if (a === 'home-add-course') {
      const { openCourseEditor } = await import('../courses/courseEditor.js');
      openCourseEditor({ onSaved: () => render() });
    } else if (a === 'home-add-task') {
      const { openTaskEditor } = await import('../tasks/taskEditor.js');
      openTaskEditor({ onSaved: () => render() });
    } else if (a === 'home-forecast') {
      e.preventDefault();
      try { localStorage.setItem('student-scheduler-week-mode', 'forecast'); } catch { /* ignore */ }
      ctx.navigate('weekView');
    } else if (a === 'home-done') {
      const id = el.closest('[data-task-id]').dataset.taskId;
      const g = last && last.groups.find((x) => x.id === id);
      if (!g) return;
      el.disabled = true;
      try {
        await setTaskDone(g.root.id, true);
        toast(t('tasks.markedDone'), { kind: 'success', actionLabel: t('common.undo'), onAction: async () => { await setTaskDone(g.root.id, false); render(); } });
        render();
      } catch (err) {
        console.error(err);
        el.disabled = false;
        toast(t('v3.saveError'), { kind: 'error' });
      }
    }
  });

  onChange((topic) => {
    if (!view.hidden && ['tasks', 'exams', 'courses', 'grades'].includes(topic)) render();
  });

  return { onShow: () => render() };
}

