// Today (V4-D): one calm page for the day — a quick capture box, three
// suggested tasks to do first (with the reason), what's planned today, what's
// due today, what's overdue, today's schedule with a "now" marker, and
// today's routines. Everything here is the same data as the Planner, Tasks
// and Routines pages; nothing is duplicated.

import { t, tCount } from '../shared/i18n.js';
import { has } from '../shared/capabilities.js';
import { minutesOfDay } from '../shared/dates.js';
import { app, onChange } from '../app/context.js';
import { html, raw, setHtml, on, safeColor } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { pageHead, emptyState, button, badge, progressBar, skeletonRows, errorNotice } from '../ui/components.js';
import { fmtDateLong, fmtMinutes, fmtClock } from '../ui/format.js';
import { toast } from '../ui/toast.js';
import { setTaskDone, createTask, moveTaskToDate, canLeaveUnscheduled } from '../tasks/tasksData.js';
import { openTaskEditor } from '../tasks/taskEditor.js';
import { taskRowHtml } from '../tasks/taskRow.js';
import { setCompletion } from '../routines/routinesData.js';
import { routinesForDay, computeStreak, completionMap } from '../routines/routineModel.js';
import { loadToday } from './todayData.js';
import { buildTodayLists, timelineStates, parseQuickTask, todaySummary } from './todayModel.js';

const REASON_KIND = { overdue: 'danger', dueToday: 'warning', highPriority: 'accent', planned: 'outline' };

function fill(key, params) {
  let text = t(key);
  Object.entries(params || {}).forEach(([k, v]) => { text = text.split(`{${k}}`).join(String(v)); });
  return text;
}

export function initTodayPage() {
  const root = document.getElementById('todayView');
  if (!root) return null;
  let token = 0;
  let last = null;
  let draft = '';

  function head(d, summary) {
    const parts = summary ? [
      summary.classes ? tCount('home3.sumClasses', summary.classes) : '',
      summary.studyPlanned ? fill('home3.sumStudy', { time: fmtMinutes(summary.studyPlanned) }) : '',
      summary.plannedTasks ? tCount('today.sumPlanned', summary.plannedTasks) : '',
      summary.dueToday ? tCount('home3.sumDue', summary.dueToday) : '',
    ].filter(Boolean) : [];
    return pageHead({
      eyebrow: d ? fmtDateLong(d.today) : '',
      title: t('nav.today'),
      subtitle: parts.length ? parts.join(' · ') : (d ? t('home3.sumFree') : ''),
      actions: button(t('today.openPlanner'), { variant: 'primary', action: 'today-planner', iconName: 'calendar' }),
    });
  }

  async function render() {
    const my = ++token;
    if (!last) setHtml(root, [head(null), skeletonRows(4, 70)]);
    let d;
    try {
      d = await loadToday();
    } catch (err) {
      console.error('Could not load Today', err);
      if (my === token) setHtml(root, [head(null), errorNotice('', { retryAction: 'today-retry' })]);
      return;
    }
    if (my !== token) return;
    last = d;
    paint(d);
  }

  function paint(d) {
    const courseById = new Map(d.courses.map((c) => [c.id, c]));
    const lists = buildTodayLists(d.groups, d.today, { blocked: d.blocked });
    const summary = todaySummary(lists, d.events, d.today);
    const now = minutesOfDay();
    const row = (g, extra = '') => html`<div class="today-task">${taskRowHtml(g, { course: courseById.get(g.courseId), showCourse: Boolean(g.courseId), blockedInfo: d.blocked.get(g.id), today: d.today })}${extra}</div>`;
    const doToday = (g) => (g.scheduledDate === d.today ? '' : html`<span class="today-task-action">${button(t('today.doToday'), { size: 'sm', variant: 'ghost', action: 'do-today', iconName: 'arrowRight', attrs: `data-task="${g.id}" aria-label="${t('today.doToday')}: ${g.name}"` })}</span>`);

    const capture = html`<form class="card today-capture" data-form="capture" autocomplete="off">
      <label class="sr-only" for="todayCapture">${t('today.captureLabel')}</label>
      <span class="today-capture-icon" aria-hidden="true">${raw(icon('plus'))}</span>
      <input id="todayCapture" class="v3-input" type="text" maxlength="200" placeholder="${t('today.capturePlaceholder')}" value="${draft}" aria-describedby="todayCaptureHint">
      <button type="submit" class="btn btn--primary btn--sm"><span>${t('today.captureAdd')}</span></button>
      <p class="sr-only" id="todayCaptureHint">${t('today.captureHint')}</p>
    </form>`;

    const topCard = html`<section class="card card-flush v4-flush today-top" aria-labelledby="todayTopHead">
      <div class="card-head"><div><h2 class="card-title" id="todayTopHead">${t('today.topTitle')}</h2><p class="card-subtitle">${t('today.topSub')}</p></div></div>
      ${lists.top.length ? html`<ol class="list today-top-list">${lists.top.map(({ group: g, reason }, i) => html`<li class="today-top-item">
          <span class="today-top-n" aria-hidden="true">${i + 1}</span>
          <div class="today-top-body">${taskRowHtml(g, { course: courseById.get(g.courseId), showCourse: Boolean(g.courseId), blockedInfo: d.blocked.get(g.id), today: d.today })}
            ${reason === 'overdue' ? '' : html`<span class="today-top-reason">${badge(t(`today.reason_${reason}`), REASON_KIND[reason])}</span>`}</div>
        </li>`)}</ol>` : html`<div class="card-body">${emptyState({ iconName: 'check', title: t('today.topEmptyTitle'), body: t('today.topEmpty'), compact: true })}</div>`}
    </section>`;

    const plannedCard = html`<section class="card card-flush v4-flush" aria-labelledby="todayPlannedHead">
      <div class="card-head"><h2 class="card-title" id="todayPlannedHead">${t('today.plannedTitle')} <span class="muted">${lists.scheduled.length || ''}</span></h2>${lists.doneToday.length ? html`<span class="small muted">${tCount('today.doneCount', lists.doneToday.length)}</span>` : ''}</div>
      ${lists.scheduled.length ? html`<div class="list">${lists.scheduled.map((g) => row(g))}</div>`
        : html`<div class="card-body">${emptyState({ iconName: 'tasks', title: t('today.plannedEmptyTitle'), body: canLeaveUnscheduled() ? t('today.plannedEmptyBody') : t('today.plannedEmptyBodyV3'), compact: true, actions: button(t('today.openPlanner'), { size: 'sm', action: 'today-planner' }) })}</div>`}
    </section>`;

    const dueCard = lists.dueOnly.length ? html`<section class="card card-flush v4-flush" aria-labelledby="todayDueHead">
      <div class="card-head"><div><h2 class="card-title" id="todayDueHead">${t('today.dueTitle')} <span class="muted">${lists.dueOnly.length}</span></h2><p class="card-subtitle">${t('today.dueSub')}</p></div></div>
      <div class="list">${lists.dueOnly.map((g) => row(g, doToday(g)))}</div>
    </section>` : '';

    const overdueCard = lists.overdue.length ? html`<section class="card card-flush v4-flush today-overdue" aria-labelledby="todayOverdueHead">
      <div class="card-head"><div><h2 class="card-title" id="todayOverdueHead">${t('today.overdueTitle')} <span class="muted">${lists.overdue.length}</span></h2><p class="card-subtitle">${t('today.overdueSub')}</p></div></div>
      <div class="list">${lists.overdue.slice(0, 8).map((g) => row(g, doToday(g)))}</div>
      ${lists.overdue.length > 8 ? html`<div class="card-body"><a class="card-link" href="#/tasks">${fill('today.overdueMore', { n: lists.overdue.length - 8 })}</a></div>` : ''}
    </section>` : '';

    const timeline = timelineStates(d.events, now);
    const studyEvents = d.events.filter((e) => e.kind === 'study');
    const scheduleCard = html`<section class="card card-flush v4-flush today-schedule" aria-labelledby="todaySchedHead">
      <div class="card-head"><h2 class="card-title" id="todaySchedHead">${t('today.scheduleTitle')}</h2><span class="small muted">${summary.studyPlanned ? fill('home3.doneOf', { done: fmtMinutes(summary.studyDone), total: fmtMinutes(summary.studyPlanned) }) : ''}</span></div>
      ${summary.studyPlanned ? progressBar(summary.studyDone / summary.studyPlanned, { thin: true, label: t('home3.progressTitle') }) : ''}
      ${timeline.length ? html`<ol class="today-timeline">${timeline.map((e) => {
        const course = courseById.get(e.courseId);
        const kindKey = `calendar3.kind${e.kind === 'external' ? 'External' : e.kind[0].toUpperCase() + e.kind.slice(1)}`;
        return html`<li class="today-ev is-${e.state}${e.completed ? ' is-completed' : ''}" style="--c:${safeColor(course ? course.color : '', '#8a91a0')}">
          <span class="today-ev-time tabular">${fmtClock(e.start)}<span class="sr-only"> – </span><small>${fmtClock(e.end)}</small></span>
          <span class="today-ev-body"><span class="today-ev-title">${e.title}</span><span class="today-ev-meta">${t(kindKey)}${course ? ` · ${course.code || course.name}` : ''}${e.completed ? ` · ${t('today.evDone')}` : ''}</span></span>
          ${e.state === 'now' ? badge(t('home3.happeningNow'), 'now') : e.state === 'next' ? badge(fill('home3.startsIn', { time: fmtMinutes(e.start - now) }), 'outline') : ''}
        </li>`;
      })}</ol>` : html`<div class="card-body">${emptyState({ iconName: 'calendar', title: t('today.scheduleEmptyTitle'), body: t('today.scheduleEmpty'), compact: true })}</div>`}
      ${studyEvents.some((e) => !e.completed && e.end > now) ? html`<div class="card-body today-focus-row">${button(t('home3.focusNext'), { size: 'sm', action: 'today-planner', iconName: 'play' })}</div>` : ''}
    </section>`;

    const dayRoutines = has('routines') ? routinesForDay(d.routines, d.completions, d.today) : [];
    const routinesCard = has('routines') && d.routines.length ? html`<section class="card card-flush v4-flush" aria-labelledby="todayRoutinesHead">
      <div class="card-head"><h2 class="card-title" id="todayRoutinesHead">${t('nav.routines')}</h2><a class="card-link" href="#/routines">${t('common.viewAll')}</a></div>
      ${dayRoutines.length ? html`<ul class="list">${dayRoutines.map(({ routine: r, status, week }) => {
        const sk = computeStreak(r, d.completions, d.today);
        return html`<li class="list-row routine-row${status ? ` is-${status}` : ''}">
          <button type="button" class="task-check${status === 'done' ? ' is-checked' : ''}" data-action="routine-toggle" data-routine="${r.id}" aria-pressed="${status === 'done' ? 'true' : 'false'}" aria-label="${status === 'done' ? t('routines.untick') : t('routines.tick')}: ${r.title}">${raw(icon('check'))}</button>
          <span class="list-row-main"><span class="list-row-title">${r.title}</span>
            <span class="list-row-meta">${week ? html`<span>${t('routines.weekProgress').replace('{done}', String(week.done)).replace('{target}', String(week.target))}</span>` : ''}${sk.current ? html`<span class="routine-streak">${raw(icon('flame'))}${tCount(sk.unit === 'week' ? 'routines.streakWeeks' : 'routines.streakDays', sk.current)}</span>` : ''}${status === 'skipped' ? html`<span>${t('routines.skipped')}</span>` : ''}</span>
          </span>
        </li>`;
      })}</ul>` : html`<div class="card-body"><p class="muted small" style="margin:0">${t('routines.noneTodayTitle')}</p></div>`}
    </section>` : '';

    setHtml(root, [head(d, summary), capture, html`<div class="today-columns">
      <div class="stack">${topCard}${plannedCard}${dueCard}${overdueCard}</div>
      <div class="stack">${scheduleCard}${routinesCard}</div>
    </div>`]);
  }

  // ---------------- actions ----------------
  on(root, 'submit', '[data-form="capture"]', async (e) => {
    e.preventDefault();
    const input = root.querySelector('#todayCapture');
    const parsed = parseQuickTask(input.value);
    if (!parsed.ok) { input.focus(); return; }
    try {
      await createTask(app().userId, { planDate: last ? last.today : null, fields: { name: parsed.name, minutes_requested: parsed.minutes } });
      draft = '';
      toast(fill('today.captured', { name: parsed.name, time: fmtMinutes(parsed.minutes) }), { kind: 'success' });
      await render();
      root.querySelector('#todayCapture')?.focus();
    } catch (err) {
      console.error(err);
      toast(t('v3.saveError'), { kind: 'error' });
    }
  });
  on(root, 'input', '#todayCapture', (e, el) => { draft = el.value; });

  on(root, 'click', '[data-action]', async (e, el) => {
    const a = el.dataset.action;
    const d = last;
    const ctx = app();
    if (a === 'today-retry') render();
    else if (a === 'today-planner') ctx.openPlannerForDate(d ? d.today : undefined);
    else if (a === 'do-today') {
      const g = d && d.groups.find((x) => x.id === el.dataset.task);
      if (!g) return;
      try {
        await moveTaskToDate(ctx.userId, g.root.id, d.today, g.scheduledDate);
        toast(fill('today.movedToday', { name: g.name }), {
          kind: 'success',
          actionLabel: t('common.undo'),
          onAction: async () => {
            const { unscheduleTask } = await import('../tasks/tasksData.js');
            if (g.scheduledDate) await moveTaskToDate(ctx.userId, g.root.id, g.scheduledDate, d.today);
            else await unscheduleTask(g.root.id, d.today);
            render();
          },
        });
        await render();
        root.querySelector('#todayPlannedHead')?.closest('section')?.querySelector(`[data-task-id="${g.id}"] .task-open`)?.focus();
      } catch (err) {
        console.error(err);
        toast(t('v3.saveError'), { kind: 'error' });
      }
    } else if (a === 'routine-toggle') {
      const r = d && d.routines.find((x) => x.id === el.dataset.routine);
      if (!r) return;
      const current = completionMap(d.completions, r.id).get(d.today) || null;
      try {
        await setCompletion(ctx.userId, r.id, d.today, current === 'done' ? null : 'done');
        await render();
        root.querySelector(`[data-action="routine-toggle"][data-routine="${r.id}"]`)?.focus();
      } catch (err) {
        console.error(err);
        toast(t('v3.saveError'), { kind: 'error' });
      }
    } else if (a === 'open-task' || a === 'toggle-done') {
      const rowEl = el.closest('[data-task-id]');
      const g = rowEl && d && d.groups.find((x) => x.id === rowEl.dataset.taskId);
      if (!g) return;
      if (a === 'open-task') openTaskEditor({ task: g, onSaved: () => render() });
      else {
        try {
          await setTaskDone(g.root.id, !g.done);
          toast(g.done ? t('tasks.reopened') : t('tasks.markedDone'), {
            kind: 'success',
            actionLabel: t('common.undo'),
            onAction: async () => { await setTaskDone(g.root.id, g.done); render(); },
          });
          await render();
        } catch (err) {
          console.error(err);
          toast(err.code === 'needs_migration' ? t('v3.needsUpdateTitle') : t('v3.saveError'), { kind: 'error' });
        }
      }
    }
  });

  onChange((topic) => {
    if (!root.hidden && ['tasks', 'routines', 'courses', 'exams'].includes(topic)) render();
  });

  return { onShow: () => render() };
}
