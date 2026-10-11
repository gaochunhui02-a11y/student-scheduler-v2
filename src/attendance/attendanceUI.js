// Attendance (V4-G) in the course workspace: an "Attendance" tab (every
// held session of the term with Present / Late / Absent / Excused), an
// Overview card (rate, absences you can still afford) and a rate badge on
// each Courses card. Self-registers through the course tab registry, like
// Grades and Exams. Also exports quickMark for the Today page.

import { t, tCount } from '../shared/i18n.js';
import { has } from '../shared/capabilities.js';
import { todayStr, addDays, minutesOfDay } from '../shared/dates.js';
import { app } from '../app/context.js';
import { html, raw, setHtml, escapeHtml } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { button, badge, ring, skeletonRows, migrationNotice, emptyState } from '../ui/components.js';
import { fmtDate, fmtWeekday, fmtClock } from '../ui/format.js';
import { toast } from '../ui/toast.js';
import { confirmAction } from '../ui/drawer.js';
import { registerCourseTab, registerCourseOverviewWidget, registerCourseCardProvider } from '../courses/courseTabs.js';
import { listAllClassSeries, listAllClassSeriesExceptions, listSemesters } from '../academics/academicsData.js';
import { pickCurrentSemester } from '../academics/semesterModel.js';
import { ATTENDANCE_STATUSES, MIN_RATE, sessionsForCourse, summarizeAttendance, toggleStatus, absencesAllowed } from './attendanceModel.js';
import { listAttendance, listCourseOneOffClasses, setAttendance, markSessions } from './attendanceData.js';

const STATE_KIND = { good: 'success', warning: 'warning', risk: 'danger' };

/** Term window for a course: its semester (or the current one) up to today; else the last 10 weeks. */
function windowFor(course, semesters, today) {
  const sem = semesters.find((s) => s.id === course.semester_id) || pickCurrentSemester(semesters, today);
  const from = sem && sem.start_date <= today ? sem.start_date : addDays(today, -70);
  const to = sem && sem.end_date < today ? sem.end_date : today;
  return { from, to };
}

async function loadCourseAttendance(course) {
  const userId = app().userId;
  const today = todayStr();
  const [series, exceptions, oneOffs, records, semesters] = await Promise.all([
    listAllClassSeries(userId).catch(() => []),
    listAllClassSeriesExceptions(userId).catch(() => []),
    listCourseOneOffClasses(userId).catch(() => []),
    listAttendance(userId),
    has('semesters') ? listSemesters(userId).catch(() => []) : [],
  ]);
  const { from, to } = windowFor(course, semesters, today);
  const sessions = sessionsForCourse({ courseId: course.id, series, exceptions, oneOffs, from, to });
  const mine = records.filter((r) => r.course_id === course.id);
  return { today, sessions, summary: summarizeAttendance(sessions, mine, today, minutesOfDay()) };
}

function rateText(summary) {
  return summary.rate === null ? '—' : `${Math.round(summary.rate * 100)}%`;
}

function allowedText(summary) {
  const n = absencesAllowed(summary);
  if (n === null) return '';
  if (n < 0) return t('attendance.belowMin').replace('{min}', String(Math.round(MIN_RATE * 100)));
  return tCount('attendance.canMiss', n).replace('{min}', String(Math.round(MIN_RATE * 100)));
}

function statusButtons(s, courseId) {
  return html`<span class="att-status" role="group" aria-label="${t('attendance.statusFor').replace('{session}', `${fmtDate(s.date)} ${fmtClock(s.start)}`)}">
    ${ATTENDANCE_STATUSES.map((st) => html`<button type="button" class="att-btn att-btn--${st}" data-action="att-set" data-status="${st}" data-course="${courseId}" data-date="${s.date}" data-start="${s.start}" data-series="${s.seriesId || ''}" aria-pressed="${s.status === st ? 'true' : 'false'}">${t(`attendance.status_${st}`)}</button>`)}
  </span>`;
}

// ---------------- course tab ----------------
async function renderTab(container, { course }) {
  if (!has('attendance')) {
    setHtml(container, migrationNotice('attendance'));
    return;
  }
  setHtml(container, skeletonRows(3, 56));
  let d;
  try {
    d = await loadCourseAttendance(course);
  } catch (err) {
    console.error(err);
    setHtml(container, html`<p class="field-error">${t('v3.loadErrorBody')}</p>`);
    return;
  }
  const s = d.summary;
  const list = s.list.slice().reverse();
  const unmarked = s.list.filter((x) => !x.status);
  setHtml(container, html`
    <section class="card att-summary" aria-label="${t('attendance.title')}">
      ${ring(s.rate || 0, { size: 72, stroke: 7, label: rateText(s), color: course.color })}
      <div>
        <p class="att-summary-main"><strong>${s.rate === null ? t('attendance.noneMarked') : t('attendance.rateLine').replace('{rate}', rateText(s))}</strong> ${s.state ? badge(t(`attendance.state_${s.state}`), STATE_KIND[s.state]) : ''}</p>
        <p class="small muted">${t('attendance.counts').replace('{present}', s.present).replace('{late}', s.late).replace('{absent}', s.absent).replace('{excused}', s.excused)}</p>
        ${allowedText(s) ? html`<p class="small">${allowedText(s)}</p>` : ''}
      </div>
      ${unmarked.length ? html`<div class="att-summary-actions">${button(tCount('attendance.markAllPresent', unmarked.length), { size: 'sm', action: 'att-all-present', iconName: 'check' })}</div>` : ''}
    </section>
    ${list.length ? html`<section class="card card-flush v4-flush" aria-labelledby="attListHead">
      <div class="card-head"><h2 class="card-title" id="attListHead">${t('attendance.sessions')} <span class="muted">${s.held}</span></h2>${unmarked.length ? html`<span class="small muted">${tCount('attendance.unmarked', unmarked.length)}</span>` : ''}</div>
      <ul class="list att-list">${list.map((x) => html`<li class="list-row att-row${x.status ? ` is-${x.status}` : ' is-unmarked'}">
        <span class="list-row-main"><span class="list-row-title">${fmtWeekday(x.date, 'short')} ${fmtDate(x.date)} · ${fmtClock(x.start)}–${fmtClock(x.end)}</span><span class="list-row-meta">${x.name}</span></span>
        ${statusButtons(x, course.id)}
      </li>`)}</ul>
    </section>` : html`<div class="card">${emptyState({ iconName: 'calendar', title: t('attendance.noSessionsTitle'), body: t('attendance.noSessionsBody'), compact: true })}</div>`}`);

  container.onclick = async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    if (el.dataset.action === 'att-set') {
      const current = s.list.find((x) => x.date === el.dataset.date && String(x.start) === el.dataset.start);
      const next = toggleStatus(current ? current.status : null, el.dataset.status);
      try {
        await setAttendance(app().userId, { course_id: course.id, attended_on: el.dataset.date, start_minutes: Number(el.dataset.start), class_series_id: el.dataset.series || null }, next);
        await renderTab(container, { course });
        container.querySelector(`[data-action="att-set"][data-date="${el.dataset.date}"][data-start="${el.dataset.start}"][data-status="${el.dataset.status}"]`)?.focus();
      } catch (err) {
        console.error(err);
        toast(t('v3.saveError'), { kind: 'error' });
      }
    } else if (el.dataset.action === 'att-all-present') {
      const ok = await confirmAction({ title: tCount('attendance.markAllPresent', unmarked.length), message: t('attendance.markAllBody'), confirmLabel: t('attendance.markAllConfirm') });
      if (!ok) return;
      try {
        await markSessions(app().userId, course.id, unmarked, 'present');
        toast(tCount('attendance.markedCount', unmarked.length), { kind: 'success' });
        renderTab(container, { course });
      } catch (err) {
        console.error(err);
        toast(t('v3.saveError'), { kind: 'error' });
      }
    }
  };
}

registerCourseTab({ id: 'attendance', order: 15, labelKey: 'attendance.tab', render: renderTab });

// ---------------- overview card ----------------
registerCourseOverviewWidget({
  id: 'attendance',
  order: 12,
  slot: 'side',
  async render({ course }) {
    if (!has('attendance')) return '';
    const d = await loadCourseAttendance(course);
    if (!d.summary.held) return '';
    const s = d.summary;
    return html`<section class="card">
      <div class="card-head"><h2 class="card-title">${t('attendance.title')}</h2><a class="card-link" href="#/courses/${course.id}:attendance">${t('common.viewAll')}</a></div>
      <div class="row-between"><span class="grade-big" style="font-size:var(--text-2xl)">${rateText(s)}</span>${s.state ? badge(t(`attendance.state_${s.state}`), STATE_KIND[s.state]) : ''}</div>
      <p class="small muted" style="margin:var(--space-2) 0 0">${s.unmarked ? tCount('attendance.unmarked', s.unmarked) : allowedText(s)}</p>
    </section>`;
  },
});

// ---------------- course card badge ----------------
registerCourseCardProvider({
  id: 'attendance',
  async load(courses) {
    if (!has('attendance')) return {};
    const userId = app().userId;
    const today = todayStr();
    const [series, exceptions, oneOffs, records, semesters] = await Promise.all([
      listAllClassSeries(userId).catch(() => []), listAllClassSeriesExceptions(userId).catch(() => []),
      listCourseOneOffClasses(userId).catch(() => []), listAttendance(userId), has('semesters') ? listSemesters(userId).catch(() => []) : [],
    ]);
    const out = {};
    courses.forEach((c) => {
      const mine = records.filter((r) => r.course_id === c.id);
      if (!mine.length) return;
      const { from, to } = windowFor(c, semesters, today);
      const s = summarizeAttendance(sessionsForCourse({ courseId: c.id, series, exceptions, oneOffs, from, to }), mine, today, minutesOfDay());
      if (s.rate === null) return;
      out[c.id] = `<span class="badge badge--${STATE_KIND[s.state] || 'outline'} tabular" title="${escapeHtml(t('attendance.title'))}">${escapeHtml(icon('user'))}${Math.round(s.rate * 100)}%</span>`;
    });
    return out;
  },
});

// ---------------- Today page quick marking ----------------
/** Records for today keyed by course|start, for the Today schedule. */
export async function todayAttendance(userId, today) {
  if (!has('attendance')) return new Map();
  const records = await listAttendance(userId).catch(() => []);
  return new Map(records.filter((r) => r.attended_on === today).map((r) => [`${r.course_id}|${r.start_minutes}`, r.status]));
}

export function quickMarkHtml(event, status) {
  return html`<span class="att-status att-status--compact" role="group" aria-label="${t('attendance.statusFor').replace('{session}', event.title)}">
    ${['present', 'absent'].map((st) => html`<button type="button" class="att-btn att-btn--${st}" data-action="att-quick" data-status="${st}" data-course="${event.courseId}" data-start="${event.start}" data-series="${event.seriesId || ''}" aria-pressed="${status === st ? 'true' : 'false'}">${raw(icon(st === 'present' ? 'check' : 'close'))}<span>${t(`attendance.status_${st}`)}</span></button>`)}
  </span>`;
}
