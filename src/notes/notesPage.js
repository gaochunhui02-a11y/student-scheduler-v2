// Notes & Library (V4-H, #/notes, #/notes/<id>, #/notes/library).
//   Notes   — the student's own notes: list (search, pinned, archived) and
//             an editor with autosave, a safe Markdown preview (ticking a
//             checklist item in the preview updates the note), links to a
//             course / project / goal / exam, tags, pin, archive, templates.
//   Library — every saved link in one place (course, task, project, goal,
//             exam or general "My library" links): search, kind, favorites,
//             add / star / remove.

import { t, tCount } from '../shared/i18n.js';
import { has } from '../shared/capabilities.js';
import { app, onChange } from '../app/context.js';
import { html, raw, setHtml, on, debounce } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { pageHead, emptyState, button, skeletonRows, migrationNotice, errorNotice, segmented, wireSegmented, tabList, wireTabs } from '../ui/components.js';
import { fmtDate, fmtRelativeDay } from '../ui/format.js';
import { toast } from '../ui/toast.js';
import { confirmAction } from '../ui/drawer.js';
import { todayStr } from '../shared/dates.js';
import { listCourses } from '../academics/academicsData.js';
import { listProjects } from '../projects/projectsData.js';
import { listGoals } from '../goals/goalsData.js';
import { listExams } from '../exams/examsData.js';
import { listResources, updateResource, deleteResource } from '../resources/resourcesData.js';
import { filterLibrary, resourceParents, hostOf, normalizeUrl, RESOURCE_KINDS, RESOURCE_KINDS_V4 } from '../resources/resourceModel.js';
import { openLibraryEditor } from '../resources/libraryEditor.js';
import { matchesSpace } from '../workspace/spacesModel.js';
import { currentSpaceFilter, spaceScopeNote } from '../workspace/spaceScope.js';
import { listNotes, createNote, updateNote, deleteNote } from './notesData.js';
import { filterNotes, sortNotes, noteDisplayTitle, validateNoteFields, cleanTags, NOTE_TEMPLATES, templateBody } from './noteModel.js';
import { renderNoteMarkdown, noteExcerpt, checklistCounts, toggleChecklistItem } from './noteMarkdown.js';

const KIND_ICON = { link: 'link', document: 'file', lecture: 'play', syllabus: 'book', reference: 'search', video: 'play', article: 'file', tool: 'wand', book: 'book', other: 'link' };
const LINK_FIELDS = [['course_id', 'courses'], ['project_id', 'projects'], ['goal_id', 'goals'], ['exam_id', 'exams']];
const VIEW_KEY = 'student-scheduler-notes-view';

export function initNotesPage() {
  const root = document.getElementById('notesView');
  if (!root) return null;
  let token = 0;
  let data = null;
  let tab = 'notes';
  let currentId = null;
  let mode = 'edit'; // edit | preview
  let filters = { view: 'all', search: '' };
  let lib = { search: '', kind: '', favorites: false, parent: '' };
  let pending = null; // { id, fields } awaiting autosave
  let saveState = '';

  function head() {
    return pageHead({
      eyebrow: t('nav.sectionOrganize'),
      title: t('nav.notes'),
      subtitle: t('notes.subtitle'),
      actions: tab === 'notes'
        ? (has('notes') ? button(t('notes.new'), { variant: 'primary', action: 'new-note', iconName: 'plus' }) : '')
        : (has('resources') ? button(t('library.add'), { variant: 'primary', action: 'add-link', iconName: 'plus' }) : ''),
    });
  }

  async function load() {
    const ctx = app();
    const [notes, resources, courses, projects, goals, exams] = await Promise.all([
      has('notes') ? listNotes(ctx.userId) : [],
      has('resources') ? listResources(ctx.userId).catch(() => []) : [],
      has('courses') ? listCourses(ctx.userId).catch(() => []) : [],
      has('projects') ? listProjects(ctx.userId).catch(() => []) : [],
      has('goals') ? listGoals(ctx.userId).catch(() => []) : [],
      has('exams') ? listExams(ctx.userId).catch(() => []) : [],
    ]);
    return { notes, resources, courses, projects, goals, exams };
  }

  function nameOf(kind, id) {
    if (!data || !id) return '';
    if (kind === 'course_id') { const c = data.courses.find((x) => x.id === id); return c ? (c.code || c.name) : ''; }
    if (kind === 'project_id') { const p = data.projects.find((x) => x.id === id); return p ? p.title : ''; }
    if (kind === 'goal_id') { const g = data.goals.find((x) => x.id === id); return g ? g.title : ''; }
    if (kind === 'exam_id') { const e = data.exams.find((x) => x.id === id); return e ? e.name : ''; }
    return '';
  }
  const linkIcon = { course_id: 'book', project_id: 'briefcase', goal_id: 'target', exam_id: 'exam', task_id: 'tasks' };
  function linkChips(item) {
    return LINK_FIELDS.filter(([k]) => item[k]).map(([k]) => {
      const name = nameOf(k, item[k]);
      return name ? html`<span class="note-link-chip">${raw(icon(linkIcon[k]))}${name}</span>` : '';
    });
  }

  async function render(param = undefined) {
    if (param !== undefined) {
      if (param === 'library') { tab = 'library'; currentId = null; } else { tab = 'notes'; currentId = param || currentId; }
    }
    const my = ++token;
    if (!data) setHtml(root, [head(), skeletonRows(4, 60)]);
    try {
      data = await load();
    } catch (err) {
      console.error('Could not load notes', err);
      if (my === token) setHtml(root, [head(), errorNotice('', { retryAction: 'notes-retry' })]);
      return;
    }
    if (my !== token) return;
    paint();
  }

  function tabs() {
    return tabList('notesTabs', [{ id: 'notes', label: t('notes.tabNotes'), count: data && has('notes') ? data.notes.filter((n) => !n.archived).length : null }, { id: 'library', label: t('notes.tabLibrary'), count: data ? data.resources.length : null }], tab);
  }

  function paint(focusSel = null) {
    if (tab === 'library') paintLibrary();
    else paintNotes();
    wireTabs(root, 'notesTabs', (id) => {
      flushSave();
      tab = id;
      app().navigate('notesView', id === 'library' ? 'library' : (currentId || null));
    });
    if (focusSel) root.querySelector(focusSel)?.focus();
  }

  // ---------------- notes ----------------
  function paintNotes() {
    if (!has('notes')) {
      setHtml(root, [head(), tabs(), migrationNotice('notes')]);
      return;
    }
    const space = currentSpaceFilter();
    const inSpace = (n) => matchesSpace(n.space_id || null, space);
    const visible = sortNotes(filterNotes(data.notes, filters, inSpace));
    const note = currentId ? data.notes.find((n) => n.id === currentId) : null;
    const counts = { all: filterNotes(data.notes, { view: 'all' }, inSpace).length, pinned: filterNotes(data.notes, { view: 'pinned' }, inSpace).length, archived: filterNotes(data.notes, { view: 'archived' }, inSpace).length };

    const listPane = html`<aside class="notes-list-pane${note ? ' has-selection' : ''}" aria-label="${t('notes.listLabel')}">
      <div class="notes-list-tools">
        <label class="sr-only" for="notesSearch">${t('notes.search')}</label>
        <input type="search" id="notesSearch" class="v3-input" placeholder="${t('notes.search')}" value="${filters.search}" autocomplete="off">
        ${segmented('notesView', ['all', 'pinned', 'archived'].map((v) => ({ value: v, label: `${t(`notes.view_${v}`)}${counts[v] ? ` ${counts[v]}` : ''}` })), filters.view, { label: t('notes.filterLabel') })}
      </div>
      ${visible.length ? html`<ul class="notes-list">${visible.map((n) => {
        const cl = checklistCounts(n.body);
        return html`<li><a class="note-item${n.id === currentId ? ' is-active' : ''}" href="#/notes/${n.id}"${n.id === currentId ? raw(' aria-current="true"') : ''}>
          <span class="note-item-top">${n.pinned ? html`<span class="note-pin" aria-label="${t('notes.pinned')}">${raw(icon('pin'))}</span>` : ''}<span class="note-item-title">${noteDisplayTitle(n, t('notes.untitled'))}</span></span>
          <span class="note-item-excerpt">${noteExcerpt(n.title ? n.body : n.body.split('\n').slice(1).join('\n'), 110) || t('notes.noBody')}</span>
          <span class="note-item-meta">${fmtRelativeDay((n.updated_at || '').slice(0, 10), todayStr())}${cl.total ? html` · ${raw(icon('check'))}${cl.done}/${cl.total}` : ''}${linkChips(n)}</span>
        </a></li>`;
      })}</ul>` : html`<div class="notes-list-empty">${emptyState({ iconName: 'file', title: data.notes.length ? t('notes.noneMatch') : t('notes.emptyTitle'), body: data.notes.length ? '' : t('notes.emptyBody'), compact: true })}</div>`}
    </aside>`;

    const editorPane = note ? editorHtml(note) : html`<section class="notes-editor-pane is-empty">${emptyState({ iconName: 'file', title: t('notes.pickTitle'), body: t('notes.pickBody'), compact: true, actions: button(t('notes.new'), { variant: 'primary', action: 'new-note', iconName: 'plus' }) })}</section>`;

    setHtml(root, [head(), tabs(), spaceScopeNote(), html`<div class="notes-layout">${listPane}${editorPane}</div>`]);
    wireSegmented(root, 'notesView', (v) => { filters = { ...filters, view: v }; try { localStorage.setItem(VIEW_KEY, v); } catch { /* per-viewer */ } paint('[data-seg="notesView"] [aria-pressed="true"]'); });
    wireSegmented(root, 'noteMode', (v) => { flushSave(); mode = v; paint('[data-seg="noteMode"] [aria-pressed="true"]'); });
    const search = root.querySelector('#notesSearch');
    search.addEventListener('input', debounce(() => {
      filters = { ...filters, search: search.value };
      paint();
      const again = root.querySelector('#notesSearch');
      again.focus();
      again.setSelectionRange(again.value.length, again.value.length);
    }, 150));
    wireEditor(note);
  }

  function linkSelect(note) {
    const opts = [html`<option value="">${t('notes.linkNone')}</option>`];
    LINK_FIELDS.forEach(([k, coll]) => {
      const list = (data[coll] || []).filter((x) => !x.archived && x.status !== 'archived');
      if (!list.length) return;
      opts.push(html`<optgroup label="${t(`notes.linkGroup_${k}`)}">${list.map((x) => html`<option value="${k}:${x.id}"${note[k] === x.id ? raw(' selected') : ''}>${x.code || x.title || x.name}</option>`)}</optgroup>`);
    });
    return html`<label class="sr-only" for="noteLink">${t('notes.linkLabel')}</label><select id="noteLink" class="v3-input note-link-select">${opts}</select>`;
  }

  function editorHtml(note) {
    const empty = !note.title && !note.body.trim();
    return html`<section class="notes-editor-pane" aria-label="${t('notes.editorLabel')}">
      <a href="#/notes" class="back-link notes-back">${raw(icon('chevronLeft'))}${t('notes.allNotes')}</a>
      <div class="note-toolbar">
        ${segmented('noteMode', [{ value: 'edit', label: t('notes.modeEdit') }, { value: 'preview', label: t('notes.modePreview') }], mode, { label: t('notes.modeLabel') })}
        <span class="note-save-state" aria-live="polite" data-role="save-state">${saveState}</span>
        <span class="toolbar-spacer"></span>
        <button type="button" class="btn btn--ghost btn--sm" data-action="toggle-pin" aria-pressed="${note.pinned ? 'true' : 'false'}">${raw(icon('pin'))}<span>${note.pinned ? t('notes.unpin') : t('notes.pin')}</span></button>
        <button type="button" class="btn btn--ghost btn--sm" data-action="toggle-archive">${raw(icon('archive'))}<span>${note.archived ? t('notes.unarchive') : t('notes.archive')}</span></button>
        <button type="button" class="btn btn--ghost btn--icon btn--sm" data-action="delete-note" aria-label="${t('notes.delete')}">${raw(icon('trash'))}</button>
      </div>
      <label class="sr-only" for="noteTitle">${t('notes.titleLabel')}</label>
      <input type="text" id="noteTitle" class="note-title-input" maxlength="200" placeholder="${t('notes.titlePlaceholder')}" value="${note.title}" autocomplete="off">
      <div class="note-meta-row">
        ${linkSelect(note)}
        <label class="sr-only" for="noteTags">${t('notes.tagsLabel')}</label>
        <input type="text" id="noteTags" class="v3-input note-tags-input" placeholder="${t('notes.tagsPlaceholder')}" value="${(note.tags || []).join(', ')}" autocomplete="off">
      </div>
      ${empty && mode === 'edit' ? html`<div class="note-templates" role="group" aria-label="${t('notes.templatesLabel')}"><span class="small muted">${t('notes.startFrom')}</span>${NOTE_TEMPLATES.filter((x) => x !== 'blank').map((x) => html`<button type="button" class="btn btn--secondary btn--sm" data-action="use-template" data-template="${x}">${t(`notes.tpl_${x}`)}</button>`)}</div>` : ''}
      ${mode === 'edit'
        ? html`<label class="sr-only" for="noteBody">${t('notes.bodyLabel')}</label><textarea id="noteBody" class="note-body-input" maxlength="50000" placeholder="${t('notes.bodyPlaceholder')}" aria-describedby="noteFormatHint">${note.body}</textarea>
          <p class="field-hint" id="noteFormatHint">${t('notes.formatHint')}</p>`
        : html`<article class="note-preview" data-role="preview">${note.body.trim() ? raw(renderNoteMarkdown(note.body)) : html`<p class="muted">${t('notes.noBody')}</p>`}</article>`}
      <p class="small muted note-dates">${t('notes.edited').replace('{date}', fmtDate((note.updated_at || '').slice(0, 10)))}</p>
    </section>`;
  }

  function scheduleSave(id, fields) {
    pending = { id, fields: { ...(pending && pending.id === id ? pending.fields : {}), ...fields } };
    setSaveState(t('notes.saving'));
    autosave();
  }
  const autosave = debounce(() => flushSave(), 700);
  async function flushSave() {
    if (!pending) return;
    const { id, fields } = pending;
    pending = null;
    const current = data.notes.find((n) => n.id === id);
    if (!current) return;
    const v = validateNoteFields({ ...current, ...fields });
    if (v.errors.title || v.errors.body === 'notes.errBodyLong') { setSaveState(t(v.errors.title || v.errors.body)); return; }
    try {
      const row = await updateNote(id, fields, { quiet: true });
      Object.assign(current, row);
      setSaveState(t('notes.saved'));
    } catch (err) {
      console.error(err);
      setSaveState(t('notes.saveFailed'));
    }
  }
  function setSaveState(text) {
    saveState = text;
    const el = root.querySelector('[data-role="save-state"]');
    if (el) el.textContent = text;
  }

  function wireEditor(note) {
    if (!note) return;
    const title = root.querySelector('#noteTitle');
    const body = root.querySelector('#noteBody');
    const tags = root.querySelector('#noteTags');
    const link = root.querySelector('#noteLink');
    title.addEventListener('input', () => scheduleSave(note.id, { title: title.value }));
    if (body) body.addEventListener('input', () => scheduleSave(note.id, { body: body.value }));
    tags.addEventListener('change', () => scheduleSave(note.id, { tags: cleanTags(tags.value) }));
    link.addEventListener('change', () => {
      const [k, id] = link.value ? link.value.split(':') : [null, null];
      const fields = Object.fromEntries(LINK_FIELDS.map(([f]) => [f, f === k ? id : null]));
      scheduleSave(note.id, fields);
      flushSave().then(() => paint('#noteLink'));
    });
    const preview = root.querySelector('[data-role="preview"]');
    if (preview) {
      // The box inside each item is the checkbox (the <li> keeps its list role).
      preview.querySelectorAll('.note-checklist li').forEach((li, i) => {
        const box = li.querySelector('.note-box');
        if (!box) return;
        box.tabIndex = 0;
        box.setAttribute('role', 'checkbox');
        box.removeAttribute('aria-hidden');
        box.setAttribute('aria-checked', li.classList.contains('is-done') ? 'true' : 'false');
        box.setAttribute('aria-label', li.textContent.replace(/^\s*✓?\s*\[[ x]\]\s*/, '').trim());
        li.querySelector('.sr-only')?.remove();
        const toggle = async () => {
          const next = toggleChecklistItem(note.body, i);
          scheduleSave(note.id, { body: next });
          note.body = next;
          await flushSave();
          paint(`[data-role="preview"] .note-checklist li:nth-of-type(${i + 1}) .note-box`);
        };
        li.addEventListener('click', (e) => { if (!e.target.closest('a')) toggle(); });
        box.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); } });
      });
    }
  }

  // ---------------- library ----------------
  function paintLibrary() {
    if (!has('resources')) {
      setHtml(root, [head(), tabs(), migrationNotice('resources')]);
      return;
    }
    const v4 = has('resourcesV4');
    // The library lists every saved link (its course/project decides where it shows elsewhere).
    const items = filterLibrary(data.resources, lib);
    const kinds = v4 ? RESOURCE_KINDS_V4 : RESOURCE_KINDS;
    const parents = [['', 'library.parentAll'], ...(v4 ? [['library', 'library.parentGeneral']] : []), ['course_id', 'library.parentCourses'], ['task_id', 'library.parentTasks'], ...(v4 ? [['project_id', 'library.parentProjects'], ['goal_id', 'library.parentGoals'], ['exam_id', 'library.parentExams']] : [])];
    const row = (r) => {
      const url = normalizeUrl(r.url);
      const parentsOf = resourceParents(r).map(([k, id]) => (k === 'task_id' ? '' : nameOf(k, id))).filter(Boolean);
      return html`<li class="list-row resource-row library-row" data-resource-id="${r.id}">
        <span class="resource-icon" aria-hidden="true">${raw(icon(KIND_ICON[r.kind] || 'link'))}</span>
        <span class="list-row-main">
          ${url ? html`<a class="list-row-title resource-link" href="${url}" target="_blank" rel="noopener noreferrer">${r.title}</a>` : html`<span class="list-row-title">${r.title}</span>`}
          <span class="list-row-meta"><span>${hostOf(r.url)}</span><span>${t(`resources.kind_${r.kind}`)}</span>${parentsOf.map((n) => html`<span class="note-link-chip">${n}</span>`)}${r.task_id ? html`<span class="note-link-chip">${t('library.onTask')}</span>` : ''}${r.in_library && !resourceParents(r).length ? html`<span class="note-link-chip">${t('library.general')}</span>` : ''}${(r.tags || []).map((tag) => html`<span class="muted">#${tag}</span>`)}</span>
        </span>
        ${v4 ? html`<button type="button" class="btn btn--ghost btn--icon btn--sm library-star" data-action="toggle-fav" aria-pressed="${r.favorite ? 'true' : 'false'}" aria-label="${(r.favorite ? t('library.unstar') : t('library.star'))}: ${r.title}">${raw(icon('star'))}</button>` : ''}
        <button type="button" class="btn btn--ghost btn--icon btn--sm" data-action="edit-link" aria-label="${t('common.edit')}: ${r.title}">${raw(icon('edit'))}</button>
        <button type="button" class="btn btn--ghost btn--icon btn--sm" data-action="delete-link" aria-label="${t('resources.remove')}: ${r.title}">${raw(icon('trash'))}</button>
      </li>`;
    };
    setHtml(root, [head(), tabs(), html`<div class="toolbar library-toolbar">
        <label class="sr-only" for="libSearch">${t('library.search')}</label>
        <input type="search" id="libSearch" class="v3-input" placeholder="${t('library.search')}" value="${lib.search}" autocomplete="off">
        <label class="sr-only" for="libKind">${t('resources.kind')}</label>
        <select id="libKind" class="v3-input filter-select"><option value="">${t('library.allKinds')}</option>${kinds.map((k) => html`<option value="${k}"${lib.kind === k ? raw(' selected') : ''}>${t(`resources.kind_${k}`)}</option>`)}</select>
        <label class="sr-only" for="libParent">${t('library.belongsTo')}</label>
        <select id="libParent" class="v3-input filter-select">${parents.map(([v, k]) => html`<option value="${v}"${lib.parent === v ? raw(' selected') : ''}>${t(k)}</option>`)}</select>
        ${v4 ? html`<button type="button" class="btn btn--secondary btn--sm" data-action="lib-favs" aria-pressed="${lib.favorites ? 'true' : 'false'}">${raw(icon('star'))}<span>${t('library.favorites')}</span></button>` : ''}
        <span class="toolbar-spacer"></span><span class="small muted">${tCount('library.count', items.length)}</span>
      </div>`,
      items.length ? html`<section class="card card-flush"><ul class="list">${items.map(row)}</ul></section>`
        : html`<div class="card">${emptyState({ iconName: 'link', title: data.resources.length ? t('library.noneMatch') : t('library.emptyTitle'), body: data.resources.length ? '' : t('library.emptyBody'), compact: true, actions: data.resources.length ? '' : button(t('library.add'), { variant: 'primary', action: 'add-link', iconName: 'plus' }) })}</div>`,
      html`<p class="field-hint">${t('resources.linksOnly')}</p>`]);
    const s = root.querySelector('#libSearch');
    s.addEventListener('input', debounce(() => { lib = { ...lib, search: s.value }; paintLibrary(); const again = root.querySelector('#libSearch'); again.focus(); again.setSelectionRange(again.value.length, again.value.length); wireTabs(root, 'notesTabs', (id) => { tab = id; app().navigate('notesView', id === 'library' ? 'library' : null); }); }, 150));
    root.querySelector('#libKind').addEventListener('change', (e) => { lib = { ...lib, kind: e.target.value }; paint('#libKind'); });
    root.querySelector('#libParent').addEventListener('change', (e) => { lib = { ...lib, parent: e.target.value }; paint('#libParent'); });
  }

  // ---------------- actions ----------------
  async function newNote(fields = {}) {
    try {
      const space = currentSpaceFilter();
      const row = await createNote(app().userId, { title: '', body: '', ...(space && space !== '__none' ? { space_id: space } : {}), ...fields });
      mode = 'edit';
      currentId = row.id;
      app().navigate('notesView', row.id);
      setTimeout(() => root.querySelector('#noteTitle')?.focus(), 50);
    } catch (err) {
      console.error(err);
      toast(t('v3.saveError'), { kind: 'error' });
    }
  }

  on(root, 'click', '[data-action]', async (e, el) => {
    const a = el.dataset.action;
    const note = currentId && data ? data.notes.find((n) => n.id === currentId) : null;
    if (a === 'notes-retry') render();
    else if (a === 'new-note') { flushSave(); newNote(); }
    else if (a === 'use-template' && note) {
      const body = templateBody(el.dataset.template, t);
      note.body = body;
      scheduleSave(note.id, { body });
      await flushSave();
      paint('#noteBody');
    } else if (a === 'toggle-pin' && note) {
      await flushSave();
      try { await updateNote(note.id, { pinned: !note.pinned }); await render(); root.querySelector('[data-action="toggle-pin"]')?.focus(); } catch { toast(t('v3.saveError'), { kind: 'error' }); }
    } else if (a === 'toggle-archive' && note) {
      await flushSave();
      try {
        await updateNote(note.id, { archived: !note.archived });
        toast(note.archived ? t('notes.unarchived') : t('notes.archived'), { kind: 'success' });
        await render();
      } catch { toast(t('v3.saveError'), { kind: 'error' }); }
    } else if (a === 'delete-note' && note) {
      const ok = await confirmAction({ title: t('notes.deleteTitle'), message: t('notes.deleteBody'), confirmLabel: t('notes.delete'), danger: true });
      if (!ok) return;
      pending = null;
      try { await deleteNote(note.id); currentId = null; toast(t('notes.deleted')); app().navigate('notesView'); } catch { toast(t('v3.deleteError'), { kind: 'error' }); }
    } else if (a === 'add-link') {
      openLibraryEditor({ data, onSaved: () => render() });
    } else if (a === 'edit-link' || a === 'toggle-fav' || a === 'delete-link') {
      const id = el.closest('[data-resource-id]').dataset.resourceId;
      const r = data.resources.find((x) => x.id === id);
      if (!r) return;
      if (a === 'edit-link') openLibraryEditor({ data, resource: r, onSaved: () => render() });
      else if (a === 'toggle-fav') {
        try { await updateResource(r.id, { favorite: !r.favorite }); await render(); root.querySelector(`[data-resource-id="${r.id}"] [data-action="toggle-fav"]`)?.focus(); } catch { toast(t('v3.saveError'), { kind: 'error' }); }
      } else {
        const ok = await confirmAction({ title: t('resources.removeTitle'), message: t('resources.removeBody'), confirmLabel: t('resources.remove'), danger: true });
        if (!ok) return;
        try { await deleteResource(r.id); await render(); } catch { toast(t('v3.deleteError'), { kind: 'error' }); }
      }
    } else if (a === 'lib-favs') {
      lib = { ...lib, favorites: !lib.favorites };
      paint('[data-action="lib-favs"]');
    }
  });

  onChange((topic) => {
    if (!root.hidden && ['notes', 'resources', 'spaces', 'courses', 'projects', 'goals'].includes(topic)) render();
  });
  window.addEventListener('beforeunload', () => { if (pending) flushSave(); });
  window.addEventListener('hashchange', () => { if (pending) flushSave(); });
  try { const v = localStorage.getItem(VIEW_KEY); if (['all', 'pinned', 'archived'].includes(v)) filters.view = v; } catch { /* per-viewer */ }

  return {
    onShow: (param) => render(param === undefined ? null : param),
    onHide: () => flushSave(),
    newNote,
  };
}

/** Badge-ready summary for other pages: notes linked to something. */
export function linkedNotes(notes, kind, id) {
  return sortNotes((notes || []).filter((n) => !n.archived && n[kind] === id));
}
