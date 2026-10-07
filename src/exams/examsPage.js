// Exams (V3-D): upcoming exams with countdowns and revision readiness, each
// exam's topics, and a deterministic revision plan that can be added to the
// Planner as ordinary study tasks (linked back to their topic).

import { t } from '../shared/i18n.js';
import { has } from '../shared/capabilities.js';
import { todayStr, addDays } from '../shared/dates.js';
import { app, onChange } from '../app/context.js';
import { html, raw, setHtml, on, safeColor } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { pageHead, emptyState, button, badge, progressBar, ring, skeletonRows, migrationNotice, errorNotice } from '../ui/components.js';
import { fmtDate, fmtDateLong, fmtMinutes, fmtClockStr, fmtRelativeDay, fmtPercent, fmtNumber } from '../ui/format.js';
import { toast } from '../ui/toast.js';
import { supabase } from '../lib/supabaseClient.js';
import { listCourses, listBlocksForSubjectIds } from '../academics/academicsData.js';
import { listExams, listExamTopics, updateTopic } from './examsData.js';
import { planRevision, examProgress, examCountdown, topicRemainingMinutes, topicStatusAfterLog } from './revisionPlanner.js';
import { openExamEditor, openTopicEditor } from './examEditors.js';
import { getDailyMaxStudyMinutes, loadPlannedRange, studyLoadByDate } from '../workload/loadData.js';
import { blockCompletedMinutes } from '../tasks/taskModel.js';
import { createTask } from '../tasks/tasksData.js';
import { registerCourseTab, registerCourseOverviewWidget } from '../courses/courseTabs.js';

const READINESS = {
  ready: ['exams.readyReady', 'success'],
  on_track: ['exams.readyOnTrack', 'accent'],
  behind: ['exams.readyBehind', 'danger'],
  no_topics: ['exams.readyNoTopics', 'outline'],
  past: ['exams.readyPast', 'outline'],
};
const SESSION_KEY = 'student-scheduler-revision-session';

function readinessBadge(r) {
  const [key, kind] = READINESS[r] || READINESS.no_topics;
  return badge(t(key), kind);
}

function countdownText(days) {
  if (days === null) return '';
  if (days === 0) return t('exams.today');
  if (days === 1) return t('exams.tomorrow');
  if (days < 0) return t('exams.daysAgo').replace('{n}', String(-days));
  return t('exams.inDays').replace('{n}', String(days));
}

function sessionLength() {
  try {
    const v = Number(localStorage.getItem(SESSION_KEY));
    return [30, 45, 60, 90].includes(v) ? v : 45;
  } catch {
    return 45;
  }
}

// Everything the exam views need, in parallel.
async function loadExamData() {
  const ctx = app();
  const today = todayStr();
  const [exams, topics, courses] = await Promise.all([
    listExams(ctx.userId),
    listExamTopics(ctx.userId),
    has('courses') ? listCourses(ctx.userId).catch(() => []) : [],
  ]);
  // Planner tasks created from revision sessions (needs migration 0014).
  let linkedTasks = [];
  let linkedBlocks = [];
  if (has('taskExtensions') && topics.length) {
    const { data, error } = await supabase.from('study_subjects').select('*, schedules(for_date)').eq('user_id', ctx.userId).not('exam_topic_id', 'is', null);
    if (!error) {
      linkedTasks = (data || []).map((r) => ({ ...r, for_date: r.schedules ? r.schedules.for_date : null }));
      linkedBlocks = await listBlocksForSubjectIds(linkedTasks.map((r) => r.id)).catch(() => []);
    }
  }
  const completedByTopic = {};
  const plannedByTopic = {};
  linkedTasks.forEach((task) => {
    const done = linkedBlocks.filter((b) => b.source_subject_id === task.id).reduce((s, b) => s + blockCompletedMinutes(b), 0);
    const counted = task.completed_at ? Math.max(done, Number(task.minutes_requested) || 0) : done;
    completedByTopic[task.exam_topic_id] = (completedByTopic[task.exam_topic_id] || 0) + counted;
    if (!task.completed_at) plannedByTopic[task.exam_topic_id] = (plannedByTopic[task.exam_topic_id] || 0) + Math.max(0, (Number(task.minutes_requested) || 0) - done);
  });
  const upcoming = exams.filter((e) => e.exam_date > today);
  const lastDate = upcoming.reduce((m, e) => (e.exam_date > m ? e.exam_date : m), today);
  const [dailyMax, range] = await Promise.all([
    getDailyMaxStudyMinutes(ctx.userId).catch(() => 240),
    loadPlannedRange(ctx.userId, today, lastDate).catch(() => ({ schedules: [], items: [], subjects: [] })),
  ]);
  const load = studyLoadByDate(range);
  // Already-planned revision is both "existing load" (so we don't stack on
  // it) and treated as covered for planning (so it isn't planned twice).
  const coveredByTopic = {};
  Object.keys({ ...completedByTopic, ...plannedByTopic }).forEach((id) => {
    coveredByTopic[id] = (completedByTopic[id] || 0) + (plannedByTopic[id] || 0);
  });
  const plan = planRevision({ today, exams, topics, dailyMaxMinutes: dailyMax, existingLoadByDate: load, extraCompletedByTopic: coveredByTopic, sessionMinutes: sessionLength() });
  return { today, exams, topics, courses, linkedTasks, completedByTopic, plannedByTopic, dailyMax, plan };
}

function examCard(exam, data, { compact = false } = {}) {
  const course = data.courses.find((c) => c.id === exam.course_id);
  const days = examCountdown(exam, data.today);
  const pr = examProgress(exam, data.topics, { today: data.today, plan: data.plan, extraCompletedByTopic: data.completedByTopic });
  return html`<a class="exam-card${days !== null && days < 0 ? ' is-past' : ''}${compact ? ' is-compact' : ''}" href="#/exams/${exam.id}" style="--c:${safeColor(course ? course.color : '')}">
    <span class="exam-card-count${days !== null && days <= 3 && days >= 0 ? ' is-soon' : ''}">
      <span class="exam-card-days tabular">${days !== null && days >= 0 ? days : '—'}</span>
      <span class="exam-card-days-label">${days === 1 ? t('exams.dayLeft') : t('exams.daysLeft')}</span>
    </span>
    <span class="exam-card-body">
      <span class="exam-card-name">${exam.name}</span>
      <span class="exam-card-meta">
        ${course ? html`<span class="course-chip" style="--c:${safeColor(course.color)}"><span class="course-dot"></span>${course.code || course.name}</span>` : ''}
        <span>${fmtDate(exam.exam_date, { weekday: 'short', month: 'short', day: 'numeric' })}${exam.start_time ? ` · ${fmtClockStr(String(exam.start_time).slice(0, 5))}` : ''}</span>
      </span>
      <span class="exam-card-progress">
        ${progressBar(pr.fraction, { color: course ? course.color : '', thin: true, label: t('exams.revisionProgress') })}
        <span class="small muted tabular">${pr.topicCount ? t('exams.topicsLeft').replace('{n}', String(pr.remainingTopics)).replace('{total}', String(pr.topicCount)) : t('exams.noTopicsShort')}</span>
      </span>
    </span>
    <span class="exam-card-side">${readinessBadge(pr.readiness)}</span>
  </a>`;
}

export function initExamsPage() {
  const root = document.getElementById('examsView');
  if (!root) return null;
  let token = 0;
  let last = null;
  let currentId = null;
  let showPast = false;

  async function render(examId = currentId) {
    currentId = examId;
    const my = ++token;
    if (!has('exams')) {
      setHtml(root, [pageHead({ eyebrow: t('nav.sectionAcademics'), title: t('nav.exams') }), migrationNotice('exams')]);
      return;
    }
    if (!last) setHtml(root, [pageHead({ eyebrow: t('nav.sectionAcademics'), title: t('nav.exams') }), skeletonRows(3, 96)]);
    let data;
    try {
      data = await loadExamData();
    } catch (err) {
      console.error('Could not load exams', err);
      if (my === token) setHtml(root, [pageHead({ eyebrow: t('nav.sectionAcademics'), title: t('nav.exams') }), errorNotice('', { retryAction: 'retry' })]);
      return;
    }
    if (my !== token) return;
    last = data;
    if (examId) renderDetail(examId, data);
    else renderList(data);
  }

  function renderList(data) {
    const upcoming = data.exams.filter((e) => e.exam_date >= data.today);
    const past = data.exams.filter((e) => e.exam_date < data.today).reverse();
    const head = pageHead({ eyebrow: t('nav.sectionAcademics'), title: t('nav.exams'), subtitle: t('exams.subtitle'), actions: button(t('exams.addExam'), { variant: 'primary', action: 'add-exam', iconName: 'plus' }) });
    if (!data.exams.length) {
      setHtml(root, [head, html`<div class="card">${emptyState({ iconName: 'exam', title: t('exams.emptyTitle'), body: t('exams.emptyBody'), actions: button(t('exams.addExam'), { variant: 'primary', action: 'add-exam', iconName: 'plus' }) })}</div>`]);
      return;
    }
    const behind = upcoming.filter((e) => examProgress(e, data.topics, { today: data.today, plan: data.plan, extraCompletedByTopic: data.completedByTopic }).readiness === 'behind');
    setHtml(root, [head,
      behind.length ? html`<div class="notice notice--warning">${raw(icon('alert'))}<div><p class="notice-title">${t('exams.behindTitle')}</p><p>${t('exams.behindBody').replace('{n}', String(behind.length))}</p></div></div>` : '',
      upcoming.length
        ? html`<section class="stack-sm"><p class="section-label">${t('exams.upcoming')}</p><div class="exam-list">${upcoming.map((e) => examCard(e, data))}</div></section>`
        : html`<div class="card">${emptyState({ iconName: 'exam', title: t('exams.noUpcoming'), body: t('exams.noUpcomingBody'), actions: button(t('exams.addExam'), { action: 'add-exam', iconName: 'plus' }), compact: true })}</div>`,
      past.length ? html`<section class="stack-sm" style="margin-top:var(--space-6)">
        <button type="button" class="card-link" data-action="toggle-past" aria-expanded="${showPast ? 'true' : 'false'}">${showPast ? t('exams.hidePast') : t('exams.showPast').replace('{n}', String(past.length))}</button>
        ${showPast ? html`<div class="exam-list">${past.map((e) => examCard(e, data, { compact: true }))}</div>` : ''}
      </section>` : '',
    ]);
  }

  function renderDetail(examId, data) {
    const exam = data.exams.find((e) => e.id === examId);
    if (!exam) {
      setHtml(root, html`<a class="back-link" href="#/exams">${raw(icon('chevronLeft'))}${t('nav.exams')}</a><div class="card">${emptyState({ iconName: 'exam', title: t('exams.notFound'), body: t('courses.notFoundBody') })}</div>`);
      return;
    }
    const course = data.courses.find((c) => c.id === exam.course_id);
    const topics = data.topics.filter((tp) => tp.exam_id === exam.id);
    const days = examCountdown(exam, data.today);
    const pr = examProgress(exam, data.topics, { today: data.today, plan: data.plan, extraCompletedByTopic: data.completedByTopic });
    const sessions = data.plan.sessions.filter((s) => s.examId === exam.id);
    const unplaced = data.plan.unplaced.filter((u) => u.examId === exam.id);
    const inPlanner = topics.reduce((s, tp) => s + (data.plannedByTopic[tp.id] || 0), 0);
    const remaining = topics.reduce((s, tp) => s + topicRemainingMinutes(tp, data.completedByTopic[tp.id] || 0), 0);
    const byDate = {};
    sessions.forEach((s) => { (byDate[s.date] ||= []).push(s); });
    const dates = Object.keys(byDate).sort();

    setHtml(root, html`<a class="back-link" href="#/exams">${raw(icon('chevronLeft'))}${t('nav.exams')}</a>
      <header class="exam-hero" style="--c:${safeColor(course ? course.color : '')}">
        <div class="exam-hero-count${days !== null && days <= 3 && days >= 0 ? ' is-soon' : ''}">
          <span class="exam-hero-days tabular">${days !== null && days >= 0 ? days : '—'}</span>
          <span class="exam-hero-label">${days === 1 ? t('exams.dayLeft') : t('exams.daysLeft')}</span>
        </div>
        <div class="exam-hero-text">
          ${course ? html`<a class="course-chip" href="#/courses/${course.id}" style="--c:${safeColor(course.color)}"><span class="course-dot"></span>${course.code || course.name}</a>` : ''}
          <h1 class="page-heading">${exam.name}</h1>
          <p class="page-subtitle">${[fmtDateLong(exam.exam_date), exam.start_time ? fmtClockStr(String(exam.start_time).slice(0, 5)) : '', exam.duration_minutes ? fmtMinutes(exam.duration_minutes) : '', exam.location, exam.weight !== null && exam.weight !== undefined ? t('exams.weightShort').replace('{w}', fmtNumber(Number(exam.weight), 2)) : ''].filter(Boolean).join(' · ')}</p>
        </div>
        <div class="page-head-actions">${button(t('common.edit'), { action: 'edit-exam', iconName: 'edit' })}</div>
      </header>
      <div class="grid-main-side">
        <div class="stack">
          <section class="card">
            <div class="card-head"><div><h2 class="card-title">${t('exams.topics')}</h2><p class="card-sub">${t('exams.topicsHint')}</p></div>${button(t('exams.addTopic'), { size: 'sm', variant: 'primary', action: 'add-topic', iconName: 'plus' })}</div>
            ${topics.length ? html`<div class="list">${topics.map((tp) => topicRow(tp, data))}</div>`
              : emptyState({ iconName: 'target', title: t('exams.noTopicsTitle'), body: t('exams.noTopicsBody'), actions: button(t('exams.addTopic'), { action: 'add-topic', iconName: 'plus' }), compact: true })}
          </section>
          ${exam.notes ? html`<section class="card"><div class="card-head"><h2 class="card-title">${t('common.notes')}</h2></div><p class="course-notes" style="margin:0">${exam.notes}</p></section>` : ''}
        </div>
        <div class="stack">
          <section class="card">
            <div class="card-head"><h2 class="card-title">${t('exams.readiness')}</h2>${readinessBadge(pr.readiness)}</div>
            <div class="row" style="gap:var(--space-4)">
              ${ring(pr.fraction, { size: 72, stroke: 7, color: course ? course.color : '', label: fmtPercent(pr.fraction * 100, 0) })}
              <div class="stack-sm">
                <span class="strong">${t('exams.revisedOf').replace('{done}', fmtMinutes(pr.completed)).replace('{total}', fmtMinutes(pr.estimated))}</span>
                <span class="small muted">${remaining ? t('exams.stillToRevise').replace('{time}', fmtMinutes(remaining)) : t('exams.allRevised')}</span>
                ${inPlanner ? html`<span class="small muted">${t('exams.inPlanner').replace('{time}', fmtMinutes(inPlanner))}</span>` : ''}
              </div>
            </div>
          </section>
          <section class="card">
            <div class="card-head">
              <div><h2 class="card-title">${t('exams.planTitle')}</h2><p class="card-sub">${t('exams.planSub').replace('{max}', fmtMinutes(data.dailyMax))}</p></div>
            </div>
            <div class="row" style="margin-bottom:var(--space-3)">
              <label class="small muted" for="revSession">${t('exams.sessionLength')}</label>
              <select id="revSession" class="v3-input" style="width:auto;height:30px">${[30, 45, 60, 90].map((m) => html`<option value="${m}"${m === sessionLength() ? raw(' selected') : ''}>${fmtMinutes(m)}</option>`)}</select>
            </div>
            ${days !== null && days <= 0 ? html`<p class="small muted" style="margin:0">${t('exams.planPast')}</p>`
              : !topics.length ? html`<p class="small muted" style="margin:0">${t('exams.planNeedsTopics')}</p>`
              : html`
                ${unplaced.length ? html`<div class="notice notice--warning" style="margin-bottom:var(--space-3)">${raw(icon('alert'))}<p>${t('exams.unplaced').replace('{time}', fmtMinutes(unplaced.reduce((s, u) => s + u.minutes, 0)))}</p></div>` : ''}
                ${dates.length ? html`<ol class="plan-days">${dates.slice(0, 10).map((d) => html`<li class="plan-day">
                    <span class="plan-day-date">${fmtRelativeDay(d, data.today)}<span class="muted"> · ${fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric' })}</span></span>
                    <ul>${byDate[d].map((s) => html`<li><span>${s.topicName}</span><span class="tabular muted">${fmtMinutes(s.minutes)}</span></li>`)}</ul>
                  </li>`)}</ol>
                  ${dates.length > 10 ? html`<p class="small muted">${t('exams.moreDays').replace('{n}', String(dates.length - 10))}</p>` : ''}
                  ${has('taskExtensions') ? button(t('exams.addToPlanner').replace('{n}', String(sessions.length)), { variant: 'primary', action: 'add-plan', iconName: 'plus', attrs: 'style="width:100%"' }) : html`<p class="small muted">${t('exams.addToPlannerNeedsUpdate')}</p>`}`
                  : html`<p class="small muted" style="margin:0">${remaining ? t('exams.planNothingNew') : t('exams.allRevised')}</p>`}`}
          </section>
        </div>
      </div>`);
    const sel = root.querySelector('#revSession');
    if (sel) sel.addEventListener('change', () => {
      try { localStorage.setItem(SESSION_KEY, sel.value); } catch { /* ignore */ }
      render(examId);
    });
  }

  function topicRow(tp, data) {
    const extra = data.completedByTopic[tp.id] || 0;
    const done = Math.min(tp.estimated_minutes, (tp.completed_minutes || 0) + extra);
    const frac = tp.status === 'done' ? 1 : tp.estimated_minutes ? done / tp.estimated_minutes : 0;
    return html`<div class="list-row topic-row" data-topic-id="${tp.id}">
      <button type="button" class="list-row-main task-open" data-action="edit-topic">
        <span class="list-row-title">${tp.name}</span>
        <span class="list-row-meta">
          <span class="dots" aria-label="${t('exams.difficulty')}: ${tp.difficulty}/3">${[1, 2, 3].map((i) => html`<i class="${i <= tp.difficulty ? 'on' : ''}"></i>`)}</span>
          <span>${t('exams.confidenceShort').replace('{n}', String(tp.confidence))}</span>
          <span class="tabular">${fmtMinutes(done)} / ${fmtMinutes(tp.estimated_minutes)}</span>
        </span>
        ${progressBar(frac, { thin: true, label: tp.name })}
      </button>
      <span class="list-row-side">
        ${tp.status === 'done' ? badge(t('common.done'), 'success') : html`<button type="button" class="btn btn--secondary btn--sm" data-action="log-topic" data-minutes="30" aria-label="${t('exams.log30Label').replace('{name}', tp.name)}">+30m</button>`}
      </span>
    </div>`;
  }

  async function addPlanToPlanner(exam, data) {
    const course = data.courses.find((c) => c.id === exam.course_id);
    const sessions = data.plan.sessions.filter((s) => s.examId === exam.id);
    const existing = new Set(data.linkedTasks.filter((tk) => !tk.completed_at).map((tk) => `${tk.exam_topic_id}|${tk.for_date}`));
    let created = 0;
    for (const s of sessions) {
      if (existing.has(`${s.topicId}|${s.date}`)) continue;
      // eslint-disable-next-line no-await-in-loop
      await createTask(app().userId, {
        planDate: s.date,
        fields: {
          name: t('exams.reviseTaskName').replace('{topic}', s.topicName).replace('{exam}', exam.name),
          minutes_requested: s.minutes,
          due_date: addDays(exam.exam_date, -1),
          priority: s.date >= addDays(exam.exam_date, -3) ? 'high' : 'medium',
          tags: ['Exam'],
          course_id: course ? course.id : null,
          exam_topic_id: s.topicId,
        },
      });
      created += 1;
    }
    return created;
  }

  on(root, 'click', '[data-action]', async (e, el) => {
    const action = el.dataset.action;
    const data = last;
    const exam = data && currentId ? data.exams.find((x) => x.id === currentId) : null;
    if (action === 'retry') render();
    else if (action === 'add-exam') openExamEditor({ onSaved: (saved) => (saved ? app().navigate('examsView', saved.id) : render()) });
    else if (action === 'edit-exam' && exam) openExamEditor({ exam, onSaved: (saved) => (saved ? render(exam.id) : app().navigate('examsView')) });
    else if (action === 'toggle-past') { showPast = !showPast; renderList(data); }
    else if (action === 'add-topic' && exam) openTopicEditor({ exam, nextSortOrder: data.topics.filter((tp) => tp.exam_id === exam.id).length, onSaved: () => render(exam.id) });
    else if (action === 'edit-topic' && exam) {
      const tp = data.topics.find((x) => x.id === el.closest('[data-topic-id]').dataset.topicId);
      if (tp) openTopicEditor({ exam, topic: tp, onSaved: () => render(exam.id) });
    } else if (action === 'log-topic') {
      const tp = data.topics.find((x) => x.id === el.closest('[data-topic-id]').dataset.topicId);
      if (!tp) return;
      el.disabled = true;
      try {
        await updateTopic(tp.id, topicStatusAfterLog(tp, Number(el.dataset.minutes)));
        toast(t('exams.logged').replace('{time}', fmtMinutes(Number(el.dataset.minutes))).replace('{name}', tp.name), { kind: 'success' });
        render(currentId);
      } catch (err) {
        console.error(err);
        el.disabled = false;
        toast(t('v3.saveError'), { kind: 'error' });
      }
    } else if (action === 'add-plan' && exam) {
      el.disabled = true;
      try {
        const n = await addPlanToPlanner(exam, data);
        toast(n ? t('exams.planAdded').replace('{n}', String(n)) : t('exams.planAlreadyAdded'), { kind: 'success' });
        render(exam.id);
      } catch (err) {
        console.error('Could not add revision plan', err);
        el.disabled = false;
        toast(t('exams.planAddFailed'), { kind: 'error' });
        render(exam.id);
      }
    }
  });

  onChange((topic) => {
    if (!root.hidden && ['exams', 'tasks', 'courses'].includes(topic)) render(currentId);
  });

  return {
    onShow(param) {
      render(param || null);
    },
  };
}

// ---------------- course integration ----------------
registerCourseTab({
  id: 'exams',
  order: 20,
  labelKey: 'courses.tabExams',
  async render(container, { course }) {
    if (!has('exams')) {
      setHtml(container, migrationNotice('exams'));
      return;
    }
    setHtml(container, skeletonRows(2, 90));
    const data = await loadExamData();
    const list = data.exams.filter((e) => e.course_id === course.id);
    setHtml(container, html`<div class="toolbar"><span class="toolbar-spacer"></span>${button(t('exams.addExam'), { variant: 'primary', action: 'course-add-exam', iconName: 'plus' })}</div>
      ${list.length ? html`<div class="exam-list">${list.map((e) => examCard(e, data, { compact: e.exam_date < data.today }))}</div>`
        : html`<div class="card">${emptyState({ iconName: 'exam', title: t('exams.noCourseExams'), body: t('exams.noCourseExamsBody'), compact: true })}</div>`}`);
    container.querySelector('[data-action="course-add-exam"]')?.addEventListener('click', () => openExamEditor({ defaultCourseId: course.id, onSaved: (saved) => saved && app().navigate('examsView', saved.id) }));
  },
});

registerCourseOverviewWidget({
  id: 'exams',
  order: 5,
  slot: 'upNext',
  async render({ course }) {
    if (!has('exams')) return '';
    const exams = await listExams(app().userId);
    const today = todayStr();
    const next = exams.filter((e) => e.course_id === course.id && e.exam_date >= today)[0];
    return html`<div class="up-next-item">
      <span class="up-next-icon">${raw(icon('exam'))}</span>
      <span class="up-next-label">${t('exams.nextExam')}</span>
      <span class="up-next-value">${next ? html`<a href="#/exams/${next.id}">${next.name}</a> · ${countdownText(examCountdown(next, today))}` : t('exams.noneScheduled')}</span>
    </div>`;
  },
});
