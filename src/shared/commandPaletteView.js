// Command palette UI (V2-F) — one small dialog used for both Ctrl/Cmd+K and
// the Quick Add (+) button. It owns no business logic: the host passes a
// getCommands() function returning { id, title, hint?, keywords?, group,
// run } objects whose run() calls an EXISTING handler (Add study task,
// New Board, open a view, ...). Matching lives in ./commandPalette.js.

import { filterCommands, moveSelection } from './commandPalette.js';

// @param {object} opts
// @param {(mode:string) => object[]} opts.getCommands — mode is 'all' or 'create'
// @param {(key:string) => string} opts.t — i18n lookup
export function initCommandPalette({ getCommands, t }) {
  let overlay = null;
  let input = null;
  let listEl = null;
  let titleEl = null;
  let mode = 'all';
  let commands = [];
  let results = [];
  let selected = -1;
  let returnFocusTo = null;

  const GROUP_KEYS = {
    create: 'palette.groupCreate', navigate: 'palette.groupGo', tasks: 'palette.groupTasks',
    // V3 groups
    commands: 'search.groupCommands', courses: 'search.groupCourses', exams: 'search.groupExams',
    classes: 'search.groupClasses', boards: 'search.groupBoards', settings: 'search.groupSettings',
    // V4
    spaces: 'search.groupSpaces',
    projects: 'search.groupProjects',
    goals: 'search.groupGoals',
    routines: 'search.groupRoutines',
  };

  function build() {
    overlay = document.createElement('div');
    overlay.className = 'palette-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="palette" role="dialog" aria-modal="true" aria-labelledby="paletteTitle">
        <h2 class="sr-only" id="paletteTitle"></h2>
        <div class="palette-input-row">
          <span class="palette-search-icon" aria-hidden="true">⌕</span>
          <input type="text" class="palette-input" role="combobox" aria-expanded="true" aria-controls="paletteList" aria-autocomplete="list" autocomplete="off" spellcheck="false">
          <kbd class="palette-esc">Esc</kbd>
        </div>
        <ul class="palette-list" id="paletteList" role="listbox"></ul>
      </div>
    `;
    document.body.appendChild(overlay);
    input = overlay.querySelector('.palette-input');
    listEl = overlay.querySelector('.palette-list');
    titleEl = overlay.querySelector('#paletteTitle');

    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close();
    });
    input.addEventListener('input', () => {
      selected = -1;
      update();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        selected = moveSelection(selected, e.key === 'ArrowDown' ? 1 : -1, results.length);
        renderSelection();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        runAt(selected >= 0 ? selected : 0);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'Tab') {
        e.preventDefault(); // keep focus inside the dialog
      }
    });
    listEl.addEventListener('mousemove', (e) => {
      const li = e.target.closest('.palette-item');
      if (!li) return;
      const index = Number(li.dataset.index);
      if (index !== selected) {
        selected = index;
        renderSelection();
      }
    });
    listEl.addEventListener('click', (e) => {
      const li = e.target.closest('.palette-item');
      if (li) runAt(Number(li.dataset.index));
    });
  }

  function update() {
    results = filterCommands(commands, input.value, 40);
    if (selected < 0 && results.length > 0) selected = 0;
    listEl.innerHTML = '';
    if (results.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'palette-empty';
      empty.textContent = t('palette.noResults');
      listEl.appendChild(empty);
      input.removeAttribute('aria-activedescendant');
      return;
    }
    // Group headers only when not searching (results are then in the
    // caller's order, so groups are contiguous).
    const showGroups = !input.value.trim();
    let lastGroup = null;
    results.forEach((cmd, index) => {
      if (showGroups && cmd.group && cmd.group !== lastGroup) {
        const head = document.createElement('li');
        head.className = 'palette-group';
        head.setAttribute('role', 'presentation');
        head.textContent = t(GROUP_KEYS[cmd.group] || 'palette.groupGo');
        listEl.appendChild(head);
        lastGroup = cmd.group;
      }
      const li = document.createElement('li');
      li.className = 'palette-item';
      li.id = `palette-opt-${index}`;
      li.dataset.index = String(index);
      li.setAttribute('role', 'option');
      const title = document.createElement('span');
      title.className = 'palette-item-title';
      title.textContent = cmd.title;
      li.appendChild(title);
      if (cmd.hint) {
        const hint = document.createElement('span');
        hint.className = 'palette-item-hint';
        hint.textContent = cmd.hint;
        li.appendChild(hint);
      }
      listEl.appendChild(li);
    });
    renderSelection();
  }

  function renderSelection() {
    listEl.querySelectorAll('.palette-item').forEach((li) => {
      const on = Number(li.dataset.index) === selected;
      li.classList.toggle('is-selected', on);
      li.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) li.scrollIntoView({ block: 'nearest' });
    });
    if (selected >= 0) input.setAttribute('aria-activedescendant', `palette-opt-${selected}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function runAt(index) {
    const cmd = results[index];
    if (!cmd) return;
    close({ restoreFocus: false });
    try {
      const out = cmd.run();
      if (out && typeof out.catch === 'function') out.catch((err) => console.error('Command failed:', err));
    } catch (err) {
      console.error('Command failed:', err);
    }
  }

  function open(openMode = 'all') {
    if (!overlay) build();
    mode = openMode;
    commands = getCommands(mode) || [];
    returnFocusTo = document.activeElement;
    titleEl.textContent = t(mode === 'create' ? 'palette.quickAddTitle' : 'palette.title');
    input.placeholder = t(mode === 'create' ? 'palette.quickAddPlaceholder' : 'palette.placeholder');
    input.setAttribute('aria-label', input.placeholder);
    input.value = '';
    selected = -1;
    overlay.hidden = false;
    document.body.classList.add('palette-open');
    update();
    input.focus();
  }

  function close({ restoreFocus = true } = {}) {
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    document.body.classList.remove('palette-open');
    if (restoreFocus && returnFocusTo && typeof returnFocusTo.focus === 'function') returnFocusTo.focus();
  }

  return { open, close, isOpen: () => Boolean(overlay && !overlay.hidden) };
}
