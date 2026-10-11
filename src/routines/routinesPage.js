// Routines (V4-C): today's routines to tick off (or skip), then every
// routine with its schedule, last-14-days strip, streak and 30-day rate.
// Routines never create tasks — the Planner, Tasks and Carry Over are
// unaffected; Today and Home (V4-D) read the same model.

import { t, tCount } from '../shared/i18n.js';
import { has } from '../shared/capabilities.js';
import { todayStr } from '../shared/dates.js';
import { app, onChange } from '../app/context.js';
import { html, raw, setHtml, on } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { pageHead, emptyState, button, badge, progressBar, skeletonRows, migrationNotice, errorNotice, segmented, wireSegmented } from '../ui/components.js';
import { fmtDateLong, fmtDate, fmtMinutes } from '../ui/format.js';
import { toast } from '../ui/toast.js';
import { listRoutines, listRecentCompletions, setCompletion, pauseRoutine, resumeRoutine } from './routinesData.js';
import { routinesForDay, computeStreak, completionRate, recentDays, routineState, completionMap, weekProgress } from './routineModel.js';
import { openRoutineEditor, weekdayShort } from './routineEditor.js';
import { listGoals } from '../goals/goalsData.js';
import { matchesSpace } from '../workspace/spacesModel.js';
import { currentSpaceFilter, spaceScopeNote } from '../workspace/spaceScope.js';

const VIEWS = ['active', 'paused', 'archived'];
const FILTER_KEY = 'student-scheduler-routines-filter';
const STRIP_DAYS = 14;
const EXAMPLES = [
  { key: 'exStretch', frequency: 'daily', time_of_day: 'morning', duration_minutes: 10 },
  { key: 'exGym', frequency: 'days', days_of_week: [1, 3, 5], time_of_day: 'evening', duration_minutes: 60 },
  { key: 'exLanguage', frequency: 'daily', time_of_day: 'anytime', duration_minutes: 15 },
  { key: 'exRead', frequency: 'weekly_count', weekly_target: 4, time_of_day: 'evening', duration_minutes: 20 },
];

function loadView() {
  try {
    const v = localStorage.getItem(FILTER_KEY);
    return VIEWS.includes(v) ? v : 'active';
  } catch {
    return 'active';
  }
}

function headFor() {
  return pageHead({
    eyebrow: t('nav.sectionWork'),
    title: t('nav.routines'),
    subtitle: t('routines.subtitle'),
    actions: has('routines') ? button(t('routines.new'), { variant: 'primary', action: 'new-routine', iconName: 'plus' }) : '',
  });
}

/** "Every day" / "Mon, Wed, Fri" / "3× a week" (+ time of day, duration). */
export function scheduleText(r) {
  let freq;
  if (r.frequency === 'days') freq = [1, 2, 3, 4, 5, 6, 0].filter((d) => (r.days_of_week || []).map(Number).includes(d)).map(weekdayShort).join(', ');
  else if (r.frequency === 'weekly_count') freq = t('routines.timesPerWeek').replace('{n}', String(r.weekly_target));
  else freq = t('routines.everyDay');
  const parts = [freq];
  if (r.time_of_day && r.time_of_day !== 'anytime') parts.push(t(`routines.time_${r.time_of_day}`));
  if (r.duration_minutes) parts.push(fmtMinutes(r.duration_minutes));
  return parts.join(' · ');
}

function streakText(s) {
  return tCount(s.unit === 'week' ? 'routines.streakWeeks' : 'routines.streakDays', s.current);
}

function stripHtml(r, completions, today) {
  const days = recentDays(r, completions, today, STRIP_DAYS);
  const n = (st) => days.filter((d) => d.state === st).length;
  const label = t('routines.stripLabel').replace('{days}', String(STRIP_DAYS)).replace('{done}', String(n('done'))).replace('{skipped}', String(n('skipped'))).replace('{missed}', String(n('missed')));
  return html`<span class="routine-strip" role="img" aria-label="${label}">${days.map((d) => html`<span class="routine-dot is-${d.state}" title="${fmtDate(d.date)}: ${t(`routines.state_${d.state}`)}"></span>`)}</span>`;
}

export function initRoutinesPage() {
  const root = document.getElementById('routinesView');
  if (!root) return null;
  let token = 0;
  let last = null;
  let view = loadView();

  async function render() {
    const my = ++token;
    if (!has('routines')) {
      setHtml(root, [headFor(), migrationNotice('routines')]);
      return;
    }
    if (!last) setHtml(root, [headFor(), skeletonRows(4, 56)]);
    const ctx = app();
    const today = todayStr();
    let data;
    try {
      const [routines, completions, goals] = await Promise.all([
        listRoutines(ctx.userId),
        listRecentCompletions(ctx.userId, today),
        has('goals') ? listGoals(ctx.userId).catch(() => []) : [],
      ]);
      data = { today, routines, completions, goals };
    } catch (err) {
      console.error('Could not load routines', err);
      if (my === token) setHtml(root, [headFor(), errorNotice('', { retryAction: 'retry' })]);
      return;
    }
    if (my !== token) return;
    last = data;
    paint(data);
  }

  function paint(data) {
    const space = currentSpaceFilter();
    const inSpace = (r) => matchesSpace(r.space_id || null, space);
    const routines = data.routines.filter(inSpace);
    const goalName = new Map(data.goals.map((g) => [g.id, g.title]));
    const { today, completions } = data;

    if (!data.routines.length) {
      setHtml(root, [headFor(), html`<div class="card">${emptyState({
        iconName: 'repeat',
        title: t('routines.emptyTitle'),
        body: t('routines.emptyBody'),
        actions: html`${button(t('routines.new'), { variant: 'primary', action: 'new-routine', iconName: 'plus' })}`,
      })}</div>`, examples()]);
      return;
    }

    // ---- today ----
    const dayList = routinesForDay(routines, completions, today);
    const doneCount = dayList.filter((x) => x.status === 'done').length;
    const todayCard = html`<section class="card card-flush v4-flush routines-today" aria-labelledby="routinesTodayHead">
      <div class="card-head">
        <div>
          <h2 class="card-title" id="routinesTodayHead">${t('routines.todayTitle')}</h2>
          <p class="card-subtitle">${fmtDateLong(today)}</p>
        </div>
        ${dayList.length ? html`<span class="routines-today-count" aria-live="polite">${t('routines.todayCount').replace('{done}', String(doneCount)).replace('{total}', String(dayList.length))}</span>` : ''}
      </div>
      ${dayList.length ? html`${progressBar(doneCount / dayList.length, { thin: true, label: t('routines.todayCount').replace('{done}', String(doneCount)).replace('{total}', String(dayList.length)) })}
      <ul class="list routine-today-list">${dayList.map(({ routine: r, status, week }) => {
        const s = computeStreak(r, completions, today);
        return html`<li class="list-row routine-row${status ? ` is-${status}` : ''}">
          <button type="button" class="task-check${status === 'done' ? ' is-checked' : ''}" data-action="toggle" data-routine="${r.id}" aria-pressed="${status === 'done' ? 'true' : 'false'}" aria-label="${status === 'done' ? t('routines.untick') : t('routines.tick')}: ${r.title}">${raw(icon('check'))}</button>
          <span class="list-row-main">
            <span class="list-row-title">${r.title}</span>
            <span class="list-row-meta">
              <span>${scheduleText(r)}</span>
              ${week ? html`<span>${t('routines.weekProgress').replace('{done}', String(week.done)).replace('{target}', String(week.target))}</span>` : ''}
              ${s.current ? html`<span class="routine-streak">${raw(icon('flame'))}${streakText(s)}</span>` : ''}
              ${status === 'skipped' ? badge(t('routines.skipped'), 'outline') : ''}
            </span>
          </span>
          <span class="list-row-side">
            ${status === 'done' ? '' : button(status === 'skipped' ? t('routines.unskip') : t('routines.skip'), { size: 'sm', variant: 'ghost', action: status === 'skipped' ? 'unskip' : 'skip', attrs: `data-routine="${r.id}" aria-label="${(status === 'skipped' ? t('routines.unskip') : t('routines.skip'))}: ${r.title}"` })}
          </span>
        </li>`;
      })}</ul>` : html`<div class="card-body">${emptyState({ iconName: 'check', title: t('routines.noneTodayTitle'), body: t('routines.noneTodayBody'), compact: true })}</div>`}
    </section>`;

    // ---- all routines ----
    const byView = {
      active: routines.filter((r) => ['active', 'upcoming'].includes(routineState(r, today))),
      paused: routines.filter((r) => routineState(r, today) === 'paused'),
      archived: routines.filter((r) => ['archived', 'ended'].includes(routineState(r, today))),
    };
    const shown = byView[view].slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || String(a.title).localeCompare(String(b.title)));
    const allCard = html`<section class="card card-flush v4-flush routines-all" aria-labelledby="routinesAllHead">
      <div class="card-head">
        <h2 class="card-title" id="routinesAllHead">${t('routines.allTitle')}</h2>
        ${segmented('routineView', VIEWS.map((v) => ({ value: v, label: `${t(`routines.view_${v}`)}${byView[v].length ? ` ${byView[v].length}` : ''}` })), view, { label: t('routines.filterLabel') })}
      </div>
      ${shown.length ? html`<ul class="list">${shown.map((r) => {
        const st = routineState(r, today);
        const s = computeStreak(r, completions, today);
        const rate = completionRate(r, completions, today);
        return html`<li class="list-row routine-all-row">
          <button type="button" class="list-row-main task-open" data-action="edit" data-routine="${r.id}">
            <span class="list-row-title">${r.title}</span>
            <span class="list-row-meta">
              <span>${scheduleText(r)}</span>
              ${r.goal_id && goalName.get(r.goal_id) ? html`<span class="routine-goal">${raw(icon('target'))}${goalName.get(r.goal_id)}</span>` : ''}
              ${st === 'upcoming' ? badge(t('routines.startsOn').replace('{date}', fmtDate(r.start_date)), 'outline') : ''}
              ${st === 'ended' ? badge(t('routines.ended'), 'outline') : ''}
            </span>
          </button>
          ${stripHtml(r, completions, today)}
          <span class="routine-stats">
            <span class="routine-stat"><strong>${s.current}</strong><span>${t(s.unit === 'week' ? 'routines.statStreakWeeks' : 'routines.statStreakDays')}</span></span>
            <span class="routine-stat"><strong>${s.best}</strong><span>${t('routines.statBest')}</span></span>
            <span class="routine-stat"><strong>${rate.rate === null ? '—' : `${Math.round(rate.rate * 100)}%`}</strong><span>${t('routines.stat30')}</span></span>
          </span>
          <span class="list-row-side">
            ${st === 'paused'
              ? button(t('routines.resume'), { size: 'sm', action: 'resume', iconName: 'play', attrs: `data-routine="${r.id}" aria-label="${t('routines.resume')}: ${r.title}"` })
              : ['active', 'upcoming'].includes(st) ? button(t('routines.pause'), { size: 'sm', variant: 'ghost', action: 'pause', iconName: 'pause', attrs: `data-routine="${r.id}" aria-label="${t('routines.pause')}: ${r.title}"` }) : ''}
          </span>
        </li>`;
      })}</ul>` : html`<div class="card-body">${emptyState({ iconName: 'repeat', title: t(`routines.none_${view}`), compact: true })}</div>`}
    </section>`;

    setHtml(root, [headFor(), spaceScopeNote(), todayCard, allCard]);
    wireSegmented(root, 'routineView', (v) => {
      view = v;
      try { localStorage.setItem(FILTER_KEY, v); } catch { /* per-viewer */ }
      paint(last);
      root.querySelector('[data-seg="routineView"] [aria-pressed="true"]')?.focus();
    });
  }

  // Ready-made starting points shown on the empty page.
  function examples() {
    return html`<section class="card routine-examples" aria-labelledby="routineExHead">
      <h2 class="card-title" id="routineExHead">${t('routines.examplesTitle')}</h2>
      <div class="routine-example-row">${EXAMPLES.map((x, i) => html`<button type="button" class="btn btn--secondary btn--sm" data-action="example" data-index="${i}">${raw(icon('plus'))}${t(`routines.${x.key}`)}</button>`)}</div>
    </section>`;
  }

  async function setState(routine, status, undoTo) {
    const ctx = app();
    try {
      await setCompletion(ctx.userId, routine.id, last.today, status);
      if (status === 'done') {
        const map = completionMap(last.completions, routine.id);
        map.set(last.today, 'done');
        const s = computeStreak(routine, map, last.today);
        let msg = t('routines.doneToast').replace('{name}', routine.title);
        if (routine.frequency === 'weekly_count') {
          const w = weekProgress(routine, map, last.today);
          if (w.done === w.target) msg = t('routines.weekMetToast').replace('{name}', routine.title);
        } else if (s.current >= 2) msg = `${msg} ${streakText(s)}`;
        toast(msg, { kind: 'success', actionLabel: t('common.undo'), onAction: async () => { await setCompletion(ctx.userId, routine.id, last.today, undoTo); render(); } });
      }
      await render();
    } catch (err) {
      console.error(err);
      toast(t('v3.saveError'), { kind: 'error' });
    }
  }

  on(root, 'click', '[data-action]', async (e, el) => {
    const a = el.dataset.action;
    const data = last;
    const routine = data && el.dataset.routine ? data.routines.find((r) => r.id === el.dataset.routine) : null;
    if (a === 'retry') render();
    else if (a === 'new-routine') openRoutineEditor({ onSaved: () => render() });
    else if (a === 'example') {
      const { key, ...preset } = EXAMPLES[Number(el.dataset.index)] || EXAMPLES[0];
      openRoutineEditor({ defaults: { ...preset, title: t(`routines.${key}`) }, onSaved: () => render() });
    } else if (!routine) {
      // nothing
    } else if (a === 'edit') openRoutineEditor({ routine, onSaved: () => render(), onDeleted: () => render() });
    else if (a === 'toggle') {
      const current = completionMap(data.completions, routine.id).get(data.today) || null;
      await setState(routine, current === 'done' ? null : 'done', current);
      root.querySelector(`[data-action="toggle"][data-routine="${routine.id}"]`)?.focus();
    } else if (a === 'skip') {
      await setState(routine, 'skipped', null);
      toast(t('routines.skippedToast').replace('{name}', routine.title));
      root.querySelector(`[data-action="unskip"][data-routine="${routine.id}"]`)?.focus();
    } else if (a === 'unskip') {
      await setState(routine, null, 'skipped');
      root.querySelector(`[data-action="skip"][data-routine="${routine.id}"]`)?.focus();
    } else if (a === 'pause' || a === 'resume') {
      try {
        if (a === 'pause') await pauseRoutine(routine, data.today);
        else await resumeRoutine(app().userId, routine, data.completions, data.today);
        toast(a === 'pause' ? t('routines.pausedToast').replace('{name}', routine.title) : t('routines.resumedToast').replace('{name}', routine.title), { kind: 'success' });
        await render();
      } catch (err) {
        console.error(err);
        toast(t('v3.saveError'), { kind: 'error' });
      }
    }
  });

  onChange((topic) => {
    if (!root.hidden && ['routines', 'goals', 'spaces'].includes(topic)) render();
  });

  return { onShow: () => render() };
}
