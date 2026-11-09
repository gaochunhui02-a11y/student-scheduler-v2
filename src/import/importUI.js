// Syllabus import (V5-C): paste text, or choose a CSV / .ics file → an
// editable review table → Import. Nothing is saved before Import; rows with
// anything uncertain are marked "Needs confirmation" and block the import
// until the student fixes the field or presses "Looks right"; duplicates
// are unticked. Afterwards, "Plan these now" opens the smart planner.

import { t } from '../shared/i18n.js';
import { h } from '../ui/dom.js';
import { openDrawer } from '../ui/drawer.js';
import { toast } from '../ui/toast.js';
import { app } from '../app/context.js';
import { has } from '../shared/capabilities.js';
import { todayStr, addDays } from '../shared/dates.js';
import { fmtWeekday } from '../ui/format.js';
import { listCourses } from '../academics/academicsData.js';
import { parseIcsCalendar } from '../calendar/calendarModel.js';
import { parseSyllabus, ITEM_KINDS } from './syllabusParser.js';
import { parseCsv, guessColumns, rowsFromCsv, rowsFromIcsEvents, markDuplicates, markPast, editRow, confirmRow, rowProblem, reviewSummary, buildImportPlan } from './importModel.js';
import { existingForCourse, currentTerm, applyImport } from './importData.js';

const MAX_FILE = 2 * 1024 * 1024;

function fill(key, params = {}) {
  let text = t(key);
  Object.entries(params).forEach(([k, v]) => { text = text.split(`{${k}}`).join(String(v)); });
  return text;
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) { reject(new Error('no_file')); return; }
    if (file.size > MAX_FILE) { reject(Object.assign(new Error('too_big'), { code: 'too_big' })); return; }
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

/**
 * @param {{ courseId?: string|null, onDone?: Function }} [opts]
 */
export async function openImport({ courseId = null, onDone } = {}) {
  const ctx = app();
  const today = todayStr();
  const [courses, term] = await Promise.all([
    has('courses') ? listCourses(ctx.userId).catch(() => []) : [],
    currentTerm(ctx.userId).catch(() => null),
  ]);
  const state = {
    source: 'paste',
    text: '',
    csv: null,
    columns: {},
    icsEvents: null,
    courseId: courseId || '',
    newCourse: { name: '', code: '' },
    termStart: term ? term.start : '',
    dateOrder: '',
    rows: [],
    meetings: [],
    meetingRange: { start: term ? (term.start > today ? term.start : today) : '', end: term ? term.end : '' },
    error: '',
  };

  const api = openDrawer({
    title: t('import.title'),
    subtitle: t('import.sub'),
    size: 'wide',
    render: () => {},
    actions: [],
  });

  // ---------------- step 1: source ----------------
  function paintSource() {
    const body = api.body;
    body.innerHTML = '';
    const courseSel = h('select', { id: 'impCourse', class: 'v3-input' });
    courseSel.appendChild(h('option', { value: '' }, t('import.courseNew')));
    courses.forEach((c) => {
      const o = h('option', { value: c.id }, c.code ? `${c.code} — ${c.name}` : c.name);
      if (c.id === state.courseId) o.selected = true;
      courseSel.appendChild(o);
    });
    courseSel.addEventListener('change', () => { state.courseId = courseSel.value; });
    if (has('courses')) body.appendChild(h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'impCourse' }, t('import.courseLabel')), courseSel));

    const seg = h('div', { class: 'seg imp-source', role: 'group', 'aria-label': t('import.sourceLabel') });
    [['paste', 'import.srcPaste'], ['csv', 'import.srcCsv'], ['ics', 'import.srcIcs']].forEach(([key, label]) => {
      const b = h('button', { type: 'button', 'data-src': key, 'aria-pressed': state.source === key ? 'true' : 'false' }, t(label));
      b.addEventListener('click', () => { state.source = key; state.error = ''; paintSource(); body.querySelector(`[data-src="${key}"]`)?.focus(); });
      seg.appendChild(b);
    });
    body.appendChild(seg);

    if (state.source === 'paste') {
      const ta = h('textarea', { id: 'impText', class: 'v3-input imp-text', rows: '10', maxlength: '200000', placeholder: t('import.pastePlaceholder'), 'aria-describedby': 'impPasteHint' });
      ta.value = state.text;
      ta.addEventListener('input', () => { state.text = ta.value; });
      body.appendChild(h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'impText' }, t('import.pasteLabel')), ta,
        h('p', { class: 'hint', id: 'impPasteHint' }, t('import.pasteHint'))));
    } else {
      const input = h('input', { type: 'file', id: 'impFile', accept: state.source === 'csv' ? '.csv,text/csv,.tsv,text/tab-separated-values' : '.ics,text/calendar' });
      input.addEventListener('change', async () => {
        state.error = '';
        try {
          const text = await readFile(input.files[0]);
          if (state.source === 'csv') {
            state.csv = parseCsv(text);
            state.columns = guessColumns(state.csv.header);
            if (!state.csv.rows.length) state.error = t('import.errEmpty');
          } else {
            const res = parseIcsCalendar(text);
            if (!res.valid) { state.icsEvents = null; state.error = t('import.errIcs'); } else state.icsEvents = res.events;
          }
        } catch (err) {
          state.error = err.code === 'too_big' ? t('import.errTooBig') : t('import.errRead');
        }
        paintSource();
      });
      body.appendChild(h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'impFile' }, state.source === 'csv' ? t('import.csvLabel') : t('import.icsLabel')), input,
        h('p', { class: 'hint' }, state.source === 'csv' ? t('import.csvHint') : t('import.icsHint'))));
      if (state.source === 'csv' && state.csv && state.csv.header.length) {
        const map = h('div', { class: 'imp-map' });
        [['title', true], ['date', true], ['kind', false], ['minutes', false], ['time', false]].forEach(([field, required]) => {
          const id = `impCol-${field}`;
          const sel = h('select', { id, class: 'v3-input' });
          sel.appendChild(h('option', { value: '' }, required ? t('import.colChoose') : t('import.colNone')));
          state.csv.header.forEach((name, i) => {
            const o = h('option', { value: String(i) }, name || fill('import.colN', { n: i + 1 }));
            if (state.columns[field] === i) o.selected = true;
            sel.appendChild(o);
          });
          sel.addEventListener('change', () => { state.columns[field] = sel.value === '' ? undefined : Number(sel.value); });
          map.appendChild(h('div', { class: 'field' }, h('label', { class: 'field-label', for: id }, t(`import.col_${field}`)), sel));
        });
        body.appendChild(h('p', { class: 'field-label' }, fill('import.csvFound', { n: state.csv.rows.length })));
        body.appendChild(map);
      }
      if (state.source === 'ics' && state.icsEvents) body.appendChild(h('p', { class: 'hint' }, fill('import.icsFound', { n: state.icsEvents.length })));
    }

    // Context that makes dates certain.
    const termIn = h('input', { type: 'date', id: 'impTerm', class: 'v3-input', value: state.termStart });
    termIn.addEventListener('change', () => { state.termStart = termIn.value; });
    const orderSel = h('select', { id: 'impOrder', class: 'v3-input' });
    [['', 'import.orderUnsure'], ['mdy', 'import.orderMdy'], ['dmy', 'import.orderDmy']].forEach(([v, k]) => {
      const o = h('option', { value: v }, t(k));
      if (state.dateOrder === v) o.selected = true;
      orderSel.appendChild(o);
    });
    orderSel.addEventListener('change', () => { state.dateOrder = orderSel.value; });
    body.appendChild(h('div', { class: 'imp-context' },
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'impTerm' }, t('import.termStart')), termIn, h('p', { class: 'hint' }, t('import.termHint'))),
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'impOrder' }, t('import.orderLabel')), orderSel)));
    body.appendChild(h('p', { class: 'hint imp-pdf' }, t('import.pdfNote')));
    if (state.error) body.appendChild(h('p', { class: 'field-error', role: 'alert' }, state.error));

    api.setActions([
      { label: t('common.cancel'), onClick: (b) => b.close() },
      { label: t('import.readIt'), variant: 'primary', onClick: () => read() },
    ]);
  }

  async function read() {
    const ctxDates = { today, termStart: state.termStart || null, dateOrder: state.dateOrder || null };
    let rows = [];
    let meetings = [];
    if (state.source === 'paste') {
      if (!state.text.trim()) { state.error = t('import.errEmpty'); paintSource(); return; }
      const parsed = parseSyllabus(state.text, ctxDates);
      rows = parsed.items;
      meetings = parsed.meetings;
      if (!state.courseId && (parsed.course.name || parsed.course.code)) state.newCourse = { name: parsed.course.name || parsed.course.code, code: parsed.course.code || '' };
    } else if (state.source === 'csv') {
      if (!state.csv) { state.error = t('import.errNoFile'); paintSource(); return; }
      if (state.columns.title === undefined || state.columns.date === undefined) { state.error = t('import.errColumns'); paintSource(); return; }
      rows = rowsFromCsv(state.csv, state.columns, ctxDates);
    } else {
      if (!state.icsEvents) { state.error = t('import.errNoFile'); paintSource(); return; }
      rows = rowsFromIcsEvents(state.icsEvents);
    }
    if (!rows.length && !meetings.length) { state.error = t('import.errNothing'); paintSource(); return; }
    const existing = await existingForCourse(ctx.userId, state.courseId || null).catch(() => []);
    state.rows = markDuplicates(markPast(rows, today), existing);
    state.meetings = meetings;
    state.error = '';
    paintReview();
  }

  // ---------------- step 2: review ----------------
  const FLAG_KEY = { order: 'import.flagOrder', year: 'import.flagYear', multiDate: 'import.flagMulti', title: 'import.flagTitle', kind: 'import.flagKind', date: 'import.flagDate' };

  function statusCell(r) {
    const cell = h('div', { class: 'imp-status' });
    if (r.duplicate) cell.appendChild(h('span', { class: 'badge badge--outline' }, r.duplicate === 'saved' ? t('import.dupSaved') : t('import.dupFile')));
    if (r.past && !r.duplicate) cell.appendChild(h('span', { class: 'badge badge--outline' }, t('import.past')));
    if (r.include && r.flags.length) {
      cell.appendChild(h('span', { class: 'badge badge--warning' }, t('import.needsConfirm')));
      cell.appendChild(h('span', { class: 'imp-flag' }, r.flags.map((f) => t(FLAG_KEY[f] || 'import.flagDate')).join(' ')));
      const ok = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-confirm': r.id }, t('import.looksRight'));
      cell.appendChild(ok);
    } else if (r.include) {
      const p = rowProblem(r);
      if (p) cell.appendChild(h('span', { class: 'badge badge--danger' }, t(`import.problem_${p}`)));
    }
    return cell;
  }

  function rowEl(r) {
    const tr = h('li', { class: `imp-row${r.include ? '' : ' is-off'}${r.include && rowProblem(r) ? ' is-blocked' : ''}`, 'data-row': r.id });
    const cb = h('input', { type: 'checkbox', 'aria-label': fill('import.includeRow', { title: r.title || r.source }) });
    cb.checked = r.include;
    cb.addEventListener('change', () => update(r.id, (x) => ({ ...x, include: cb.checked })));
    const kind = h('select', { class: 'v3-input imp-kind', 'aria-label': t('import.colType') });
    ITEM_KINDS.forEach((k) => {
      const o = h('option', { value: k }, t(`import.kind_${k}`));
      if (k === r.kind) o.selected = true;
      kind.appendChild(o);
    });
    kind.addEventListener('change', () => update(r.id, (x) => editRow(x, 'kind', kind.value)));
    const title = h('input', { type: 'text', class: 'v3-input imp-title', maxlength: '120', value: r.title, 'aria-label': t('import.colTitle'), placeholder: t('import.titlePlaceholder') });
    title.addEventListener('change', () => update(r.id, (x) => editRow(x, 'title', title.value)));
    const date = h('input', { type: 'date', class: 'v3-input imp-date', value: r.date || '', 'aria-label': t('import.colDate') });
    date.addEventListener('change', () => update(r.id, (x) => editRow(x, 'date', date.value)));
    const time = h('input', { type: 'time', class: 'v3-input imp-time', value: r.time || '', 'aria-label': t('import.colTime') });
    time.addEventListener('change', () => update(r.id, (x) => ({ ...x, time: time.value || null })));
    const needsMinutes = ['assignment', 'project', 'reading', 'other'].includes(r.kind);
    const minutes = h('input', { type: 'number', class: 'v3-input imp-min', min: '5', max: '1440', step: '5', value: needsMinutes ? String(r.minutes || '') : '', disabled: needsMinutes ? null : '', 'aria-label': t('import.colMinutes') });
    minutes.addEventListener('change', () => update(r.id, (x) => ({ ...x, minutes: Number(minutes.value) })));
    const lab = (el, key) => {
      const id = `${el.className.split(' ').pop()}-${r.id}`;
      el.id = id;
      el.removeAttribute('aria-label');
      return h('span', { class: 'imp-field' }, h('label', { for: id }, t(key)), el);
    };
    const when = h('div', { class: 'imp-when' }, lab(date, 'import.colDate'), lab(time, 'import.colTime'), needsMinutes ? lab(minutes, 'import.colMinutes') : null);
    tr.append(cb, kind, title, when, statusCell(r),
      h('p', { class: 'imp-source-line', title: r.source }, fill('import.fromLine', { n: r.lineNo, text: r.source })));
    if (r.include && r.flags.length) {
      const map = { order: date, year: date, multiDate: date, date, title, kind };
      r.flags.forEach((f) => map[f] && map[f].setAttribute('aria-invalid', 'true'));
    }
    return tr;
  }

  function update(id, fn) {
    const i = state.rows.findIndex((x) => x.id === id);
    if (i < 0) return;
    state.rows[i] = fn(state.rows[i]);
    const old = api.body.querySelector(`[data-row="${id}"]`);
    const active = document.activeElement;
    const activeClass = active && old && old.contains(active) ? [...active.classList].find((c) => c.startsWith('imp-')) || (active.type === 'checkbox' ? 'cb' : null) : null;
    if (old) {
      const next = rowEl(state.rows[i]);
      old.replaceWith(next);
      if (activeClass) (activeClass === 'cb' ? next.querySelector('input[type="checkbox"]') : next.querySelector(`.${activeClass}`))?.focus();
    }
    paintSummary();
  }

  function paintSummary() {
    const s = reviewSummary(state.rows);
    const box = api.body.querySelector('.imp-summary');
    if (box) {
      box.textContent = fill(state.rows.length === 1 ? 'import.summaryOne' : 'import.summary', { n: state.rows.length, m: state.meetings.length })
        + (s.blocked ? ` ${fill('import.summaryBlocked', { n: s.blocked })}` : '')
        + (s.duplicates ? ` ${fill('import.summaryDup', { n: s.duplicates })}` : '');
    }
    const meetingsOk = !state.meetings.some((m) => m.include) || (state.meetingRange.start && state.meetingRange.end && state.meetingRange.end >= state.meetingRange.start);
    const courseOk = !has('courses') || state.courseId || state.newCourse.name.trim();
    const anything = s.ticked > 0 || state.meetings.some((m) => m.include);
    const ok = anything && s.blocked === 0 && meetingsOk && courseOk;
    api.setActions([
      { label: t('import.back'), onClick: () => paintSource() },
      { label: ok ? fill('import.importN', { n: s.ready + state.meetings.filter((m) => m.include).length }) : s.blocked ? fill('import.confirmFirst', { n: s.blocked }) : !courseOk ? t('import.needCourse') : !meetingsOk ? t('import.needRange') : t('import.nothingTicked'), variant: 'primary', onClick: (b) => (ok ? save(b) : null) },
    ]);
    if (!ok) api.panel.querySelector('.drawer-foot .btn--primary')?.setAttribute('disabled', '');
  }

  function paintReview() {
    const body = api.body;
    body.innerHTML = '';
    body.appendChild(h('p', { class: 'imp-summary', role: 'status' }));
    if (has('courses') && !state.courseId) {
      const name = h('input', { type: 'text', id: 'impNewName', class: 'v3-input', maxlength: '120', value: state.newCourse.name });
      const code = h('input', { type: 'text', id: 'impNewCode', class: 'v3-input', maxlength: '32', value: state.newCourse.code });
      name.addEventListener('input', () => { state.newCourse.name = name.value; paintSummary(); });
      code.addEventListener('input', () => { state.newCourse.code = code.value; });
      body.appendChild(h('div', { class: 'imp-newcourse' },
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'impNewName' }, t('import.newCourseName')), name),
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'impNewCode' }, t('import.newCourseCode')), code)));
    }
    if (state.rows.length) {
      const list = h('ul', { class: 'imp-rows', 'aria-label': t('import.rowsLabel') });
      state.rows.forEach((r) => list.appendChild(rowEl(r)));
      body.appendChild(list);
    }
    if (state.meetings.length) {
      body.appendChild(h('h3', { class: 'imp-subhead' }, t('import.meetingsTitle')));
      const ml = h('ul', { class: 'imp-meetings' });
      state.meetings.forEach((m) => {
        const cb = h('input', { type: 'checkbox', id: `impM-${m.id}` });
        cb.checked = m.include;
        cb.addEventListener('change', () => { m.include = cb.checked; paintSummary(); });
        const days = m.days.map((d) => fmtWeekday(addDays('2026-11-01', d))).join(', '); // 2026-11-01 is a Sunday
        ml.appendChild(h('li', { class: 'imp-meeting' }, cb,
          h('label', { for: `impM-${m.id}` }, h('strong', {}, t(`import.meeting_${m.label}`)), ` · ${days} · ${m.start}–${m.end}${m.location ? ` · ${m.location}` : ''}`)));
      });
      body.appendChild(ml);
      const from = h('input', { type: 'date', id: 'impMFrom', class: 'v3-input', value: state.meetingRange.start });
      const to = h('input', { type: 'date', id: 'impMTo', class: 'v3-input', value: state.meetingRange.end });
      from.addEventListener('change', () => { state.meetingRange.start = from.value; paintSummary(); });
      to.addEventListener('change', () => { state.meetingRange.end = to.value; paintSummary(); });
      body.appendChild(h('div', { class: 'imp-range' },
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'impMFrom' }, t('import.repeatsFrom')), from),
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'impMTo' }, t('import.repeatsTo')), to)));
    }
    body.appendChild(h('p', { class: 'hint' }, t('import.reviewNote')));
    body.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-confirm]');
      if (btn) update(btn.dataset.confirm, (x) => confirmRow(x));
    });
    paintSummary();
    body.querySelector('.imp-row.is-blocked select, .imp-row.is-blocked input:not([type="checkbox"])')?.focus();
  }

  async function save(b) {
    b.setBusy(true);
    const plan = buildImportPlan(state.rows, state.meetings);
    const label = state.courseId ? '' : (state.newCourse.code || state.newCourse.name).trim();
    plan.meetings = plan.meetings.map((m) => ({ ...m, name: `${label || t('import.meetingClass')} ${t(`import.meeting_${m.label}`)}`.trim() }));
    let res;
    try {
      res = await applyImport(ctx.userId, {
        courseId: state.courseId || null,
        newCourse: state.courseId ? null : state.newCourse,
        plan,
        meetingRange: plan.meetings.length ? state.meetingRange : null,
        semesterId: term ? term.id : null,
      });
    } catch (err) {
      console.error('Import failed', err);
      b.setBusy(false);
      toast(t('v3.saveError'), { kind: 'error' });
      return;
    }
    const body = api.body;
    body.innerHTML = '';
    body.appendChild(h('div', { class: 'imp-done', role: 'status' },
      h('p', { class: 'imp-done-title' }, fill('import.doneTitle', { tasks: res.tasks, exams: res.exams, meetings: res.meetings })),
      res.failed.length ? h('p', { class: 'field-error' }, fill('import.doneFailed', { names: res.failed.join(', ') })) : null,
      h('p', { class: 'hint' }, t('import.doneNext'))));
    api.setActions([
      { label: t('common.close'), onClick: (x) => x.close(true) },
      ...(res.courseId ? [{ label: t('import.openCourse'), onClick: (x) => { x.close(true); ctx.openCourse(res.courseId); } }] : []),
      ...(res.tasks ? [{
        label: t('smart.openButton'),
        variant: 'primary',
        onClick: async (x) => {
          x.close(true);
          const [{ loadToday }, { openSmartPlan }] = await Promise.all([import('../today/todayData.js'), import('../planner/smartPlanUI.js')]);
          const d = await loadToday();
          openSmartPlan(d.groups, { mode: 'all' });
        },
      }] : []),
    ]);
    if (onDone) onDone(res);
  }

  paintSource();
}
