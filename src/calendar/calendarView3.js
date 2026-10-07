// Calendar (V3-M): Month / Week / Agenda over the same data as the Planner,
// with filters (classes, study, deadlines, exams, imported). In Week view,
// study blocks can be dragged to a new time or day and resized; every drop
// is validated (past, due date, the day's hours, overlaps) and the block is
// pinned so Regenerate keeps it. Keyboard / touch fallback: open any block
// and edit its date, time and length in a drawer.
// The .ics Import / Export cards below are unchanged from V2.

import { t } from '../shared/i18n.js';
import { has } from '../shared/capabilities.js';
import { todayStr, addDays, startOfWeek, monthGrid, firstOfMonth, addMonths, minutesOfDay, dateRange, clockToMinutes } from '../shared/dates.js';
import { app, onChange } from '../app/context.js';
import { html, raw, setHtml, safeColor, h, escapeHtml } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { segmented, wireSegmented, skeletonRows, errorNotice, emptyState } from '../ui/components.js';
import { fmtClock, fmtDate, fmtDateLong, fmtWeekday, fmtMinutes, fmtMonthYear } from '../ui/format.js';
import { toast } from '../ui/toast.js';
import { openDrawer } from '../ui/drawer.js';
import { listClassesForScheduleIds, updateScheduleItemTime, setScheduleItemLocked } from '../dashboard/data.js';
import { listCourses, listTaskRowsInWindow, listBlocksForSubjectIds, listAllClassSeries, listAllClassSeriesExceptions } from '../academics/academicsData.js';
import { listExams } from '../exams/examsData.js';
import { buildTaskGroups } from '../tasks/taskModel.js';
import { openTaskEditor } from '../tasks/taskEditor.js';
import { loadPlannedRange } from '../workload/loadData.js';
import { dayWindow, mealIntervals } from '../workload/rebalanceModel.js';
import { applyRebalanceMoves } from '../workload/workloadData.js';
import { invalidate } from '../app/store.js';
import { buildCalendarEvents, filterEvents, layoutDay, validateDrop, EVENT_KINDS } from './calendarEvents.js';

const PREF_KEY = 'student-scheduler-calendar-v3';
const PX_PER_MIN = 0.8;
const SNAP = 15;
const KIND_LABEL = { class: 'calendar3.kindClass', study: 'calendar3.kindStudy', deadline: 'calendar3.kindDeadline', exam: 'calendar3.kindExam', external: 'calendar3.kindExternal' };

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    return {
      mode: ['month', 'week', 'agenda'].includes(p.mode) ? p.mode : null,
      kinds: Array.isArray(p.kinds) ? p.kinds.filter((k) => EVENT_KINDS.includes(k)) : [...EVENT_KINDS],
    };
  } catch {
    return { mode: null, kinds: [...EVENT_KINDS] };
  }
}

function isNarrow() {
  return window.matchMedia && window.matchMedia('(max-width: 640px)').matches;
}

export function initCalendarV3() {
  const view = document.getElementById('calendarView');
  if (!view) return null;
  // Hide the V2 agenda (replaced by this view); keep Import/Export cards.
  ['agendaFilters', 'agendaStatus', 'agendaList'].forEach((id) => document.getElementById(id)?.classList.add('v3-hidden'));
  view.querySelector('.week-nav-row')?.classList.add('v3-hidden');
  const heading = document.getElementById('agendaRangeHeading');
  const root = h('div', { class: 'cal3', id: 'calendarV3' });
  view.querySelector('.board-header').after(root);

  const prefs = loadPrefs();
  let mode = prefs.mode || (isNarrow() ? 'agenda' : 'week');
  let kinds = prefs.kinds.length ? prefs.kinds : [...EVENT_KINDS];
  let anchor = todayStr();
  let focusDay = todayStr(); // narrow week view: the one day shown
  let data = null;
  let token = 0;

  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ mode, kinds })); } catch { /* ignore */ }
  }

  function range() {
    if (mode === 'month') {
      const grid = monthGrid(anchor);
      return { from: grid[0].date, to: grid[41].date };
    }
    const from = startOfWeek(anchor);
    return { from, to: addDays(from, mode === 'agenda' ? 13 : 6) };
  }

  async function load() {
    const ctx = app();
    const { from, to } = range();
    const today = todayStr();
    const [planned, series, exceptions, rows, exams, courses] = await Promise.all([
      loadPlannedRange(ctx.userId, from, to),
      listAllClassSeries(ctx.userId).catch(() => []),
      listAllClassSeriesExceptions(ctx.userId).catch(() => []),
      listTaskRowsInWindow(ctx.userId, from, to).catch(() => []),
      has('exams') ? listExams(ctx.userId).catch(() => []) : [],
      has('courses') ? listCourses(ctx.userId).catch(() => []) : [],
    ]);
    const [classes, blocks] = await Promise.all([
      listClassesForScheduleIds(planned.schedules.map((s) => s.id)).catch(() => []),
      listBlocksForSubjectIds(rows.map((r) => r.id)).catch(() => []),
    ]);
    const groups = buildTaskGroups(rows, blocks, { today });
    const events = buildCalendarEvents({ from, to, schedules: planned.schedules, items: planned.items, classes, series, exceptions, subjects: planned.subjects, groups, exams, courses });
    const scheduleByDate = new Map(planned.schedules.map((s) => [s.for_date, s]));
    const dueBySubject = {};
    groups.forEach((g) => g.rowIds.forEach((id) => { dueBySubject[id] = g.dueDate; }));
    return { from, to, today, events, groups, planned, scheduleByDate, dueBySubject };
  }

  async function render() {
    const my = ++token;
    drawShell();
    const body = root.querySelector('#cal3Body');
    if (!data) setHtml(body, skeletonRows(5, 70));
    try {
      const next = await load();
      if (my !== token) return;
      data = next;
      drawBody();
    } catch (err) {
      console.error('Could not load calendar', err);
      if (my === token) setHtml(body, errorNotice('', { retryAction: 'cal-retry' }));
    }
  }

  function title() {
    const { from, to } = range();
    if (mode === 'month') return fmtMonthYear(anchor);
    return `${fmtDate(from)} – ${fmtDate(to, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }

  function drawShell() {
    if (heading) heading.textContent = title();
    setHtml(root, html`<div class="cal3-toolbar">
        ${segmented('calMode', [{ value: 'month', label: t('calendar3.month') }, { value: 'week', label: t('calendar3.week') }, { value: 'agenda', label: t('calendar3.agenda') }], mode, { label: t('calendar3.viewLabel') })}
        <div class="cal3-nav">
          <button type="button" class="btn btn--secondary btn--icon btn--sm" data-cal="prev" aria-label="${t('calendar3.previous')}">${raw(icon('chevronLeft'))}</button>
          <button type="button" class="btn btn--secondary btn--sm" data-cal="today">${t('time.today')}</button>
          <button type="button" class="btn btn--secondary btn--icon btn--sm" data-cal="next" aria-label="${t('calendar3.next')}">${raw(icon('chevronRight'))}</button>
        </div>
        <div class="cal3-filters" role="group" aria-label="${t('calendar3.show')}">
          ${EVENT_KINDS.map((k) => html`<button type="button" class="chip-toggle cal3-chip cal3-chip--${k}" data-kind="${k}" aria-pressed="${kinds.includes(k) ? 'true' : 'false'}"><i aria-hidden="true"></i>${t(KIND_LABEL[k])}</button>`)}
        </div>
      </div>
      <div id="cal3Body"></div>`);
    wireSegmented(root, 'calMode', (v) => {
      mode = v;
      savePrefs();
      data = null;
      render();
    });
  }

  function visibleEvents() {
    return filterEvents(data.events, kinds);
  }

  function chip(ev) {
    const label = ev.allDay ? ev.title : `${fmtClock(ev.start)} ${ev.title}`;
    return html`<button type="button" class="cal3-mchip cal3-mchip--${ev.kind}${ev.completed ? ' is-done' : ''}" data-event="${ev.id}" style="--c:${safeColor(ev.color, '')}" title="${label}">${label}</button>`;
  }

  // ---------------- Month ----------------
  function drawMonth(body) {
    const grid = monthGrid(anchor);
    const evs = visibleEvents();
    const byDate = {};
    evs.forEach((e) => { (byDate[e.date] ||= []).push(e); });
    setHtml(body, html`<div class="cal3-month" role="grid" aria-label="${fmtMonthYear(anchor)}">
      ${[1, 2, 3, 4, 5, 6, 0].map((d) => html`<span class="cal3-dow" role="columnheader">${fmtWeekday(addDays('2026-10-04', d), 'short')}</span>`)}
      ${grid.map((cell) => {
        const list = byDate[cell.date] || [];
        const studyMin = list.filter((e) => e.kind === 'study').reduce((s, e) => s + (e.end - e.start), 0);
        const shown = list.filter((e) => e.kind !== 'study').slice(0, 3);
        const more = list.filter((e) => e.kind !== 'study').length - shown.length;
        return html`<div class="cal3-mcell${cell.inMonth ? '' : ' is-out'}${cell.date === data.today ? ' is-today' : ''}" role="gridcell">
          <button type="button" class="cal3-mdate" data-cal-day="${cell.date}" aria-label="${fmtDateLong(cell.date)}">${fmtDate(cell.date, { day: 'numeric' })}</button>
          <div class="cal3-mchips">${shown.map(chip)}${more > 0 ? html`<button type="button" class="cal3-more" data-cal-day="${cell.date}">${t('calendar3.more').replace('{n}', String(more))}</button>` : ''}</div>
          ${studyMin ? html`<span class="cal3-mstudy">${t('calendar3.studyShort').replace('{time}', fmtMinutes(studyMin))}</span>` : ''}
        </div>`;
      })}
    </div>`);
  }

  // ---------------- Week (time grid) ----------------
  function drawWeek(body) {
    const narrow = isNarrow();
    const { from } = range();
    const days = narrow ? [focusDay >= from && focusDay <= addDays(from, 6) ? focusDay : from] : dateRange(from, addDays(from, 6));
    const evs = visibleEvents();
    const timed = evs.filter((e) => !e.allDay);
    const startH = Math.min(7, ...timed.map((e) => Math.floor(e.start / 60)));
    const endH = Math.max(22, ...timed.map((e) => Math.ceil(e.end / 60)));
    const minStart = startH * 60;
    const height = (endH - startH) * 60 * PX_PER_MIN;
    const nowMin = minutesOfDay();
    setHtml(body, html`
      ${narrow ? html`<div class="cal3-daystrip" role="tablist">${dateRange(from, addDays(from, 6)).map((d) => html`<button type="button" role="tab" class="cal3-daytab${d === data.today ? ' is-today' : ''}" aria-selected="${d === days[0] ? 'true' : 'false'}" data-cal-focus="${d}"><span>${fmtWeekday(d, 'narrow')}</span><strong>${fmtDate(d, { day: 'numeric' })}</strong></button>`)}</div>` : ''}
      <div class="cal3-week${narrow ? ' is-single' : ''}" style="--cols:${days.length}">
        <div class="cal3-head-spacer"></div>
        ${days.map((d) => html`<div class="cal3-head${d === data.today ? ' is-today' : ''}"><span>${fmtWeekday(d)}</span><strong>${fmtDate(d, { day: 'numeric' })}</strong></div>`)}
        <div class="cal3-allday-label">${t('calendar3.allDay')}</div>
        ${days.map((d) => html`<div class="cal3-allday">${evs.filter((e) => e.date === d && e.allDay).map(chip)}</div>`)}
        <div class="cal3-hours" style="height:${height}px">${Array.from({ length: endH - startH }, (_, i) => html`<span style="top:${i * 60 * PX_PER_MIN}px">${fmtClock((startH + i) * 60)}</span>`)}</div>
        ${days.map((d) => {
          const laid = layoutDay(evs.filter((e) => e.date === d));
          return html`<div class="cal3-col${d === data.today ? ' is-today' : ''}" data-col-date="${d}" style="height:${height}px">
            ${Array.from({ length: endH - startH }, (_, i) => html`<span class="cal3-line" style="top:${i * 60 * PX_PER_MIN}px"></span>`)}
            ${d === data.today && nowMin >= minStart && nowMin <= endH * 60 ? html`<span class="cal3-now" style="top:${(nowMin - minStart) * PX_PER_MIN}px" aria-hidden="true"></span>` : ''}
            ${laid.map((ev) => {
              const draggable = ev.kind === 'study' && !ev.completed && ev.date >= data.today;
              const top = (ev.start - minStart) * PX_PER_MIN;
              const h2 = Math.max(18, (ev.end - ev.start) * PX_PER_MIN - 2);
              return html`<div class="cal3-ev cal3-ev--${ev.kind}${h2 < 34 ? ' is-short' : ''}${ev.completed ? ' is-done' : ''}${ev.missed ? ' is-missed' : ''}${draggable ? ' is-draggable' : ''}" role="button" tabindex="0"
                data-event="${ev.id}" ${draggable ? raw('data-draggable="1"') : ''}
                style="top:${top}px;height:${h2}px;left:calc(${(ev.col / ev.cols) * 100}% + 2px);width:calc(${100 / ev.cols}% - 4px);--c:${safeColor(ev.color, '')}"
                aria-label="${escapeHtml(`${t(KIND_LABEL[ev.kind])}: ${ev.title}, ${fmtClock(ev.start)}–${fmtClock(ev.end)}${ev.locked ? `, ${t('workload.pinned')}` : ''}`)}">
                <span class="cal3-ev-title">${ev.locked ? raw(icon('lock')) : ''}${ev.title}</span>
                <span class="cal3-ev-time">${fmtClock(ev.start)}–${fmtClock(ev.end)}</span>
                ${draggable ? html`<span class="cal3-resize" data-resize="1" aria-hidden="true"></span>` : ''}
              </div>`;
            })}
          </div>`;
        })}
      </div>
      <p class="small muted cal3-hint">${t('calendar3.dragHint')}</p>`);
    body.dataset.minStart = String(minStart);
  }

  // ---------------- Agenda ----------------
  function drawAgenda(body) {
    const evs = visibleEvents();
    const { from, to } = range();
    const days = dateRange(from, to).filter((d) => evs.some((e) => e.date === d));
    if (!days.length) {
      setHtml(body, html`<div class="card">${emptyState({ iconName: 'calendar', title: t('calendar3.agendaEmpty'), body: t('calendar3.agendaEmptyBody'), compact: true })}</div>`);
      return;
    }
    setHtml(body, html`<div class="cal3-agenda">${days.map((d) => html`<section class="cal3-aday${d === data.today ? ' is-today' : ''}">
      <h3 class="cal3-aday-title"><span>${fmtDateLong(d)}</span>${d === data.today ? html`<span class="badge badge--now">${t('time.today')}</span>` : ''}</h3>
      <div class="card card-flush"><div class="list">${evs.filter((e) => e.date === d).map((ev) => html`<button type="button" class="list-row cal3-arow" data-event="${ev.id}" style="--c:${safeColor(ev.color, '')}">
        <span class="cal3-atime tabular">${ev.allDay ? t('calendar3.allDay') : `${fmtClock(ev.start)}–${fmtClock(ev.end)}`}</span>
        <span class="cal3-akind cal3-akind--${ev.kind}" aria-hidden="true"></span>
        <span class="list-row-main"><span class="list-row-title${ev.completed ? ' is-strike' : ''}">${ev.title}</span><span class="list-row-meta">${t(KIND_LABEL[ev.kind])}${ev.locked ? ` · ${t('workload.pinned')}` : ''}</span></span>
      </button>`)}</div></div>
    </section>`)}</div>`);
  }

  function drawBody() {
    const body = root.querySelector('#cal3Body');
    if (!body || !data) return;
    if (mode === 'month') drawMonth(body);
    else if (mode === 'week') drawWeek(body);
    else drawAgenda(body);
  }

  // ---------------- edit drawer (keyboard / touch fallback) ----------------
  function eventById(id) {
    return data.events.find((e) => e.id === id);
  }

  function openEvent(ev) {
    if (ev.kind === 'deadline') {
      const g = data.groups.find((x) => x.id === ev.taskId);
      if (g) openTaskEditor({ task: g, onSaved: () => { data = null; render(); } });
      return;
    }
    if (ev.kind === 'exam') {
      app().navigate('examsView', ev.examId);
      return;
    }
    if (ev.kind !== 'study') {
      openDrawer({
        title: ev.title,
        subtitle: `${t(KIND_LABEL[ev.kind])} · ${fmtDateLong(ev.date)} · ${fmtClock(ev.start)}–${fmtClock(ev.end)}`,
        size: 'narrow',
        render: (b) => b.appendChild(h('p', { class: 'muted small' }, ev.kind === 'external' ? t('calendar3.externalHint') : t('calendar3.classHint'))),
        actions: [
          ...(ev.courseId ? [{ label: t('calendar3.openCourse'), variant: 'secondary', onClick: (api) => { api.close(true); app().openCourse(ev.courseId); } }] : []),
          { label: t('workload.openPlanner'), variant: 'primary', onClick: (api) => { api.close(true); app().openPlannerForDate(ev.date); } },
        ],
      });
      return;
    }
    const editable = !ev.completed && ev.date >= data.today;
    openDrawer({
      title: ev.title,
      subtitle: `${fmtDateLong(ev.date)} · ${fmtClock(ev.start)}–${fmtClock(ev.end)}`,
      size: 'narrow',
      render: (b) => {
        if (!editable) {
          b.appendChild(h('p', { class: 'muted small' }, ev.completed ? t('calendar3.doneNoEdit') : t('calendar3.pastNoEdit')));
          return;
        }
        const pad = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        b.appendChild(h('div', { class: 'field' }, h('label', { for: 'cal-date' }, t('common.date')), h('input', { type: 'date', id: 'cal-date', value: ev.date, min: data.today })));
        const g = h('div', { class: 'field-grid' });
        g.appendChild(h('div', { class: 'field' }, h('label', { for: 'cal-start' }, t('courses.startTime')), h('input', { type: 'time', id: 'cal-start', value: pad(ev.start), step: '300' })));
        g.appendChild(h('div', { class: 'field' }, h('label', { for: 'cal-dur' }, t('manualEdit.durationLabel')), h('input', { type: 'number', id: 'cal-dur', min: '10', max: '600', step: '5', value: String(ev.end - ev.start) })));
        b.appendChild(g);
        const lock = h('input', { type: 'checkbox', id: 'cal-lock' });
        lock.checked = Boolean(ev.locked);
        b.appendChild(h('div', { class: 'field-check' }, lock, h('label', { for: 'cal-lock' }, t('calendar3.pinned'))));
        b.appendChild(h('p', { class: 'field-hint' }, t('calendar3.pinnedHint')));
        b.appendChild(h('p', { class: 'field-error', id: 'cal-error', role: 'alert' }));
      },
      actions: [
        { label: t('workload.openPlanner'), variant: 'secondary', start: true, onClick: (api) => { api.close(true); app().openPlannerForDate(ev.date); } },
        ...(editable ? [{
          label: t('common.save'), variant: 'primary',
          onClick: async (api) => {
            const b = api.body;
            const date = b.querySelector('#cal-date').value;
            const start = clockToMinutes(b.querySelector('#cal-start').value);
            const dur = Number(b.querySelector('#cal-dur').value);
            const lock = b.querySelector('#cal-lock').checked;
            const err = b.querySelector('#cal-error');
            if (!date || start === null || !Number.isFinite(dur)) {
              err.textContent = t('errors.invalidTime');
              return;
            }
            const moved = date !== ev.date || start !== ev.start || dur !== ev.end - ev.start;
            api.setBusy(true);
            try {
              if (moved) {
                const reason = await saveBlock(ev, date, start, start + Math.round(dur));
                if (reason) {
                  err.textContent = reason;
                  api.setBusy(false);
                  return;
                }
              } else if (lock !== Boolean(ev.locked)) {
                await setScheduleItemLocked(ev.itemId, lock);
                afterWrite();
              }
              if (moved && !lock) {
                await setScheduleItemLocked(ev.itemId, false);
                afterWrite();
              }
              api.close(true);
              toast(t('common.savedShort'), { kind: 'success' });
            } catch (e) {
              console.error(e);
              err.textContent = t('v3.saveError');
              api.setBusy(false);
            }
          },
        }] : []),
      ],
    });
  }

  function afterWrite() {
    invalidate('schedules');
    invalidate('tasks');
    app().refreshPlanner();
    data = null;
    render();
  }

  // Validates and saves a new position for a study block. Returns an error
  // message (string) when refused, or null on success.
  async function saveBlock(ev, date, start, end) {
    const sched = data.scheduleByDate.get(date) || null;
    const others = data.events.filter((o) => o.date === date && o.id !== ev.id && !o.allDay);
    const meals = sched ? data.planned.items.filter((i) => i.schedule_id === sched.id && i.item_type === 'meal').map((m) => ({ title: m.name, start: m.start_minutes, end: m.end_minutes })) : mealIntervals(null).map((m) => ({ ...m, title: t('legend.meal') }));
    const reason = validateDrop({ date, start, end, today: data.today, window: dayWindow(sched), others: [...others, ...meals], dueDate: ev.sourceSubjectId ? data.dueBySubject[ev.sourceSubjectId] : null });
    if (reason) {
      let text = t(reason.key);
      Object.entries(reason.params || {}).forEach(([k, v]) => {
        const val = k === 'start' || k === 'end' ? fmtClock(v) : k === 'date' ? fmtDate(v) : v;
        text = text.split(`{${k}}`).join(val);
      });
      return text;
    }
    if (date === ev.date) {
      await updateScheduleItemTime(ev.itemId, start, end);
      if (!ev.locked) await setScheduleItemLocked(ev.itemId, true);
    } else {
      await applyRebalanceMoves(app().userId, [{ itemId: ev.itemId, name: ev.title, sourceSubjectId: ev.sourceSubjectId, fromDate: ev.date, fromStart: ev.start, fromEnd: ev.end, toDate: date, toStart: start, toEnd: end, minutes: end - start }], { allowLocked: true });
    }
    afterWrite();
    return null;
  }

  // ---------------- drag & resize (pointer events) ----------------
  let drag = null;
  root.addEventListener('pointerdown', (e) => {
    const evEl = e.target.closest('.cal3-ev[data-draggable]');
    if (!evEl || e.button !== 0) return;
    const ev = eventById(evEl.dataset.event);
    if (!ev) return;
    const col = evEl.closest('.cal3-col');
    const cols = [...root.querySelectorAll('.cal3-col')];
    drag = {
      ev, evEl, resize: Boolean(e.target.closest('[data-resize]')), x0: e.clientX, y0: e.clientY, moved: false,
      colIndex: cols.indexOf(col), cols, colWidth: col.getBoundingClientRect().width,
    };
    try { evEl.setPointerCapture(e.pointerId); } catch { /* synthetic or cancelled pointer */ }
  });
  root.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    drag.evEl.classList.add('is-dragging');
    const dMin = Math.round(dy / PX_PER_MIN / SNAP) * SNAP;
    if (drag.resize) {
      const dur = Math.max(15, drag.ev.end - drag.ev.start + dMin);
      drag.evEl.style.height = `${dur * PX_PER_MIN - 2}px`;
      drag.result = { date: drag.ev.date, start: drag.ev.start, end: drag.ev.start + dur };
    } else {
      const dCol = Math.max(-drag.colIndex, Math.min(drag.cols.length - 1 - drag.colIndex, Math.round(dx / drag.colWidth)));
      drag.evEl.style.transform = `translate(${dCol * drag.colWidth}px, ${dMin * PX_PER_MIN}px)`;
      const date = drag.cols[drag.colIndex + dCol].dataset.colDate;
      drag.result = { date, start: drag.ev.start + dMin, end: drag.ev.end + dMin };
    }
    const label = drag.evEl.querySelector('.cal3-ev-time');
    if (label && drag.result) label.textContent = `${fmtClock(drag.result.start)}–${fmtClock(drag.result.end)}`;
  });
  const endDrag = async () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.moved) {
      openEvent(d.ev);
      return;
    }
    if (!d.result || (d.result.date === d.ev.date && d.result.start === d.ev.start && d.result.end === d.ev.end)) {
      drawBody();
      return;
    }
    try {
      const reason = await saveBlock(d.ev, d.result.date, d.result.start, d.result.end);
      if (reason) {
        toast(reason, { kind: 'error' });
        drawBody();
      } else {
        toast(t('calendar3.movedPinned'), { kind: 'success' });
      }
    } catch (err) {
      console.error('Could not move block', err);
      toast(err && err.code === 'stale' ? t('rebalance.stale') : t('rebalance.failed'), { kind: 'error' });
      data = null;
      render();
    }
  };
  root.addEventListener('pointerup', endDrag);
  root.addEventListener('pointercancel', () => { drag = null; drawBody(); });

  root.addEventListener('click', (e) => {
    if (e.target.closest('.cal3-ev[data-draggable]')) return; // handled by pointer events
    const nav = e.target.closest('[data-cal]');
    if (nav) {
      const step = nav.dataset.cal;
      if (step === 'today') { anchor = todayStr(); focusDay = anchor; } else {
        const dir = step === 'next' ? 1 : -1;
        anchor = mode === 'month' ? addMonths(firstOfMonth(anchor), dir) : addDays(startOfWeek(anchor), dir * (mode === 'agenda' ? 14 : 7));
        focusDay = startOfWeek(anchor);
      }
      data = null;
      render();
      return;
    }
    const kindBtn = e.target.closest('[data-kind]');
    if (kindBtn) {
      const k = kindBtn.dataset.kind;
      kinds = kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k];
      kindBtn.setAttribute('aria-pressed', kinds.includes(k) ? 'true' : 'false');
      savePrefs();
      drawBody();
      return;
    }
    const dayBtn = e.target.closest('[data-cal-day]');
    if (dayBtn) {
      anchor = dayBtn.dataset.calDay;
      focusDay = anchor;
      mode = 'week';
      savePrefs();
      data = null;
      render();
      return;
    }
    const focusBtn = e.target.closest('[data-cal-focus]');
    if (focusBtn) {
      focusDay = focusBtn.dataset.calFocus;
      drawBody();
      return;
    }
    const evBtn = e.target.closest('[data-event]');
    if (evBtn) {
      const ev = eventById(evBtn.dataset.event);
      if (ev) openEvent(ev);
      return;
    }
    if (e.target.closest('[data-action="cal-retry"]')) render();
  });
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const evEl = e.target.closest('.cal3-ev');
    if (!evEl) return;
    e.preventDefault();
    const ev = eventById(evEl.dataset.event);
    if (ev) openEvent(ev);
  });

  onChange((topic) => {
    if (!view.hidden && ['tasks', 'exams', 'classes', 'courses'].includes(topic)) { data = null; render(); }
  });

  return {
    onShow() {
      data = null;
      return render();
    },
  };
}

