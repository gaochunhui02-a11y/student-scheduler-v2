// "Notes" and "Links" cards for a project, goal or course page (V4-H). Each
// lists what's linked to that item and offers New note / Add link. One
// delegated listener handles the buttons wherever the cards are shown.

import { t, tCount } from '../shared/i18n.js';
import { has } from '../shared/capabilities.js';
import { app } from '../app/context.js';
import { html, raw } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { button } from '../ui/components.js';
import { toast } from '../ui/toast.js';
import { listNotes, createNote } from './notesData.js';
import { sortNotes, noteDisplayTitle } from './noteModel.js';
import { noteExcerpt } from './noteMarkdown.js';
import { listResources } from '../resources/resourcesData.js';
import { hostOf, normalizeUrl } from '../resources/resourceModel.js';
import { registerCourseTab } from '../courses/courseTabs.js';
import { setHtml } from '../ui/dom.js';
import { skeletonRows, emptyState, migrationNotice } from '../ui/components.js';

/**
 * @param {'project_id'|'goal_id'|'course_id'|'exam_id'} kind
 * @param {string} id
 * @returns {Promise<string>} html fragment ('' when neither feature exists)
 */
export async function notesAndLinksCards(kind, id, { links = true } = {}) {
  const ctx = app();
  const showNotes = has('notes');
  const showLinks = links && has('resources') && (kind === 'course_id' || has('resourcesV4'));
  if (!showNotes && !showLinks) return '';
  const [notes, resources] = await Promise.all([
    showNotes ? listNotes(ctx.userId).catch(() => []) : [],
    showLinks ? listResources(ctx.userId).catch(() => []) : [],
  ]);
  const mine = sortNotes(notes.filter((n) => !n.archived && n[kind] === id));
  const myLinks = resources.filter((r) => r[kind] === id);
  const notesCard = showNotes ? html`<section class="card card-flush v4-flush" aria-labelledby="lp-notes-${id}">
    <div class="card-head"><h2 class="card-title" id="lp-notes-${id}">${t('nav.notes')} <span class="muted">${mine.length || ''}</span></h2>${button(t('notes.new'), { size: 'sm', action: 'lp-new-note', iconName: 'plus', attrs: `data-kind="${kind}" data-id="${id}"` })}</div>
    ${mine.length ? html`<ul class="list">${mine.slice(0, 6).map((n) => html`<li class="list-row"><a class="list-row-main lp-note" href="#/notes/${n.id}"><span class="list-row-title">${noteDisplayTitle(n, t('notes.untitled'))}</span><span class="list-row-meta">${noteExcerpt(n.body, 90)}</span></a></li>`)}</ul>
      ${mine.length > 6 ? html`<div class="card-body"><a class="card-link" href="#/notes">${tCount('notes.moreCount', mine.length - 6)}</a></div>` : ''}`
      : html`<div class="card-body"><p class="muted small" style="margin:0">${t('notes.noneLinked')}</p></div>`}
  </section>` : '';
  const linksCard = showLinks ? html`<section class="card card-flush v4-flush" aria-labelledby="lp-links-${id}">
    <div class="card-head"><h2 class="card-title" id="lp-links-${id}">${t('library.links')} <span class="muted">${myLinks.length || ''}</span></h2>${button(t('library.add'), { size: 'sm', action: 'lp-add-link', iconName: 'link', attrs: `data-kind="${kind}" data-id="${id}"` })}</div>
    ${myLinks.length ? html`<ul class="list">${myLinks.map((r) => {
      const url = normalizeUrl(r.url);
      return html`<li class="list-row">${raw(icon(r.favorite ? 'star' : 'link'))}<span class="list-row-main">${url ? html`<a class="list-row-title resource-link" href="${url}" target="_blank" rel="noopener noreferrer">${r.title}</a>` : html`<span class="list-row-title">${r.title}</span>`}<span class="list-row-meta">${hostOf(r.url)}</span></span></li>`;
    })}</ul>` : html`<div class="card-body"><p class="muted small" style="margin:0">${t('library.noneLinked')}</p></div>`}
  </section>` : '';
  return html`${notesCard}${linksCard}`;
}

let installed = false;
export function installLinkedPanelActions() {
  if (installed) return;
  installed = true;
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action="lp-new-note"], [data-action="lp-add-link"]');
    if (!el) return;
    const { kind, id } = el.dataset;
    if (el.dataset.action === 'lp-new-note') {
      try {
        const row = await createNote(app().userId, { title: '', body: '', [kind]: id });
        app().navigate('notesView', row.id);
      } catch (err) {
        console.error(err);
        toast(t('v3.saveError'), { kind: 'error' });
      }
    } else {
      const [{ openLibraryEditor }, { listCourses }, { listProjects }, { listGoals }, { listExams }] = await Promise.all([
        import('../resources/libraryEditor.js'), import('../academics/academicsData.js'), import('../projects/projectsData.js'), import('../goals/goalsData.js'), import('../exams/examsData.js'),
      ]);
      const uid = app().userId;
      const [courses, projects, goals, exams] = await Promise.all([
        has('courses') ? listCourses(uid).catch(() => []) : [], has('projects') ? listProjects(uid).catch(() => []) : [],
        has('goals') ? listGoals(uid).catch(() => []) : [], has('exams') ? listExams(uid).catch(() => []) : [],
      ]);
      openLibraryEditor({ data: { courses, projects, goals, exams }, parent: { kind, id }, onSaved: () => {} });
    }
  });
}
installLinkedPanelActions();

// Course page "Notes" tab.
registerCourseTab({
  id: 'notes',
  order: 28,
  labelKey: 'nav.notes',
  async render(container, { course }) {
    if (!has('notes')) {
      setHtml(container, migrationNotice('notes'));
      return;
    }
    setHtml(container, skeletonRows(2, 60));
    const frag = await notesAndLinksCards('course_id', course.id, { links: false });
    setHtml(container, frag || html`<div class="card">${emptyState({ iconName: 'file', title: t('notes.noneLinked'), compact: true })}</div>`);
  },
});
