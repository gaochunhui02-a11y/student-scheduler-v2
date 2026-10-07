// Semester view (V3-B): the whole term at a glance — every week with its
// workload intensity, exams, major deadlines and breaks. Semester → week
// → task/course navigation: a week opens Week View on that week; a
// deadline opens the task; an exam/course chip opens its course.

import { t } from '../shared/i18n.js';
import { has } from '../shared/capabilities.js';
import { todayStr } from '../shared/dates.js';
import { app, onChange } from '../app/context.js';
import { html, raw, setHtml, on, safeColor } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { pageHead, emptyState, button, badge, progressBar, skeletonRows, migrationNotice, errorNotice } from '../ui/components.js';
import { fmtDate, fmtMinutes, fmtDateWithYear } from '../ui/format.js';
import {
  listSemesters, listCourses, listTaskRowsInWindow, listBlocksForSubjectIds, listSchedulesInWindow, listItemsForSchedules, setCurrentSemester,
} from '../academics/academicsData.js';
import { listExams } from '../exams/examsData.js';
import { pickCurrentSemester, semesterProgress, buildSemesterTimeline, teachingDaysLeft } from '../academics/semesterModel.js';
import { buildTaskGroups } from '../tasks/taskModel.js';
import { openTaskEditor } from '../tasks/taskEditor.js';
import { openSemesterEditor } from './semesterEditor.js';
import { toast } from '../ui/toast.js';

const ROOT_ID = 'semesterView';
const LEVEL_KEYS = { none: 'semester.loadNone', light: 'semester.loadLight', balanced: 'semester.loadBalanced', busy: 'semester.loadBusy', intense: 'semester.loadIntense', break: 'semester.loadBreak' };

export function initSemesterPage() {
  const root = document.getElementById(ROOT_ID);
  if (!root) return null;
  let token = 0;
  let selectedId = null;
  let expanded = null;
  let last = null;

  async function load() {
    const ctx = app();
    const today = todayStr();
    const semesters = await listSemesters(ctx.userId);
    const semester = semesters.find((s) => s.id === selectedId) || pickCurrentSemester(semesters, today);
    if (!semester) return { semesters, semester: null, today };
    const [courses, rows, exams, schedules] = await Promise.all([
      has('courses') ? listCourses(ctx.userId).catch(() => []) : [],
      listTaskRowsInWindow(ctx.userId, semester.start_date, semester.end_date).catch(() => []),
      has('exams') ? listExams(ctx.userId).catch(() => []) : [],
      listSchedulesInWindow(ctx.userId, semester.start_date, semester.end_date).catch(() => []),
    ]);
    const [blocks, items] = await Promise.all([
      listBlocksForSubjectIds(rows.map((r) => r.id)).catch(() => []),
      listItemsForSchedules(schedules.map((s) => s.id)).catch(() => []),
    ]);
    const dateBySchedule = new Map(schedules.map((s) => [s.id, s.for_date]));
    const studyMinutesByDate = {};
    items.filter((i) => i.item_type === 'study').forEach((i) => {
      const d = dateBySchedule.get(i.schedule_id);
      if (d) studyMinutesByDate[d] = (studyMinutesByDate[d] || 0) + Math.max(0, i.end_minutes - i.start_minutes);
    });
    const groups = buildTaskGroups(rows, blocks, { today }).map((g) => ({ ...g, major: g.priority === 'high' || g.requestedMinutes >= 120 }));
    const semExams = exams.filter((e) => e.exam_date >= semester.start_date && e.exam_date <= semester.end_date);
    const timeline = buildSemesterTimeline({ semester, today, tasks: groups, exams: semExams, studyMinutesByDate });
    return { semesters, semester, today, courses, groups, exams: semExams, timeline };
  }

  async function render() {
    const my = ++token;
    const head = (actions = '') => pageHead({ eyebrow: t('nav.sectionPlan'), title: t('nav.semester'), subtitle: t('semester.subtitle'), actions });
    if (!has('semesters')) {
      setHtml(root, [head(), migrationNotice('semesters')]);
      return;
    }
    if (!last) setHtml(root, [head(), skeletonRows(6, 52)]);
    let data;
    try {
      data = await load();
    } catch (err) {
      console.error('Could not load semester', err);
      if (my === token) setHtml(root, [head(), errorNotice('', { retryAction: 'retry' })]);
      return;
    }
    if (my !== token) return;
    last = data;
    if (!data.semester) {
      setHtml(root, [head(), html`<div class="card">${emptyState({
        iconName: 'semester',
        title: t('semester.emptyTitle'),
        body: t('semester.emptyBody'),
        actions: button(t('semester.setUp'), { variant: 'primary', action: 'new-semester', iconName: 'plus' }),
      })}</div>`]);
      return;
    }
    const { semester, today, timeline, courses } = data;
    const progress = semesterProgress(semester, today);
    const courseById = new Map(courses.map((c) => [c.id, c]));
    const selector = data.semesters.length > 1
      ? html`<label class="sr-only" for="semesterSelect">${t('semester.choose')}</label><select id="semesterSelect" class="v3-input" style="width:auto">${data.semesters.map((s) => html`<option value="${s.id}"${s.id === semester.id ? raw(' selected') : ''}>${s.name}${s.is_current ? ` · ${t('semester.currentShort')}` : ''}</option>`)}</select>`
      : '';
    const actions = [
      selector,
      !semester.is_current ? button(t('semester.makeCurrentShort'), { variant: 'ghost', action: 'make-current' }) : '',
      button(t('common.edit'), { variant: 'secondary', action: 'edit-semester', iconName: 'edit' }),
      button(t('semester.newShort'), { variant: 'secondary', action: 'new-semester', iconName: 'plus' }),
    ];
    const semCourses = courses.filter((c) => c.semester_id === semester.id && !c.archived);
    const totalExams = data.exams.length;
    const busiest = timeline.filter((w) => !w.isPast).sort((a, b) => b.load - a.load)[0];

    const hero = html`<section class="card semester-hero">
      <div class="semester-hero-top">
        <div>
          <p class="section-label">${semester.name}${semester.is_current ? html` · <span class="badge badge--accent">${t('semester.currentShort')}</span>` : ''}</p>
          <p class="semester-hero-figure">${progress.notStarted ? t('semester.startsOn').replace('{date}', fmtDateWithYear(semester.start_date)) : progress.finished ? t('semester.finished') : t('semester.weekOf').replace('{n}', String(progress.weekIndex)).replace('{total}', String(progress.totalWeeks))}</p>
          <p class="muted small">${fmtDateWithYear(semester.start_date)} – ${fmtDateWithYear(semester.end_date)}</p>
        </div>
        <div class="semester-hero-stats">
          <div class="stat"><span class="stat-label">${t('semester.daysLeft')}</span><span class="stat-value">${progress.daysLeft}</span></div>
          <div class="stat"><span class="stat-label">${t('semester.teachingDaysLeft')}</span><span class="stat-value">${teachingDaysLeft(semester, today)}</span></div>
          <div class="stat"><span class="stat-label">${t('semester.examsCount')}</span><span class="stat-value">${totalExams}</span></div>
        </div>
      </div>
      ${progressBar(progress.fraction, { label: t('semester.progressLabel') })}
      <div class="semester-hero-foot">
        ${semCourses.length ? html`<span class="row">${semCourses.map((c) => html`<a class="course-chip" href="#/courses/${c.id}" style="--c:${safeColor(c.color)}"><span class="course-dot"></span>${c.code || c.name}</a>`)}</span>` : html`<span class="muted small">${t('semester.noCourses')}</span>`}
        ${busiest && busiest.load > 0 ? html`<span class="muted small">${t('semester.busiestAhead').replace('{n}', String(busiest.index)).replace('{date}', fmtDate(busiest.start))}</span>` : ''}
      </div>
      ${(semester.breaks || []).length ? html`<div class="row" style="margin-top:var(--space-3)">${semester.breaks.map((b) => html`<span class="badge badge--info">${b.name || t('semester.breakDefault')} · ${fmtDate(b.start_date)}–${fmtDate(b.end_date)}</span>`)}</div>` : ''}
    </section>`;

    const legend = html`<div class="load-legend" aria-hidden="true">
      ${['light', 'balanced', 'busy', 'intense'].map((lv) => html`<span><i class="week-load-swatch week-load--${lv}"></i>${t(LEVEL_KEYS[lv])}</span>`)}
      <span><i class="week-load-swatch week-load--break"></i>${t('semester.loadBreak')}</span>
    </div>`;

    const maxLoad = Math.max(1, ...timeline.map((w) => w.load));
    const weeks = html`<section class="card card-flush">
      <div class="card-head" style="padding:var(--space-4) var(--space-5) 0"><h2 class="card-title">${t('semester.weeksTitle')}</h2>${legend}</div>
      <ol class="semester-weeks">${timeline.map((w) => weekRow(w, maxLoad, courseById, today))}</ol>
    </section>`;
    setHtml(root, [head(actions), hero, weeks]);
    const sel = root.querySelector('#semesterSelect');
    if (sel) sel.addEventListener('change', () => { selectedId = sel.value; expanded = null; render(); });
  }

  function weekRow(w, maxLoad, courseById, today) {
    const isOpen = expanded === w.index;
    const items = [
      ...w.exams.map((e) => ({ kind: 'exam', date: e.exam_date, label: e.name, course: courseById.get(e.course_id), id: e.id })),
      ...w.deadlines.filter((d) => d.major || isOpen).map((d) => ({ kind: 'task', date: d.dueDate, label: d.name, course: courseById.get(d.courseId), id: d.id, done: d.done })),
    ];
    const pct = Math.round((w.load / maxLoad) * 100);
    return html`<li class="semester-week${w.isCurrent ? ' is-current' : ''}${w.isPast ? ' is-past' : ''}${w.isBreak ? ' is-break' : ''}${isOpen ? ' is-open' : ''}">
      <button type="button" class="semester-week-head" data-action="toggle-week" data-week="${w.index}" aria-expanded="${isOpen ? 'true' : 'false'}">
        <span class="semester-week-num">${t('semester.weekShort').replace('{n}', String(w.index))}</span>
        <span class="semester-week-dates">${fmtDate(w.start)} – ${fmtDate(w.end)}</span>
        <span class="semester-week-bar" aria-hidden="true"><span class="week-load--${w.level}" style="width:${w.load ? Math.max(4, pct) : 0}%"></span></span>
        <span class="semester-week-level">${w.isBreak ? (w.breakName || t('semester.loadBreak')) : t(LEVEL_KEYS[w.level])}${w.load ? html` · <span class="tabular">${fmtMinutes(w.load)}</span>` : ''}</span>
        <span class="semester-week-flags">
          ${w.exams.length ? html`<span class="badge badge--danger">${raw(icon('exam'))}${w.exams.length}</span>` : ''}
          ${w.deadlines.length ? html`<span class="badge badge--outline">${raw(icon('tasks'))}${w.deadlines.length}</span>` : ''}
          ${w.isCurrent ? html`<span class="badge badge--now">${t('semester.thisWeek')}</span>` : ''}
        </span>
      </button>
      ${isOpen ? html`<div class="semester-week-body">
        ${items.length ? html`<ul class="semester-week-items">${items.sort((a, b) => a.date.localeCompare(b.date)).map((it) => html`<li>
            <span class="semester-item-date">${fmtDate(it.date, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
            ${it.kind === 'exam' ? html`<span class="badge badge--danger">${t('semester.examTag')}</span>` : ''}
            <button type="button" class="semester-item-link${it.done ? ' is-done' : ''}" data-action="${it.kind === 'exam' ? 'open-exam' : 'open-task'}" data-id="${it.id}">${it.label}</button>
            ${it.course ? html`<a class="course-chip" href="#/courses/${it.course.id}" style="--c:${safeColor(it.course.color)}"><span class="course-dot"></span>${it.course.code || it.course.name}</a>` : ''}
          </li>`)}</ul>` : html`<p class="muted small" style="margin:0">${t('semester.weekEmpty')}</p>`}
        <div class="row" style="margin-top:var(--space-3)">
          <span class="muted small">${t('semester.weekBreakdown').replace('{study}', fmtMinutes(w.studyMinutes)).replace('{due}', fmtMinutes(w.dueMinutes))}</span>
          <span class="toolbar-spacer"></span>
          <a class="btn btn--secondary btn--sm" href="#/week/${w.start}">${t('semester.openWeek')}${raw(icon('arrowRight'))}</a>
        </div>
      </div>` : ''}
    </li>`;
  }

  on(root, 'click', '[data-action]', async (e, el) => {
    const action = el.dataset.action;
    if (action === 'retry') render();
    else if (action === 'new-semester') openSemesterEditor({ onSaved: (s) => { selectedId = s ? s.id : null; render(); } });
    else if (action === 'edit-semester' && last && last.semester) openSemesterEditor({ semester: last.semester, onSaved: (s) => { selectedId = s ? s.id : null; render(); } });
    else if (action === 'make-current' && last && last.semester) {
      try {
        await setCurrentSemester(app().userId, last.semester.id);
        toast(t('semester.nowCurrent').replace('{name}', last.semester.name), { kind: 'success' });
        render();
      } catch (err) {
        console.error(err);
        toast(t('v3.saveError'), { kind: 'error' });
      }
    } else if (action === 'toggle-week') {
      const idx = Number(el.dataset.week);
      expanded = expanded === idx ? null : idx;
      render();
    } else if (action === 'open-task') {
      const g = last.groups.find((x) => x.id === el.dataset.id);
      if (g) openTaskEditor({ task: g, onSaved: () => render() });
    } else if (action === 'open-exam') {
      app().navigate('examsView', el.dataset.id);
    }
  });

  onChange((topic) => {
    if (!root.hidden && ['semesters', 'tasks', 'exams', 'courses'].includes(topic)) render();
  });

  return { onShow: () => render() };
}
