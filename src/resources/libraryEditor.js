// Add / edit a saved link (V4-H) — used by the Library and by the project,
// goal and exam pages. A link can belong to one course, project, goal or
// exam, or be a general "My library" link. Links only: validated http(s),
// opened with rel="noopener noreferrer".

import { openDrawer } from '../ui/drawer.js';
import { h } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { t } from '../shared/i18n.js';
import { app } from '../app/context.js';
import { has } from '../shared/capabilities.js';
import { validateResourceFields, RESOURCE_KINDS, RESOURCE_KINDS_V4 } from './resourceModel.js';
import { createResource, updateResource } from './resourcesData.js';
import { cleanTags } from '../notes/noteModel.js';

const PARENTS = [['course_id', 'courses'], ['project_id', 'projects'], ['goal_id', 'goals'], ['exam_id', 'exams']];

function field(id, labelKey, control, hint = '') {
  const wrap = h('div', { class: 'field' }, h('label', { for: id }, t(labelKey)), control);
  if (hint) wrap.appendChild(h('p', { class: 'field-hint' }, hint));
  return wrap;
}

/**
 * @param {object} p
 * @param {object} p.data      { courses, projects, goals, exams }
 * @param {object} [p.resource] existing link to edit
 * @param {{ kind: string, id: string }} [p.parent] preselected owner (e.g. from a project page)
 */
export function openLibraryEditor({ data = {}, resource = null, parent = null, onSaved } = {}) {
  const v4 = has('resourcesV4');
  const isNew = !resource;
  const currentParent = resource
    ? (PARENTS.find(([k]) => resource[k]) || [])[0] || (resource.in_library ? '' : null)
    : parent ? parent.kind : '';
  openDrawer({
    title: isNew ? t('library.addTitle') : t('library.editTitle'),
    size: 'narrow',
    render: (body) => {
      body.appendChild(field('lib-url', 'resources.url', h('input', { type: 'url', id: 'lib-url', inputmode: 'url', 'data-autofocus': true, value: resource ? resource.url : '', placeholder: 'https://', 'aria-describedby': 'lib-error' })));
      body.appendChild(field('lib-title', 'resources.title', h('input', { type: 'text', id: 'lib-title', maxlength: '200', value: resource ? resource.title : '', placeholder: t('resources.titlePlaceholder') })));
      const kind = h('select', { id: 'lib-kind' });
      (v4 ? RESOURCE_KINDS_V4 : RESOURCE_KINDS).forEach((k) => kind.appendChild(h('option', { value: k }, t(`resources.kind_${k}`))));
      kind.value = resource ? resource.kind : 'link';
      body.appendChild(field('lib-kind', 'resources.kind', kind));
      // Where it belongs (task links are managed from their task).
      if (!resource || !resource.task_id) {
        const sel = h('select', { id: 'lib-parent' });
        if (v4) sel.appendChild(h('option', { value: '' }, t('library.general')));
        PARENTS.forEach(([k, coll]) => {
          if (!v4 && k !== 'course_id') return;
          const list = (data[coll] || []).filter((x) => !x.archived && x.status !== 'archived');
          if (!list.length) return;
          const group = h('optgroup', { label: t(`notes.linkGroup_${k}`) });
          list.forEach((x) => group.appendChild(h('option', { value: `${k}:${x.id}` }, x.code || x.title || x.name)));
          sel.appendChild(group);
        });
        const pre = resource ? (currentParent ? `${currentParent}:${resource[currentParent]}` : '') : parent ? `${parent.kind}:${parent.id}` : '';
        sel.value = pre;
        if (!sel.value && sel.options.length) sel.selectedIndex = 0;
        body.appendChild(field('lib-parent', 'library.belongsTo', sel, v4 ? '' : t('library.v3Note')));
      }
      if (v4) {
        body.appendChild(field('lib-tags', 'library.tags', h('input', { type: 'text', id: 'lib-tags', value: resource ? (resource.tags || []).join(', ') : '', placeholder: t('notes.tagsPlaceholder') })));
        const fav = h('input', { type: 'checkbox', id: 'lib-fav' });
        fav.checked = Boolean(resource && resource.favorite);
        body.appendChild(h('div', { class: 'checkbox-row' }, fav, h('label', { for: 'lib-fav' }, t('library.favorite'))));
      }
      const notes = h('textarea', { id: 'lib-notes', rows: '2', maxlength: '2000' });
      notes.value = resource ? resource.notes || '' : '';
      body.appendChild(field('lib-notes', 'common.notes', notes));
      body.appendChild(h('p', { class: 'field-error', id: 'lib-error', role: 'alert' }));
      body.appendChild(h('p', { class: 'field-hint' }, t('resources.linksOnly')));
    },
    actions: [
      { label: t('common.cancel'), variant: 'secondary', onClick: (api) => api.close() },
      {
        label: isNew ? t('resources.add') : t('common.save'),
        variant: 'primary',
        onClick: async (api) => {
          const b = api.body;
          const v = validateResourceFields({ url: b.querySelector('#lib-url').value, title: b.querySelector('#lib-title').value, kind: b.querySelector('#lib-kind').value, notes: b.querySelector('#lib-notes').value });
          const err = b.querySelector('#lib-error');
          b.querySelector('#lib-url').setAttribute('aria-invalid', v.ok ? 'false' : 'true');
          if (!v.ok) {
            err.textContent = t(v.errors.url || v.errors.title);
            b.querySelector('#lib-url').focus();
            return;
          }
          const fields = { ...v.fields };
          const parentSel = b.querySelector('#lib-parent');
          if (parentSel) {
            const [k, id] = parentSel.value ? parentSel.value.split(':') : ['', ''];
            PARENTS.forEach(([pk]) => { fields[pk] = pk === k ? id : null; });
            if (!v4 && !k) {
              err.textContent = t('library.pickCourse');
              parentSel.focus();
              return;
            }
            fields.in_library = !k;
          }
          if (v4) {
            fields.tags = cleanTags(b.querySelector('#lib-tags').value);
            fields.favorite = b.querySelector('#lib-fav').checked;
          }
          api.setBusy(true);
          try {
            if (isNew) await createResource(app().userId, { task_id: null, ...fields });
            else await updateResource(resource.id, fields);
            api.close(true);
            toast(isNew ? t('resources.added') : t('common.savedShort'), { kind: 'success' });
            if (onSaved) onSaved();
          } catch (e) {
            console.error(e);
            api.setBusy(false);
            err.textContent = t('v3.saveError');
          }
        },
      },
    ],
  });
}
