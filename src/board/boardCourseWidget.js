// Course Overview -> "Projects & boards" (V3-J): the boards linked to a
// course, each opening straight into the Board view.

import { t } from '../shared/i18n.js';
import { has } from '../shared/capabilities.js';
import { app } from '../app/context.js';
import { html, raw } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { listBoards } from './boardData.js';
import { registerCourseOverviewWidget } from '../courses/courseTabs.js';

const LAST_BOARD_STORAGE_KEY = 'student-scheduler-last-board-id'; // same key board.js remembers

export function openBoard(boardId) {
  try { localStorage.setItem(LAST_BOARD_STORAGE_KEY, boardId); } catch { /* still opens the Board view */ }
  app().navigate('boardView');
}

registerCourseOverviewWidget({
  id: 'boards',
  order: 20,
  slot: 'main',
  async render({ course }) {
    if (!has('boardCourseLinks')) return '';
    const boards = (await listBoards(app().userId)).filter((b) => b.course_id === course.id);
    if (!boards.length) return '';
    return html`<section class="card">
      <div class="card-head"><h2 class="card-title">${t('board3.courseBoards')}</h2></div>
      <div class="list">${boards.map((b) => html`<button type="button" class="list-row" data-open-board="${b.id}">
        <span class="resource-icon" aria-hidden="true">${raw(icon('board'))}</span>
        <span class="list-row-main"><span class="list-row-title">${b.title}</span></span>
        <span class="list-row-side">${raw(icon('chevronRight'))}</span>
      </button>`)}</div>
    </section>`;
  },
});

document.addEventListener('click', (e) => {
  const btn = e.target instanceof Element ? e.target.closest('[data-open-board]') : null;
  if (btn) openBoard(btn.dataset.openBoard);
});
