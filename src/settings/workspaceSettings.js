// Settings › Workspace (V4-A): what the app is used for (mode), which pages
// appear in the sidebar, spaces, and the default space for new items.

import { t, tCount } from '../shared/i18n.js';
import { html, raw, setHtml, h, safeColor } from '../ui/dom.js';
import { button, migrationNotice, errorNotice } from '../ui/components.js';
import { openDrawer, confirmAction } from '../ui/drawer.js';
import { toast } from '../ui/toast.js';
import { icon } from '../ui/icons.js';
import { app } from '../app/context.js';
import { has, probeCapabilities } from '../shared/capabilities.js';
import { MODES, MODULES, SECTIONS, isLegacyWorkspace, isModuleEnabled, withMode, withModule, normalizeWorkspace } from '../workspace/modules.js';
import { SPACE_ICONS, SPACE_COLORS, validateSpaceFields, sortSpaces, coursesToAssign } from '../workspace/spacesModel.js';
import { loadWorkspace, saveWorkspace, listSpaces, createSpace, updateSpace, assignCoursesToSpace } from '../workspace/workspaceData.js';
import { listCourses } from '../academics/academicsData.js';

const MODE_ICON = { school: 'school', work: 'briefcase', personal: 'home', selfstudy: 'book', multiple: 'sliders' };

async function persist(ws, message) {
  try {
    await saveWorkspace(app().userId, ws);
    if (message) toast(message, { kind: 'success' });
    return true;
  } catch (err) {
    console.error('Could not save workspace', err);
    toast(t('settings3.saveFailed'), { kind: 'error' });
    return false;
  }
}

export async function renderWorkspace(root) {
  setHtml(root, html`<h2>${t('workspace.title')}</h2><p class="hint">${t('common.loading')}</p>`);
  await probeCapabilities();
  const userId = app().userId;
  let ws;
  let spaces = [];
  let courses = [];
  try {
    [ws, spaces, courses] = await Promise.all([
      loadWorkspace(userId),
      has('spaces') ? listSpaces(userId) : [],
      has('courses') ? listCourses(userId).catch(() => []) : [],
    ]);
  } catch (err) {
    setHtml(root, html`<h2>${t('workspace.title')}</h2>${errorNotice(err.message)}`);
    return;
  }
  ws = normalizeWorkspace(ws);
  const legacy = isLegacyWorkspace(ws);
  const sorted = sortSpaces(spaces);
  const active = sorted.filter((s) => !s.archived);
  const unplaced = active.length ? coursesToAssign(courses.filter((c) => !c.archived), active[0].id) : [];

  setHtml(root, html`
    <h2>${t('workspace.title')}</h2>
    <p class="hint">${t('workspace.hint')}</p>

    <h3 class="settings3-subhead" id="wsModeHead">${t('workspace.modeTitle')}</h3>
    ${legacy ? html`<p class="hint">${t('workspace.legacyNote')}</p>` : ''}
    <div class="ws-modes" role="radiogroup" aria-labelledby="wsModeHead">
      ${MODES.map((m) => html`<label class="ws-mode${ws.mode === m ? ' is-on' : ''}">
        <input type="radio" name="wsMode" value="${m}"${ws.mode === m ? raw(' checked') : ''}>
        <span class="ws-mode-icon" aria-hidden="true">${raw(icon(MODE_ICON[m]))}</span>
        <span class="ws-mode-text"><strong>${t(`workspace.mode_${m}`)}</strong><span>${t(`workspace.mode_${m}Hint`)}</span></span>
      </label>`)}
    </div>

    <h3 class="settings3-subhead" id="wsModulesHead">${t('workspace.modulesTitle')}</h3>
    <p class="hint">${t('workspace.modulesHint')}</p>
    <div class="ws-modules" role="group" aria-labelledby="wsModulesHead">
      ${SECTIONS.map((sec) => {
        const mods = MODULES.filter((m) => m.section === sec && m.built);
        if (!mods.length) return '';
        return html`<fieldset class="ws-module-group">
          <legend>${t(`nav.section${sec[0].toUpperCase()}${sec.slice(1)}`)}</legend>
          ${mods.map((m) => html`<label class="ws-module">
            <input type="checkbox" data-module-toggle="${m.id}"${isModuleEnabled(ws, m.id) ? raw(' checked') : ''}${m.core ? raw(' disabled') : ''}>
            <span>${t(m.labelKey)}</span>${m.core ? html`<span class="muted ws-core">${t('workspace.always')}</span>` : ''}
          </label>`)}
        </fieldset>`;
      })}
    </div>

    <h3 class="settings3-subhead">${t('spaces.title')}</h3>
    <p class="hint">${t('spaces.hint')}</p>
    ${!has('spaces') ? migrationNotice('spaces') : html`
      ${sorted.length ? html`<ul class="ws-spaces">
        ${sorted.map((s) => html`<li class="ws-space${s.archived ? ' is-archived' : ''}">
          <span class="ws-space-icon" style="--c:${safeColor(s.color, '#8a91a0')}" aria-hidden="true">${raw(icon(SPACE_ICONS.includes(s.icon) ? s.icon : 'circle'))}</span>
          <span class="ws-space-name">${s.name}${s.archived ? html` <span class="muted">· ${t('spaces.archived')}</span>` : ''}</span>
          ${button(t('common.edit'), { size: 'sm', variant: 'ghost', attrs: `data-space-edit="${s.id}"` })}
          ${button(s.archived ? t('spaces.restore') : t('spaces.archive'), { size: 'sm', variant: 'ghost', attrs: `data-space-archive="${s.id}"` })}
        </li>`)}
      </ul>` : html`<p class="hint">${t('spaces.empty')}</p>`}
      <div class="settings-btn-row">${button(t('spaces.new'), { action: 'space-new', iconName: 'plus' })}</div>

      ${active.length ? html`
        <h3 class="settings3-subhead">${t('spaces.defaultTitle')}</h3>
        <label class="sr-only" for="wsDefaultSpace">${t('spaces.defaultTitle')}</label>
        <select id="wsDefaultSpace" class="settings-narrow-select">
          <option value="">${t('spaces.noDefault')}</option>
          ${active.map((s) => html`<option value="${s.id}"${ws.defaultSpaceId === s.id ? raw(' selected') : ''}>${s.name}</option>`)}
        </select>
        <p class="hint">${t('spaces.defaultHint')}</p>` : ''}

      ${unplaced.length ? html`
        <h3 class="settings3-subhead">${t('spaces.assignTitle')}</h3>
        <p class="hint">${tCount('spaces.assignHint', unplaced.length)}</p>
        <div class="settings3-inline-form">
          <label class="sr-only" for="wsAssignTarget">${t('spaces.assignTarget')}</label>
          <select id="wsAssignTarget" class="settings-narrow-select">${active.map((s) => html`<option value="${s.id}">${s.name}</option>`)}</select>
          ${button(t('spaces.assignAction'), { size: 'sm', action: 'space-assign' })}
        </div>` : ''}
    `}
  `);

  // ---- mode ----
  root.querySelectorAll('input[name="wsMode"]').forEach((input) => input.addEventListener('change', async () => {
    if (await persist(withMode(ws, input.value), t('workspace.saved'))) renderWorkspace(root);
  }));
  // ---- modules ----
  root.querySelectorAll('[data-module-toggle]').forEach((box) => box.addEventListener('change', async () => {
    ws = withModule(ws, box.dataset.moduleToggle, box.checked);
    await persist(ws, null);
    box.focus();
  }));
  // ---- spaces ----
  root.querySelector('[data-action="space-new"]')?.addEventListener('click', () => openSpaceEditor(null, () => renderWorkspace(root)));
  root.querySelectorAll('[data-space-edit]').forEach((b) => b.addEventListener('click', () => {
    openSpaceEditor(sorted.find((s) => s.id === b.dataset.spaceEdit), () => renderWorkspace(root));
  }));
  root.querySelectorAll('[data-space-archive]').forEach((b) => b.addEventListener('click', async () => {
    const sp = sorted.find((s) => s.id === b.dataset.spaceArchive);
    try {
      await updateSpace(sp.id, { archived: !sp.archived });
      toast(sp.archived ? t('spaces.restored') : t('spaces.archivedToast'), { kind: 'success' });
      renderWorkspace(root);
    } catch (err) {
      console.error(err);
      toast(t('settings3.saveFailed'), { kind: 'error' });
    }
  }));
  root.querySelector('#wsDefaultSpace')?.addEventListener('change', async (e) => {
    ws = { ...ws, defaultSpaceId: e.target.value || null };
    await persist(ws, t('workspace.saved'));
  });
  root.querySelector('[data-action="space-assign"]')?.addEventListener('click', async () => {
    const target = root.querySelector('#wsAssignTarget').value;
    const sp = active.find((s) => s.id === target);
    const list = coursesToAssign(courses.filter((c) => !c.archived), target);
    const names = list.slice(0, 6).map((c) => c.code || c.name).join(', ') + (list.length > 6 ? '…' : '');
    const ok = await confirmAction({
      title: t('spaces.assignConfirmTitle').replace('{space}', sp ? sp.name : ''),
      message: `${tCount('spaces.assignConfirmBody', list.length)} ${names}`,
      confirmLabel: t('spaces.assignAction'),
    });
    if (!ok) return;
    try {
      const n = await assignCoursesToSpace(list.map((c) => c.id), target);
      toast(tCount('spaces.assignDone', n), { kind: 'success' });
      renderWorkspace(root);
    } catch (err) {
      console.error(err);
      toast(t('settings3.saveFailed'), { kind: 'error' });
    }
  });
}

export function openSpaceEditor(space, onSaved) {
  const isNew = !space;
  let iconKey = space && SPACE_ICONS.includes(space.icon) ? space.icon : 'circle';
  let color = space ? space.color || null : SPACE_COLORS[0];
  openDrawer({
    title: isNew ? t('spaces.newTitle') : t('spaces.editTitle'),
    size: 'narrow',
    render: (body) => {
      const name = h('input', { type: 'text', id: 'sp-name', maxlength: '60', autocomplete: 'off', 'data-autofocus': true, value: space ? space.name : '', placeholder: t('spaces.namePlaceholder') });
      body.appendChild(h('div', { class: 'field' }, h('label', { for: 'sp-name' }, t('spaces.fieldName')), name, h('p', { class: 'field-error', id: 'sp-name-error', role: 'alert' })));

      const icons = h('div', { class: 'ws-icon-grid', role: 'radiogroup', 'aria-label': t('spaces.fieldIcon') });
      SPACE_ICONS.forEach((key) => {
        const b = h('button', { type: 'button', class: 'ws-icon-btn', role: 'radio', 'aria-checked': key === iconKey ? 'true' : 'false', 'aria-label': t(`spaces.icon_${key}`), 'data-tip': t(`spaces.icon_${key}`) });
        b.innerHTML = icon(key);
        b.addEventListener('click', () => {
          iconKey = key;
          icons.querySelectorAll('.ws-icon-btn').forEach((x) => x.setAttribute('aria-checked', x === b ? 'true' : 'false'));
        });
        icons.appendChild(b);
      });
      body.appendChild(h('div', { class: 'field' }, h('span', { class: 'field-label' }, t('spaces.fieldIcon')), icons));

      const colors = h('div', { class: 'ws-color-row', role: 'radiogroup', 'aria-label': t('spaces.fieldColor') });
      [null, ...SPACE_COLORS].forEach((c) => {
        const b = h('button', { type: 'button', class: `ws-color${c ? '' : ' is-none'}`, role: 'radio', style: c ? { '--c': c } : null, 'aria-checked': c === color ? 'true' : 'false', 'aria-label': c ? `${t('spaces.fieldColor')} ${c}` : t('spaces.noColor') });
        b.addEventListener('click', () => {
          color = c;
          colors.querySelectorAll('.ws-color').forEach((x) => x.setAttribute('aria-checked', x === b ? 'true' : 'false'));
        });
        colors.appendChild(b);
      });
      body.appendChild(h('div', { class: 'field' }, h('span', { class: 'field-label' }, t('spaces.fieldColor')), colors));
    },
    actions: [
      { label: t('common.cancel'), onClick: (api) => api.close() },
      {
        label: isNew ? t('spaces.create') : t('common.save'),
        variant: 'primary',
        onClick: async (api) => {
          const v = validateSpaceFields({ name: api.body.querySelector('#sp-name').value, icon: iconKey, color });
          const err = api.body.querySelector('#sp-name-error');
          err.textContent = v.errors.name ? t(v.errors.name) : '';
          api.body.querySelector('#sp-name').setAttribute('aria-invalid', v.ok ? 'false' : 'true');
          if (!v.ok) {
            api.body.querySelector('#sp-name').focus();
            return;
          }
          api.setBusy(true);
          try {
            if (isNew) await createSpace(app().userId, v.fields);
            else await updateSpace(space.id, v.fields);
            api.close(true);
            toast(isNew ? t('spaces.created') : t('common.savedShort'), { kind: 'success' });
            if (onSaved) onSaved();
          } catch (e) {
            console.error('Could not save space', e);
            err.textContent = t('settings3.saveFailed');
            api.setBusy(false);
          }
        },
      },
    ],
  });
}
