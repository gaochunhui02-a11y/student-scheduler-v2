// Grades UI (V3-C): the Grades tab inside each course, the cross-course
// Grades page, the "What score do I need?" calculator, and the small grade
// badge / overview card other pages show. All numbers come from
// gradeModel.js — this file only formats them.

import { t, tMessage } from '../shared/i18n.js';
import { has } from '../shared/capabilities.js';
import { app, onChange } from '../app/context.js';
import { html, raw, setHtml, on, safeColor, escapeHtml } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { pageHead, emptyState, button, badge, skeletonRows, migrationNotice, errorNotice } from '../ui/components.js';
import { fmtPercent, fmtDate, fmtNumber } from '../ui/format.js';
import { toast } from '../ui/toast.js';
import { listCourses } from '../academics/academicsData.js';
import { sortCourses } from '../academics/courseModel.js';
import { computeCourseGrade, requiredOnRemaining, requiredOnItem, requiredFinalSimple, itemShare, gradeStatus, CATEGORY_PRESETS } from './gradeModel.js';
import { loadGradeData, createCategories } from './gradesData.js';
import { openCategoryEditor, openGradeItemEditor } from './gradeEditors.js';
import { openCourseEditor } from '../courses/courseEditor.js';
import { registerCourseTab, registerCourseCardProvider, registerCourseOverviewWidget } from '../courses/courseTabs.js';

const STATUS_BADGE = {
  on_track: ['grades.statusOnTrack', 'success'],
  secured: ['grades.statusSecured', 'success'],
  below_target: ['grades.statusBelow', 'warning'],
  out_of_reach: ['grades.statusOutOfReach', 'danger'],
  no_target: ['grades.statusNoTarget', 'outline'],
  no_grades: ['grades.statusNoGrades', 'outline'],
};

function courseSummary(course, data) {
  const categories = data.categories.filter((c) => c.course_id === course.id);
  const items = data.items.filter((i) => i.course_id === course.id);
  return { categories, items, summary: computeCourseGrade({ categories, items }) };
}

function statusBadge(status) {
  const [key, kind] = STATUS_BADGE[status] || STATUS_BADGE.no_grades;
  return badge(t(key), kind);
}

// Text explaining a requiredOn* result in plain language.
export function requiredText(result, target, { scope = 'remaining' } = {}) {
  const item = scope === 'item';
  const tgt = fmtPercent(Number(target), 1);
  if (!result || result.status === 'no_data') return t('grades.reqNoData');
  if (result.status === 'complete') return result.met ? t('grades.reqCompleteMet').replace('{final}', fmtPercent(result.finalIfComplete, 1)).replace('{target}', tgt) : t('grades.reqCompleteMissed').replace('{final}', fmtPercent(result.finalIfComplete, 1)).replace('{target}', tgt);
  if (result.status === 'secured') return t('grades.reqSecured').replace('{target}', tgt);
  if (result.status === 'out_of_reach') return t(item ? 'grades.reqOutOfReachItem' : 'grades.reqOutOfReach').replace('{score}', fmtPercent(result.required, 1)).replace('{target}', tgt);
  return t(item ? 'grades.reqNeededItem' : 'grades.reqNeeded').replace('{score}', fmtPercent(result.required, 1)).replace('{target}', tgt);
}

function rangeBar(summary, target, color) {
  const min = Math.max(0, Math.min(100, summary.minFinal || 0));
  const max = Math.max(min, Math.min(100, summary.maxFinal || 0));
  const proj = summary.projected !== null ? Math.max(0, Math.min(100, summary.projected)) : null;
  const tgt = target !== null && target !== undefined && target !== '' ? Math.max(0, Math.min(100, Number(target))) : null;
  return html`<div class="grade-range" style="--c:${safeColor(color)}" aria-hidden="true">
    <div class="grade-range-track">
      <span class="grade-range-secured" style="width:${min}%"></span>
      <span class="grade-range-possible" style="left:${min}%;width:${max - min}%"></span>
      ${proj !== null ? html`<span class="grade-range-marker grade-range-projected" style="left:${proj}%"></span>` : ''}
      ${tgt !== null ? html`<span class="grade-range-marker grade-range-target" style="left:${tgt}%"></span>` : ''}
    </div>
    <div class="grade-range-scale"><span>0%</span><span>50%</span><span>100%</span></div>
  </div>`;
}

function summaryCards(course, summary) {
  const target = course.target_grade !== null && course.target_grade !== undefined ? Number(course.target_grade) : null;
  const req = target !== null ? requiredOnRemaining(summary, target) : null;
  const status = gradeStatus(summary, target);
  return html`<div class="grade-summary">
    <div class="grade-summary-main">
      <span class="stat-label">${t('grades.currentGrade')}</span>
      <span class="grade-big">${summary.current !== null ? fmtPercent(summary.current, 1) : '—'}</span>
      <span class="stat-sub">${summary.current !== null ? t('grades.currentExplain').replace('{pct}', fmtPercent(summary.completedShare * 100, 0)) : t('grades.noGradesYet')}</span>
      <span>${statusBadge(status)}</span>
    </div>
    <div class="grade-summary-range">
      <div class="row-between">
        <span class="stat-label">${t('grades.finalRange')}</span>
        <span class="small muted">${summary.minFinal !== null ? `${fmtPercent(summary.minFinal, 1)} – ${fmtPercent(summary.maxFinal, 1)}` : '—'}</span>
      </div>
      ${rangeBar(summary, target, course.color)}
      <div class="grade-range-legend">
        <span><i class="lg-secured"></i>${t('grades.legendSecured')}</span>
        <span><i class="lg-possible"></i>${t('grades.legendPossible')}</span>
        ${summary.projected !== null ? html`<span><i class="lg-projected"></i>${t('grades.legendProjected')} ${fmtPercent(summary.projected, 1)}</span>` : ''}
        ${target !== null ? html`<span><i class="lg-target"></i>${t('grades.legendTarget')} ${fmtPercent(target, 1)}</span>` : ''}
      </div>
      <p class="small muted" style="margin:0">${summary.projected !== null ? t('grades.projectedExplain').replace('{pct}', fmtPercent(summary.remainingShare * 100, 0)) : t('grades.projectedNone')}</p>
    </div>
    <div class="grade-summary-need">
      <span class="stat-label">${t('grades.toReachTarget')}</span>
      ${target === null
        ? html`<p class="small muted" style="margin:0">${t('grades.setTargetHint')}</p>${button(t('grades.setTarget'), { size: 'sm', action: 'edit-course-target' })}`
        : html`<span class="grade-need-figure ${req && req.status === 'out_of_reach' ? 'is-danger' : req && (req.status === 'secured' || (req.status === 'complete' && req.met)) ? 'is-success' : ''}">${req && req.required !== null && req.status !== 'secured' ? fmtPercent(req.required, 1) : req && req.status === 'secured' ? raw(icon('check')) : '—'}</span>
          <p class="small muted" style="margin:0">${requiredText(req, target)}</p>`}
    </div>
  </div>`;
}

function itemRow(item, summary) {
  const graded = item.earned_points !== null && item.earned_points !== undefined;
  const pct = graded ? (Number(item.earned_points) / Number(item.possible_points)) * 100 : null;
  const share = item.counts !== false && !graded ? itemShare(item, summary) : 0;
  return html`<button type="button" class="list-row grade-item-row${graded ? '' : ' is-pending'}" data-action="edit-item" data-id="${item.id}">
    <span class="list-row-main">
      <span class="list-row-title">${item.name}</span>
      <span class="list-row-meta">
        ${item.due_date ? html`<span>${fmtDate(item.due_date)}</span>` : ''}
        ${item.counts === false ? badge(t('grades.practiceTag'), 'outline') : ''}
        ${share > 0 ? html`<span>${t('grades.worthOfCourse').replace('{pct}', fmtPercent(share * 100, 1))}</span>` : ''}
      </span>
    </span>
    <span class="list-row-side grade-score">
      ${graded ? html`<span class="tabular">${fmtNumber(Number(item.earned_points), 2)} / ${fmtNumber(Number(item.possible_points), 2)}</span><strong class="tabular">${fmtPercent(pct, 1)}</strong>` : html`<span class="muted">${t('grades.notGradedYet')}</span>`}
    </span>
  </button>`;
}

function calculatorHtml(course, summary, items) {
  const pending = items.filter((i) => (i.earned_points === null || i.earned_points === undefined) && i.counts !== false);
  const target = course.target_grade !== null && course.target_grade !== undefined ? Number(course.target_grade) : 90;
  return html`<section class="card grade-calc" data-calc>
    <div class="card-head"><div><h2 class="card-title">${t('grades.calcTitle')}</h2><p class="card-sub">${t('grades.calcSub')}</p></div></div>
    <div class="stack-sm">
      <div class="field">
        <label for="calcItem">${t('grades.calcFor')}</label>
        <select id="calcItem">
          <option value="__all">${t('grades.calcAllRemaining')}</option>
          ${pending.map((i) => html`<option value="${i.id}">${i.name} · ${fmtPercent(itemShare(i, summary) * 100, 1)}</option>`)}
          <option value="__custom">${t('grades.calcCustom')}</option>
        </select>
      </div>
      <div class="field">
        <label for="calcTarget">${t('grades.calcTarget')}</label>
        <input type="number" id="calcTarget" min="0" max="100" step="0.5" inputmode="decimal" value="${target}">
      </div>
      <div class="field" id="calcCustomWrap" hidden>
        <label for="calcCustomWeight">${t('grades.calcCustomWeight')}</label>
        <input type="number" id="calcCustomWeight" min="1" max="100" step="0.5" inputmode="decimal" value="30">
      </div>
    </div>
    <div class="grade-calc-result" id="calcResult" aria-live="polite"></div>
  </section>`;
}

function wireCalculator(root, summary, items) {
  const card = root.querySelector('[data-calc]');
  if (!card) return;
  const sel = card.querySelector('#calcItem');
  const tgt = card.querySelector('#calcTarget');
  const customWrap = card.querySelector('#calcCustomWrap');
  const custom = card.querySelector('#calcCustomWeight');
  const out = card.querySelector('#calcResult');
  function update() {
    const target = Number(tgt.value);
    customWrap.hidden = sel.value !== '__custom';
    let result;
    let note = '';
    let scope = 'remaining';
    if (!Number.isFinite(target) || tgt.value === '') {
      out.innerHTML = '';
      return;
    }
    if (sel.value === '__all') {
      result = requiredOnRemaining(summary, target);
      if (result.status === 'needed' || result.status === 'out_of_reach') note = t('grades.calcNoteAll').replace('{pct}', fmtPercent(summary.remainingShare * 100, 0));
    } else if (sel.value === '__custom') {
      const w = Number(custom.value) / 100;
      scope = 'item';
      result = summary.current !== null
        ? requiredFinalSimple({ current: summary.current, target, finalWeight: Number(custom.value) })
        : requiredOnRemaining(summary, target);
      if (summary.current !== null && Number.isFinite(w)) note = t('grades.calcNoteCustom').replace('{current}', fmtPercent(summary.current, 1)).replace('{pct}', fmtPercent(100 - Number(custom.value), 0));
    } else {
      const item = items.find((i) => i.id === sel.value);
      result = requiredOnItem(summary, target, itemShare(item, summary));
      if (result.assumption !== 'uniform') scope = 'item';
      if (result.assumption === 'others_at_current') note = t('grades.calcNoteOthers').replace('{current}', fmtPercent(summary.current, 1));
      else if (result.assumption === 'uniform') note = t('grades.calcNoteUniform');
    }
    const kind = result.status === 'out_of_reach' ? 'danger' : result.status === 'secured' || (result.status === 'complete' && result.met) ? 'success' : 'accent';
    out.innerHTML = `<div class="grade-calc-answer grade-calc-answer--${kind}">${result.required !== null && result.status !== 'secured' ? `<span class="grade-calc-figure">${escapeHtml(fmtPercent(result.required, 1))}</span>` : ''}<span>${escapeHtml(requiredText(result, target, { scope }))}</span></div>${note ? `<p class="small muted" style="margin:var(--space-2) 0 0">${escapeHtml(note)}</p>` : ''}`;
  }
  [sel, tgt, custom].forEach((el) => el.addEventListener('input', update));
  sel.addEventListener('change', update);
  update();
}

// ---------------------------------------------------------------- course tab
async function renderCourseGrades(container, { course, refresh }) {
  if (!has('grades')) {
    setHtml(container, migrationNotice('grades'));
    return;
  }
  setHtml(container, skeletonRows(3, 120));
  let data;
  try {
    data = await loadGradeData(app().userId);
  } catch (err) {
    console.error('Could not load grades', err);
    setHtml(container, errorNotice('', { retryAction: 'retry-grades' }));
    container.querySelector('[data-action="retry-grades"]')?.addEventListener('click', () => renderCourseGrades(container, { course, refresh }));
    return;
  }
  const { categories, items, summary } = courseSummary(course, data);
  if (categories.length === 0 && items.length === 0) {
    setHtml(container, html`<section class="card">${emptyState({
      iconName: 'grade',
      title: t('grades.emptyCourseTitle'),
      body: t('grades.emptyCourseBody'),
      actions: [
        button(t('grades.usePreset'), { variant: 'primary', action: 'use-preset' }),
        button(t('grades.addCategory'), { action: 'add-category', iconName: 'plus' }),
        button(t('grades.addItemNoCategory'), { variant: 'ghost', action: 'add-item' }),
      ],
    })}<p class="small muted" style="text-align:center;margin:0 0 var(--space-4)">${t('grades.presetPreview')}</p></section>`);
  } else {
    const sections = [];
    const groups = categories.length ? categories.map((c) => ({ cat: c, items: items.filter((i) => i.category_id === c.id) })) : [{ cat: null, items }];
    const uncategorized = categories.length ? items.filter((i) => !i.category_id || !categories.some((c) => c.id === i.category_id)) : [];
    groups.forEach(({ cat, items: catItems }) => {
      const stats = summary.categories.find((s) => s.id === (cat ? cat.id : null));
      sections.push(html`<section class="grade-category">
        <header class="grade-category-head">
          <div>
            <h3 class="grade-category-name">${cat ? cat.name : t('grades.allItems')}</h3>
            <span class="small muted">${cat ? t('grades.weightOf').replace('{w}', fmtNumber(Number(cat.weight), 2)) : t('grades.pointsBased')} · ${t('grades.gradedOf').replace('{n}', String(stats ? stats.gradedCount : 0)).replace('{total}', String(catItems.filter((i) => i.counts !== false).length))}</span>
          </div>
          <div class="row">
            <span class="grade-category-avg">${stats && stats.pct !== null ? fmtPercent(stats.pct, 1) : '—'}</span>
            ${cat ? html`<button type="button" class="btn btn--ghost btn--icon btn--sm" data-action="edit-category" data-id="${cat.id}" aria-label="${t('grades.editCategory')}">${raw(icon('edit'))}</button>` : ''}
          </div>
        </header>
        ${catItems.length ? html`<div class="list">${catItems.map((i) => itemRow(i, summary))}</div>` : html`<p class="small muted" style="margin:0 0 var(--space-2)">${t('grades.noItemsInCategory')}</p>`}
        <button type="button" class="btn btn--ghost btn--sm" data-action="add-item" data-category="${cat ? cat.id : ''}">${raw(icon('plus'))}<span>${t('grades.addItem')}</span></button>
      </section>`);
    });
    if (uncategorized.length) {
      sections.push(html`<section class="grade-category is-muted"><header class="grade-category-head"><h3 class="grade-category-name">${t('grades.uncategorized')}</h3></header><div class="list">${uncategorized.map((i) => itemRow(i, summary))}</div></section>`);
    }
    setHtml(container, html`
      ${summary.warnings.map((w) => html`<div class="notice notice--warning">${raw(icon('alert'))}<p>${tMessage(w)}</p></div>`)}
      <section class="card">${summaryCards(course, summary)}</section>
      <div class="grid-main-side">
        <section class="card">
          <div class="card-head"><h2 class="card-title">${t('grades.breakdown')}</h2>${button(t('grades.addCategory'), { size: 'sm', action: 'add-category', iconName: 'plus' })}</div>
          <div class="stack">${sections}</div>
        </section>
        ${calculatorHtml(course, summary, items)}
      </div>`);
    wireCalculator(container, summary, items);
  }

  const reload = () => renderCourseGrades(container, { course, refresh });
  container.onclick = async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || !container.contains(el)) return;
    const action = el.dataset.action;
    if (action === 'add-category') openCategoryEditor({ course, nextSortOrder: categories.length, onSaved: reload });
    else if (action === 'edit-category') openCategoryEditor({ course, category: categories.find((c) => c.id === el.dataset.id), onSaved: reload });
    else if (action === 'add-item') openGradeItemEditor({ course, categories, defaultCategoryId: el.dataset.category || null, nextSortOrder: items.length, onSaved: reload });
    else if (action === 'edit-item') openGradeItemEditor({ course, categories, item: items.find((i) => i.id === el.dataset.id), onSaved: reload });
    else if (action === 'edit-course-target') {
      openCourseEditor({ course, onSaved: () => refresh() });
    } else if (action === 'use-preset') {
      el.disabled = true;
      try {
        await createCategories(app().userId, course.id, CATEGORY_PRESETS.map((p) => ({ name: t(p.nameKey), weight: p.weight })));
        toast(t('grades.presetAdded'), { kind: 'success' });
        reload();
      } catch (err) {
        console.error(err);
        el.disabled = false;
        toast(t('v3.saveError'), { kind: 'error' });
      }
    }
  };
}

registerCourseTab({ id: 'grades', order: 10, labelKey: 'courses.tabGrades', render: renderCourseGrades });

// Grade badge on each course card.
registerCourseCardProvider({
  id: 'grades',
  async load(courses) {
    if (!has('grades')) return {};
    const data = await loadGradeData(app().userId);
    const out = {};
    courses.forEach((c) => {
      const { summary } = courseSummary(c, data);
      if (summary.current !== null) out[c.id] = `<span class="badge badge--outline tabular" title="${escapeHtml(t('grades.currentGrade'))}">${escapeHtml(fmtPercent(summary.current, 1))}</span>`;
    });
    return out;
  },
});

// Grade card on the course Overview.
registerCourseOverviewWidget({
  id: 'grades',
  order: 10,
  slot: 'side',
  async render({ course }) {
    if (!has('grades')) return '';
    const data = await loadGradeData(app().userId);
    const { summary, items } = courseSummary(course, data);
    if (!items.length) return '';
    const target = course.target_grade !== null && course.target_grade !== undefined ? Number(course.target_grade) : null;
    return html`<section class="card">
      <div class="card-head"><h2 class="card-title">${t('nav.grades')}</h2><a class="card-link" href="#/courses/${course.id}:grades">${t('common.viewAll')}</a></div>
      <div class="row-between">
        <span class="grade-big" style="font-size:var(--text-2xl)">${summary.current !== null ? fmtPercent(summary.current, 1) : '—'}</span>
        ${statusBadge(gradeStatus(summary, target))}
      </div>
      ${rangeBar(summary, target, course.color)}
      ${target !== null ? html`<p class="small muted" style="margin:var(--space-2) 0 0">${requiredText(requiredOnRemaining(summary, target), target)}</p>` : ''}
    </section>`;
  },
});

// ---------------------------------------------------------------- Grades page
export function initGradesPage() {
  const root = document.getElementById('gradesView');
  if (!root) return null;
  let token = 0;

  async function render() {
    const my = ++token;
    const head = pageHead({ eyebrow: t('nav.sectionAcademics'), title: t('nav.grades'), subtitle: t('grades.pageSubtitle') });
    if (!has('grades') || !has('courses')) {
      setHtml(root, [head, migrationNotice(has('courses') ? 'grades' : 'courses'), quickCalculator()]);
      wireQuick();
      return;
    }
    setHtml(root, [head, skeletonRows(4, 72)]);
    let courses;
    let data;
    try {
      [courses, data] = await Promise.all([listCourses(app().userId), loadGradeData(app().userId)]);
    } catch (err) {
      console.error('Could not load grades', err);
      if (my === token) setHtml(root, [head, errorNotice('', { retryAction: 'retry' })]);
      return;
    }
    if (my !== token) return;
    const active = sortCourses(courses).filter((c) => !c.archived);
    if (!active.length) {
      setHtml(root, [head, html`<div class="card">${emptyState({ iconName: 'grade', title: t('grades.noCoursesTitle'), body: t('grades.noCoursesBody'), actions: html`<a class="btn btn--primary" href="#/courses">${t('courses.addFirst')}</a>` })}</div>`, quickCalculator()]);
      wireQuick();
      return;
    }
    const rows = active.map((c) => ({ course: c, ...courseSummary(c, data) }));
    const withGrades = rows.filter((r) => r.summary.current !== null);
    setHtml(root, [head, html`<div class="grid-main-side">
      <section class="card card-flush">
        <div class="grade-table" role="table" aria-label="${t('nav.grades')}">
          <div class="grade-table-head" role="row">
            <span role="columnheader">${t('nav.courses')}</span>
            <span role="columnheader">${t('grades.currentGrade')}</span>
            <span role="columnheader">${t('grades.graded')}</span>
            <span role="columnheader">${t('grades.target')}</span>
            <span role="columnheader">${t('grades.status')}</span>
          </div>
          ${rows.map((r) => {
            const target = r.course.target_grade !== null && r.course.target_grade !== undefined ? Number(r.course.target_grade) : null;
            return html`<a class="grade-table-row" role="row" href="#/courses/${r.course.id}:grades" style="--c:${safeColor(r.course.color)}">
              <span role="cell" class="grade-table-course"><span class="course-dot"></span><span><strong>${r.course.code || r.course.name}</strong><span class="muted small">${r.course.code ? r.course.name : ''}</span></span></span>
              <span role="cell" class="grade-table-grade tabular">${r.summary.current !== null ? fmtPercent(r.summary.current, 1) : html`<span class="muted">—</span>`}</span>
              <span role="cell" class="grade-table-progress"><span class="bar bar--thin"><span style="width:${Math.round(r.summary.completedShare * 100)}%"></span></span><span class="small muted tabular">${fmtPercent(r.summary.completedShare * 100, 0)}</span></span>
              <span role="cell" class="tabular">${target !== null ? fmtPercent(target, 1) : html`<span class="muted">—</span>`}</span>
              <span role="cell">${statusBadge(gradeStatus(r.summary, target))}</span>
            </a>`;
          })}
        </div>
        ${!withGrades.length ? html`<p class="small muted" style="padding:0 var(--space-5) var(--space-4);margin:0">${t('grades.pageHint')}</p>` : ''}
      </section>
      ${quickCalculator()}
    </div>`]);
    wireQuick();
  }

  // Course-free "what do I need on the final?" calculator.
  function quickCalculator() {
    return html`<section class="card" data-quick-calc>
      <div class="card-head"><div><h2 class="card-title">${t('grades.calcTitle')}</h2><p class="card-sub">${t('grades.quickSub')}</p></div></div>
      <div class="stack-sm">
        <div class="field"><label for="qcCurrent">${t('grades.qcCurrent')}</label><input type="number" id="qcCurrent" min="0" max="150" step="0.1" inputmode="decimal" value="86"></div>
        <div class="field"><label for="qcTarget">${t('grades.calcTarget')}</label><input type="number" id="qcTarget" min="0" max="100" step="0.5" inputmode="decimal" value="90"></div>
        <div class="field"><label for="qcWeight">${t('grades.qcFinalWeight')}</label><input type="number" id="qcWeight" min="1" max="100" step="0.5" inputmode="decimal" value="30"></div>
      </div>
      <div class="grade-calc-result" id="qcResult" aria-live="polite"></div>
    </section>`;
  }

  function wireQuick() {
    const card = root.querySelector('[data-quick-calc]');
    if (!card) return;
    const ids = ['qcCurrent', 'qcTarget', 'qcWeight'];
    const update = () => {
      const [current, target, finalWeight] = ids.map((id) => card.querySelector(`#${id}`).value);
      const r = requiredFinalSimple({ current, target, finalWeight });
      const kind = r.status === 'out_of_reach' ? 'danger' : r.status === 'secured' ? 'success' : 'accent';
      card.querySelector('#qcResult').innerHTML = r.status === 'no_data'
        ? `<p class="small muted" style="margin:0">${escapeHtml(t('grades.reqNoData'))}</p>`
        : `<div class="grade-calc-answer grade-calc-answer--${kind}">${r.status !== 'secured' ? `<span class="grade-calc-figure">${escapeHtml(fmtPercent(r.required, 1))}</span>` : ''}<span>${escapeHtml(requiredText(r, target, { scope: 'item' }))}</span></div>`;
    };
    ids.forEach((id) => card.querySelector(`#${id}`).addEventListener('input', update));
    update();
  }

  on(root, 'click', '[data-action="retry"]', () => render());
  onChange((topic) => {
    if (!root.hidden && ['grades', 'courses'].includes(topic)) render();
  });
  return { onShow: () => render() };
}

