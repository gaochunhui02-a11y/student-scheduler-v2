// V3 Insights (V3-L). Each card answers one student question from real
// data and says plainly when there isn't enough data yet. Mounted inside
// the existing Insights page, above the V2 charts.

import { t, tCount } from '../shared/i18n.js';
import { has } from '../shared/capabilities.js';
import { todayStr, addDays } from '../shared/dates.js';
import { app } from '../app/context.js';
import { html, raw, setHtml, safeColor, h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { skeletonRows, errorNotice, badge } from '../ui/components.js';
import { fmtMinutes, fmtPercent, fmtDate, fmtClock } from '../ui/format.js';
import { installTooltips } from '../ui/tooltip.js';
import { listCourses, listTaskRowsInWindow, listBlocksForSubjectIds, listSemesters } from '../academics/academicsData.js';
import { sortCourses } from '../academics/courseModel.js';
import { pickCurrentSemester, buildSemesterTimeline } from '../academics/semesterModel.js';
import { buildTaskGroups } from '../tasks/taskModel.js';
import { loadPlannedRange } from '../workload/loadData.js';
import { listFocusSessions } from '../focus/focusHistory.js';
import { loadGradeData } from '../grades/gradesData.js';
import { computeCourseGrade } from '../grades/gradeModel.js';
import { listExams, listExamTopics } from '../exams/examsData.js';
import { examProgress, examCountdown } from '../exams/revisionPlanner.js';
import { computeEstimateAccuracy, estimateStatement } from './estimateModel.js';
import { studyMinutesByCourse, weeklyCompletion, focusByPeriod, recentSessions } from './insightsModel.js';

const OUTCOME = { completed: ['insights3.outcomeCompleted', 'success'], finished_early: ['insights3.outcomeEarly', 'accent'], stopped: ['insights3.outcomeStopped', 'outline'] };

function card(titleKey, questionKey, body, { wide = false } = {}) {
  return html`<section class="card insight-card${wide ? ' is-wide' : ''}">
    <div class="card-head"><div><h2 class="card-title">${t(titleKey)}</h2><p class="card-sub">${t(questionKey)}</p></div></div>
    ${body}
  </section>`;
}

function notEnough(key, params = {}) {
  let text = t(key);
  Object.entries(params).forEach(([k, v]) => { text = text.split(`{${k}}`).join(String(v)); });
  return html`<p class="insight-empty">${raw(icon('info'))}<span>${text}</span></p>`;
}

export function initInsightsV3() {
  const view = document.getElementById('insightsView');
  if (!view) return null;
  installTooltips();
  const root = h('div', { class: 'insights-v3', id: 'insightsV3' });
  const anchor = document.getElementById('insightsMetrics');
  if (anchor) anchor.after(root);
  else view.appendChild(root);
  let token = 0;

  async function load() {
    const ctx = app();
    const today = todayStr();
    const [courses, rows, range, sessions, grades, exams, topics, semesters] = await Promise.all([
      has('courses') ? listCourses(ctx.userId).catch(() => []) : [],
      listTaskRowsInWindow(ctx.userId, addDays(today, -90), addDays(today, 120)).catch(() => []),
      loadPlannedRange(ctx.userId, addDays(today, -41), today),
      listFocusSessions(ctx.userId, { sinceIso: new Date(Date.now() - 90 * 86400000).toISOString() }).catch(() => []),
      has('grades') ? loadGradeData(ctx.userId).catch(() => null) : null,
      has('exams') ? listExams(ctx.userId).catch(() => []) : [],
      has('exams') ? listExamTopics(ctx.userId).catch(() => []) : [],
      has('semesters') ? listSemesters(ctx.userId).catch(() => []) : [],
    ]);
    const blocks = await listBlocksForSubjectIds(rows.map((r) => r.id)).catch(() => []);
    const groups = buildTaskGroups(rows, blocks, { today });
    const subjectCourse = new Map();
    groups.forEach((g) => g.rowIds.forEach((id) => subjectCourse.set(id, g.courseId)));
    range.subjects.forEach((s) => { if (!subjectCourse.has(s.id)) subjectCourse.set(s.id, s.course_id || null); });
    const semester = pickCurrentSemester(semesters, today);
    let timeline = [];
    if (semester) {
      const semRange = await loadPlannedRange(ctx.userId, semester.start_date, semester.end_date).catch(() => null);
      if (semRange) {
        const dateById = new Map(semRange.schedules.map((s) => [s.id, s.for_date]));
        const studyByDate = {};
        semRange.items.filter((i) => i.item_type === 'study').forEach((i) => {
          const d = dateById.get(i.schedule_id);
          if (d) studyByDate[d] = (studyByDate[d] || 0) + (i.end_minutes - i.start_minutes);
        });
        timeline = buildSemesterTimeline({ semester, today, tasks: groups, exams: exams.filter((e) => e.exam_date >= semester.start_date && e.exam_date <= semester.end_date), studyMinutesByDate: studyByDate });
      }
    }
    return { today, courses: sortCourses(courses), groups, range, sessions, grades, exams, topics, subjectCourse, semester, timeline };
  }

  async function render() {
    const my = ++token;
    setHtml(root, skeletonRows(3, 120));
    let d;
    try {
      d = await load();
    } catch (err) {
      console.error('Could not load insights', err);
      if (my === token) setHtml(root, errorNotice(''));
      return;
    }
    if (my !== token) return;
    const courseById = new Map(d.courses.map((c) => [c.id, c]));
    const courseName = (id) => (id && courseById.get(id) ? courseById.get(id).code || courseById.get(id).name : t('insights3.noCourse'));
    const courseColor = (id) => safeColor(id && courseById.get(id) ? courseById.get(id).color : '', '#8a91a0');

    // A. study time by course (last 30 days)
    const byCourse = studyMinutesByCourse({ schedules: d.range.schedules, items: d.range.items, subjectCourse: d.subjectCourse, from: addDays(d.today, -29), to: d.today, knownCourseIds: new Set(courseById.keys()) });
    const totalStudy = byCourse.reduce((s, x) => s + x.minutes, 0);
    const maxCourse = Math.max(1, ...byCourse.map((x) => x.minutes));
    const studyCard = card('insights3.timeTitle', 'insights3.timeQ', byCourse.length
      ? html`<div class="hbars">${byCourse.map((x) => html`<div class="hbar-row" tabindex="0" data-tip="${courseName(x.courseId)}: ${fmtMinutes(x.minutes)} (${fmtPercent((x.minutes / totalStudy) * 100, 0)})">
          <span class="hbar-label">${courseName(x.courseId)}</span>
          <span class="hbar-track"><span class="hbar-fill" style="width:${(x.minutes / maxCourse) * 100}%;--c:${courseColor(x.courseId)}"></span></span>
          <span class="hbar-value tabular">${fmtMinutes(x.minutes)}</span>
        </div>`)}</div><p class="small muted">${t('insights3.timeTotal').replace('{time}', fmtMinutes(totalStudy))}</p>`
      : notEnough('insights3.timeEmpty'));

    // B. weekly completion (6 weeks)
    const weeks = weeklyCompletion({ schedules: d.range.schedules, items: d.range.items, today: d.today, weeks: 6 });
    const maxWeek = Math.max(1, ...weeks.map((w) => w.planned));
    const trendCard = card('insights3.trendTitle', 'insights3.trendQ', weeks.some((w) => w.planned)
      ? html`<div class="vbars" role="list">${weeks.map((w) => html`<div class="vbar${w.isCurrent ? ' is-current' : ''}" role="listitem" tabindex="0" data-tip="${fmtDate(w.start)} – ${fmtDate(w.end)}: ${fmtMinutes(w.completed)} / ${fmtMinutes(w.planned)}">
          <span class="vbar-rate tabular">${w.rate === null ? '—' : fmtPercent(w.rate * 100, 0)}</span>
          <span class="vbar-col"><span class="vbar-planned" style="height:${(w.planned / maxWeek) * 100}%"><span class="vbar-done" style="height:${w.planned ? (w.completed / w.planned) * 100 : 0}%"></span></span></span>
          <span class="vbar-label">${fmtDate(w.start, { month: 'short', day: 'numeric' })}</span>
        </div>`)}</div>
        <div class="load-legend small"><span><i class="lg-planned"></i>${t('insights3.legendPlanned')}</span><span><i class="lg-done"></i>${t('insights3.legendDone')}</span></div>`
      : notEnough('insights3.trendEmpty'));

    // C. grades vs targets
    let gradeBody = notEnough(has('grades') ? 'insights3.gradesEmpty' : 'insights3.gradesNeedsUpdate');
    if (d.grades) {
      const rowsG = d.courses.filter((c) => !c.archived).map((c) => ({ c, s: computeCourseGrade({ categories: d.grades.categories.filter((x) => x.course_id === c.id), items: d.grades.items.filter((x) => x.course_id === c.id) }) })).filter((r) => r.s.current !== null);
      if (rowsG.length) {
        gradeBody = html`<div class="bullets">${rowsG.map(({ c, s }) => {
          const target = c.target_grade !== null && c.target_grade !== undefined ? Number(c.target_grade) : null;
          return html`<a class="bullet-row" href="#/courses/${c.id}:grades" data-tip="${c.code || c.name}: ${fmtPercent(s.current, 1)}${target !== null ? ` · ${t('grades.target')} ${fmtPercent(target, 1)}` : ''}">
            <span class="hbar-label">${c.code || c.name}</span>
            <span class="bullet-track"><span class="bullet-fill" style="width:${Math.min(100, s.current)}%;--c:${safeColor(c.color)}"></span>${target !== null ? html`<span class="bullet-target" style="left:${Math.min(100, target)}%"></span>` : ''}</span>
            <span class="hbar-value tabular${target !== null && s.current < target ? ' is-below' : ''}">${fmtPercent(s.current, 1)}</span>
          </a>`;
        })}</div><p class="small muted">${t('insights3.gradesHint')}</p>`;
      }
    }
    const gradesCard = card('insights3.gradesTitle', 'insights3.gradesQ', gradeBody);

    // D. exam readiness
    const upcoming = d.exams.filter((e) => e.exam_date >= d.today).slice(0, 5);
    const examsCard = card('insights3.examsTitle', 'insights3.examsQ', upcoming.length
      ? html`<div class="list">${upcoming.map((e) => {
          const pr = examProgress(e, d.topics, { today: d.today });
          const days = examCountdown(e, d.today);
          return html`<a class="list-row" href="#/exams/${e.id}">
            <span class="exam-mini-count tabular" style="--c:${courseColor(e.course_id)}">${days}<small>${days === 1 ? t('exams.dayLeft') : t('exams.daysLeft')}</small></span>
            <span class="list-row-main"><span class="list-row-title">${e.name}</span>
              <span class="list-row-meta">${courseName(e.course_id)} · ${pr.topicCount ? t('insights3.revised').replace('{pct}', fmtPercent(pr.fraction * 100, 0)) : t('exams.noTopicsShort')}</span></span>
            <span class="hbar-track mini"><span class="hbar-fill" style="width:${pr.fraction * 100}%;--c:${courseColor(e.course_id)}"></span></span>
          </a>`;
        })}</div>`
      : notEnough('insights3.examsEmpty'));

    // E. estimate accuracy
    const acc = computeEstimateAccuracy({ groups: d.groups, sessions: d.sessions });
    const statements = acc.byCourse.map((c) => ({ c, st: estimateStatement(c, courseName(c.courseId)) }));
    const overall = estimateStatement(acc.overall, null);
    const fmtSt = (st) => {
      let text = t(st.key);
      Object.entries(st.params).forEach(([k, v]) => { text = text.split(`{${k}}`).join(String(v)); });
      return text;
    };
    const accCard = card('insights3.accTitle', 'insights3.accQ', acc.overall.n === 0
      ? notEnough('insights3.accEmpty', { n: acc.minSamples })
      : html`${overall ? html`<p class="insight-statement">${fmtSt(overall)}</p>` : notEnough('insights3.accNotYet', { n: acc.overall.n, min: acc.minSamples })}
        <ul class="acc-list">${statements.map(({ c, st }) => html`<li>
          <span class="course-dot" style="--c:${courseColor(c.courseId)}"></span>
          <span class="acc-text">${st ? fmtSt(st) : t('insights3.accCourseNotYet').replace('{course}', courseName(c.courseId)).replace('{n}', String(c.n)).replace('{min}', String(acc.minSamples))}</span>
          ${badge(tCount('insights3.samples', c.n), 'outline')}
        </li>`)}</ul>`);

    // F. focus by time of day
    const fp = focusByPeriod(d.sessions);
    const maxP = Math.max(1, ...fp.rows.map((r) => r.minutes));
    const focusCard = card('insights3.focusTitle', 'insights3.focusQ', !has('focusSessions')
      ? notEnough('insights3.focusNeedsUpdate')
      : !fp.enough
        ? notEnough('insights3.focusNotYet', { n: fp.total, min: 5 })
        : html`<div class="hbars">${fp.rows.map((r) => html`<div class="hbar-row${fp.best === r.period ? ' is-best' : ''}" tabindex="0" data-tip="${t(`insights3.period_${r.period}`)}: ${r.count} · ${fmtMinutes(r.minutes)}${r.followThrough !== null ? ` · ${fmtPercent(r.followThrough * 100, 0)}` : ''}">
            <span class="hbar-label">${t(`insights3.period_${r.period}`)}</span>
            <span class="hbar-track"><span class="hbar-fill" style="width:${(r.minutes / maxP) * 100}%"></span></span>
            <span class="hbar-value tabular">${r.followThrough === null ? '—' : fmtPercent(r.followThrough * 100, 0)}</span>
          </div>`)}</div>
          <p class="small muted">${fp.best ? t('insights3.focusBest').replace('{period}', t(`insights3.period_${fp.best}`)) : t('insights3.focusNoBest')}</p>`);

    // G. recent sessions
    const recent = recentSessions(d.sessions, 6);
    const taskName = (id) => (d.groups.find((g) => g.rowIds.includes(id)) || {}).name || t('insights3.unknownTask');
    const historyCard = card('insights3.historyTitle', 'insights3.historyQ', recent.length
      ? html`<div class="list">${recent.map((s) => {
          const [k, kind] = OUTCOME[s.outcome] || OUTCOME.stopped;
          const start = new Date(s.started_at);
          return html`<div class="list-row">
            <span class="list-row-main"><span class="list-row-title">${taskName(s.task_id)}</span>
              <span class="list-row-meta">${fmtDate(`${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`)} · ${fmtClock(start.getHours() * 60 + start.getMinutes())} · ${t('insights3.plannedActual').replace('{planned}', fmtMinutes(s.planned_minutes)).replace('{actual}', fmtMinutes(s.actual_minutes))}${s.notes ? ` · “${s.notes.slice(0, 60)}”` : ''}</span></span>
            ${badge(t(k), kind)}
          </div>`;
        })}</div>`
      : notEnough(has('focusSessions') ? 'insights3.historyEmpty' : 'insights3.focusNeedsUpdate'));

    // H. semester intensity
    const maxLoad = Math.max(1, ...d.timeline.map((w) => w.load));
    const semCard = card('insights3.semTitle', 'insights3.semQ', d.timeline.length
      ? html`<a class="spark" href="#/semester" aria-label="${t('nav.semester')}">${d.timeline.map((w) => html`<span class="spark-bar${w.isCurrent ? ' is-current' : ''}${w.isBreak ? ' is-break' : ''}" tabindex="0" data-tip="${t('semester.weekShort').replace('{n}', String(w.index))} · ${fmtMinutes(w.load)}" style="height:${Math.max(4, (w.load / maxLoad) * 100)}%"></span>`)}</a>
        <p class="small muted">${t('insights3.semHint').replace('{name}', d.semester.name)}</p>`
      : notEnough('insights3.semEmpty'), { wide: true });

    setHtml(root, html`<div class="insights-grid">${studyCard}${trendCard}${gradesCard}${examsCard}${accCard}${focusCard}${historyCard}${semCard}</div>`);
  }

  return { onShow: () => render() };
}
