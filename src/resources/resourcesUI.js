// Course Resources tab (V3-N): syllabus, lecture recordings, documents and
// reference links for a course, plus links attached to its tasks. Links
// only — validated http(s), opened with rel="noopener noreferrer".

import { t } from '../shared/i18n.js';
import { has } from '../shared/capabilities.js';
import { app } from '../app/context.js';
import { html, raw, setHtml } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { emptyState, migrationNotice, skeletonRows, errorNotice } from '../ui/components.js';
import { toast } from '../ui/toast.js';
import { confirmAction } from '../ui/drawer.js';
import { listResources, createResource, deleteResource } from './resourcesData.js';
import { validateResourceFields, hostOf, RESOURCE_KINDS, normalizeUrl } from './resourceModel.js';
import { listAllCourseTaskRows } from '../academics/academicsData.js';
import { registerCourseTab } from '../courses/courseTabs.js';

const URL_HINT = 'https://'; // a URL scheme, not translatable text
const KIND_ICON = { link: 'link', document: 'file', lecture: 'play', syllabus: 'book', reference: 'search' };

function resourceRow(r, { taskName = '' } = {}) {
  return html`<div class="list-row resource-row" data-resource-id="${r.id}">
    <span class="resource-icon" aria-hidden="true">${raw(icon(KIND_ICON[r.kind] || 'link'))}</span>
    <span class="list-row-main">
      ${normalizeUrl(r.url) ? html`<a class="list-row-title resource-link" href="${normalizeUrl(r.url)}" target="_blank" rel="noopener noreferrer">${r.title}</a>` : html`<span class="list-row-title">${r.title}</span>`}
      <span class="list-row-meta"><span>${hostOf(r.url)}</span><span>${t(`resources.kind_${r.kind}`)}</span>${taskName ? html`<span>· ${taskName}</span>` : ''}</span>
    </span>
    <button type="button" class="btn btn--ghost btn--icon btn--sm" data-action="delete-resource" aria-label="${t('resources.remove')}: ${r.title}">${raw(icon('trash'))}</button>
  </div>`;
}

async function renderCourseResources(container, { course }) {
  if (!has('resources')) {
    setHtml(container, migrationNotice('resources'));
    return;
  }
  setHtml(container, skeletonRows(3, 48));
  let all;
  let taskRows = [];
  try {
    [all, taskRows] = await Promise.all([listResources(app().userId), listAllCourseTaskRows(app().userId).catch(() => [])]);
  } catch (err) {
    console.error(err);
    setHtml(container, errorNotice(''));
    return;
  }
  const courseTaskIds = new Map(taskRows.filter((r) => r.course_id === course.id).map((r) => [r.id, r.name]));
  const mine = all.filter((r) => r.course_id === course.id);
  const fromTasks = all.filter((r) => !r.course_id && courseTaskIds.has(r.task_id));
  setHtml(container, html`<div class="grid-main-side">
    <section class="card">
      <div class="card-head"><h2 class="card-title">${t('resources.courseLinks')}</h2></div>
      ${mine.length ? html`<div class="list">${mine.map((r) => resourceRow(r))}</div>`
        : emptyState({ iconName: 'link', title: t('resources.emptyTitle'), body: t('resources.emptyBody'), compact: true })}
      ${fromTasks.length ? html`<p class="section-label" style="margin-top:var(--space-5)">${t('resources.fromTasks')}</p><div class="list">${fromTasks.map((r) => resourceRow(r, { taskName: courseTaskIds.get(r.task_id) }))}</div>` : ''}
    </section>
    <section class="card">
      <div class="card-head"><h2 class="card-title">${t('resources.addTitle')}</h2></div>
      <form class="stack-sm" data-resource-form novalidate>
        <div class="field"><label for="resUrl">${t('resources.url')}</label><input type="url" id="resUrl" inputmode="url" placeholder="${URL_HINT}" aria-describedby="resUrl-error" required></div>
        <div class="field"><label for="resTitle">${t('resources.title')}</label><input type="text" id="resTitle" maxlength="200" placeholder="${t('resources.titlePlaceholder')}"></div>
        <div class="field"><label for="resKind">${t('resources.kind')}</label><select id="resKind">${RESOURCE_KINDS.map((k) => html`<option value="${k}">${t(`resources.kind_${k}`)}</option>`)}</select></div>
        <p class="field-error" id="resUrl-error" role="alert"></p>
        <button type="submit" class="btn btn--primary">${raw(icon('plus'))}<span>${t('resources.add')}</span></button>
        <p class="field-hint">${t('resources.linksOnly')}</p>
      </form>
    </section>
  </div>`);

  const form = container.querySelector('[data-resource-form]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { ok, fields, errors } = validateResourceFields({ url: form.querySelector('#resUrl').value, title: form.querySelector('#resTitle').value, kind: form.querySelector('#resKind').value });
    const errEl = form.querySelector('#resUrl-error');
    errEl.textContent = ok ? '' : t(errors.url || errors.title);
    form.querySelector('#resUrl').setAttribute('aria-invalid', ok ? 'false' : 'true');
    if (!ok) return;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await createResource(app().userId, { ...fields, course_id: course.id, task_id: null });
      toast(t('resources.added'), { kind: 'success' });
      renderCourseResources(container, { course });
    } catch (err) {
      console.error(err);
      errEl.textContent = t('v3.saveError');
      btn.disabled = false;
    }
  });
  container.onclick = async (e) => {
    const btn = e.target.closest('[data-action="delete-resource"]');
    if (!btn) return;
    const id = btn.closest('[data-resource-id]').dataset.resourceId;
    const ok = await confirmAction({ title: t('resources.removeTitle'), message: t('resources.removeBody'), confirmLabel: t('resources.remove'), danger: true });
    if (!ok) return;
    try {
      await deleteResource(id);
      renderCourseResources(container, { course });
    } catch {
      toast(t('v3.deleteError'), { kind: 'error' });
    }
  };
}

registerCourseTab({ id: 'resources', order: 30, labelKey: 'courses.tabResources', render: renderCourseResources });
