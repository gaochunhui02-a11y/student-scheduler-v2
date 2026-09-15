// Visual Board client controller — owns all #boardView DOM, all board_nodes
// dragging, and all Board Supabase calls (via boardData.js). Completely
// isolated from src/dashboard/dashboard.js: no scheduling state is read or
// written here, and dashboard.js only ever calls initBoardSection(userId)
// and the returned onShow(); it never reaches into this module's internals.
//
// Native Pointer Events only (pointerdown/pointermove/pointerup) — no drag
// or canvas library. That's enough for free-form dragging on a large,
// scrollable canvas, and keeps this feature from pulling in a dependency
// just for itself.

import { t } from '../shared/i18n.js';
import { NODE_TYPES, createNodeDefaults, computeDragPosition } from './boardModel.js';
import { listBoards, createBoard, loadBoard, renameBoard, createNode, updateNode, deleteNode } from './boardData.js';

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.1;

export function initBoardSection(userId) {
  const boardView = document.getElementById('boardView');
  if (!boardView) return null;

  const titleInput = document.getElementById('boardTitleInput');
  const addNodeBtn = document.getElementById('boardAddNodeBtn');
  const zoomInBtn = document.getElementById('boardZoomInBtn');
  const zoomOutBtn = document.getElementById('boardZoomOutBtn');
  const zoomResetBtn = document.getElementById('boardZoomResetBtn');
  const zoomLabel = document.getElementById('boardZoomLabel');
  const workspace = document.getElementById('boardWorkspace');
  const canvas = document.getElementById('boardCanvas');
  const emptyState = document.getElementById('boardEmptyState');
  const noBoardState = document.getElementById('boardNoBoardState');
  const createBoardBtn = document.getElementById('boardCreateBtn');

  let currentBoard = null;
  let nodes = [];
  let zoom = 1;
  let loaded = false;
  let loading = false;

  function applyZoom() {
    canvas.style.transform = `scale(${zoom})`;
    if (zoomLabel) zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  }

  function setZoom(next) {
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 100) / 100));
    applyZoom();
  }

  if (zoomInBtn) zoomInBtn.addEventListener('click', () => setZoom(zoom + ZOOM_STEP));
  if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => setZoom(zoom - ZOOM_STEP));
  if (zoomResetBtn) zoomResetBtn.addEventListener('click', () => setZoom(1));

  // Stops a drag from starting when the pointer went down on an interactive
  // control inside the node card (the type select, the delete button, or
  // the title textarea) rather than the card itself.
  function stopDragStart(el) {
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  function wireDrag(cardEl, node) {
    let dragging = false;
    let pointerStartX = 0;
    let pointerStartY = 0;
    let nodeStartX = 0;
    let nodeStartY = 0;

    function currentPosition(e) {
      return computeDragPosition({
        nodeStartX,
        nodeStartY,
        pointerStartX,
        pointerStartY,
        pointerCurrentX: e.clientX,
        pointerCurrentY: e.clientY,
        zoom,
      });
    }

    cardEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      dragging = true;
      cardEl.classList.add('dragging');
      pointerStartX = e.clientX;
      pointerStartY = e.clientY;
      nodeStartX = node.x_position;
      nodeStartY = node.y_position;
      cardEl.setPointerCapture(e.pointerId);
    });

    cardEl.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const { x_position, y_position } = currentPosition(e);
      cardEl.style.left = `${x_position}px`;
      cardEl.style.top = `${y_position}px`;
    });

    async function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      cardEl.classList.remove('dragging');
      const { x_position, y_position } = currentPosition(e);
      node.x_position = x_position;
      node.y_position = y_position;
      try {
        await updateNode(userId, node.id, { x: x_position, y: y_position });
      } catch (err) {
        console.error('Could not save node position:', err);
      }
    }

    cardEl.addEventListener('pointerup', endDrag);
    cardEl.addEventListener('pointercancel', endDrag);
  }

  function buildNodeEl(node) {
    const el = document.createElement('div');
    el.className = 'board-node';
    el.dataset.nodeId = node.id;
    el.dataset.nodeType = node.node_type;
    el.style.left = `${node.x_position}px`;
    el.style.top = `${node.y_position}px`;

    const head = document.createElement('div');
    head.className = 'board-node-head';

    const typeSelect = document.createElement('select');
    typeSelect.className = 'board-node-type';
    typeSelect.setAttribute('aria-label', t('board.nodeTypeLabel'));
    typeSelect.dataset.i18nAriaLabel = 'board.nodeTypeLabel';
    NODE_TYPES.forEach((nt) => {
      const opt = document.createElement('option');
      opt.value = nt;
      opt.dataset.i18n = `nodeType.${nt}`;
      opt.textContent = t(`nodeType.${nt}`);
      if (nt === node.node_type) opt.selected = true;
      typeSelect.appendChild(opt);
    });
    typeSelect.addEventListener('change', async () => {
      const nextType = typeSelect.value;
      node.node_type = nextType;
      el.dataset.nodeType = nextType;
      try {
        await updateNode(userId, node.id, { nodeType: nextType });
      } catch (err) {
        console.error('Could not save node type:', err);
      }
    });
    stopDragStart(typeSelect);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'board-node-delete';
    deleteBtn.textContent = '×';
    deleteBtn.setAttribute('aria-label', t('board.deleteNode'));
    deleteBtn.dataset.i18nAriaLabel = 'board.deleteNode';
    deleteBtn.addEventListener('click', async () => {
      try {
        await deleteNode(userId, node.id);
        nodes = nodes.filter((n) => n.id !== node.id);
        renderNodes();
      } catch (err) {
        console.error('Could not delete node:', err);
      }
    });
    stopDragStart(deleteBtn);

    head.appendChild(typeSelect);
    head.appendChild(deleteBtn);

    const textarea = document.createElement('textarea');
    textarea.className = 'board-node-title';
    textarea.rows = 3;
    textarea.value = node.title || '';
    textarea.placeholder = t('board.nodeTitlePlaceholder');
    textarea.dataset.i18nPlaceholder = 'board.nodeTitlePlaceholder';
    textarea.addEventListener('change', async () => {
      node.title = textarea.value;
      try {
        await updateNode(userId, node.id, { title: textarea.value });
      } catch (err) {
        console.error('Could not save node title:', err);
      }
    });
    stopDragStart(textarea);

    el.appendChild(head);
    el.appendChild(textarea);

    wireDrag(el, node);

    return el;
  }

  function renderNodes() {
    canvas.querySelectorAll('.board-node').forEach((el) => el.remove());
    nodes.forEach((node) => canvas.appendChild(buildNodeEl(node)));
    if (emptyState) emptyState.hidden = nodes.length > 0;
  }

  function showNoBoardState() {
    if (workspace) workspace.hidden = true;
    if (noBoardState) noBoardState.hidden = false;
    if (titleInput) titleInput.value = '';
  }

  function showWorkspaceState() {
    if (noBoardState) noBoardState.hidden = true;
    if (workspace) workspace.hidden = false;
  }

  if (addNodeBtn) {
    addNodeBtn.addEventListener('click', async () => {
      if (!currentBoard) return;
      const defaults = createNodeDefaults(nodes.length, 'note');
      try {
        const created = await createNode(userId, currentBoard.id, {
          nodeType: defaults.node_type,
          title: defaults.title,
          x: defaults.x_position,
          y: defaults.y_position,
        });
        nodes.push(created);
        renderNodes();
      } catch (err) {
        console.error('Could not create node:', err);
      }
    });
  }

  if (createBoardBtn) {
    createBoardBtn.addEventListener('click', async () => {
      try {
        currentBoard = await createBoard(userId, 'Untitled board');
        nodes = [];
        if (titleInput) titleInput.value = currentBoard.title;
        showWorkspaceState();
        renderNodes();
      } catch (err) {
        console.error('Could not create board:', err);
      }
    });
  }

  if (titleInput) {
    titleInput.addEventListener('change', async () => {
      if (!currentBoard) return;
      const nextTitle = titleInput.value.trim() || 'Untitled board';
      titleInput.value = nextTitle;
      try {
        currentBoard = await renameBoard(userId, currentBoard.id, nextTitle);
      } catch (err) {
        console.error('Could not rename board:', err);
      }
    });
  }

  applyZoom();

  // Lazy-loaded the first time the Board nav item is clicked, so a user who
  // never opens the Board never pays for a boards/nodes/edges round trip.
  async function onShow() {
    if (loaded || loading) return;
    loading = true;
    try {
      const boards = await listBoards(userId);
      if (!boards || boards.length === 0) {
        showNoBoardState();
        loaded = true;
        return;
      }
      currentBoard = boards[0];
      if (titleInput) titleInput.value = currentBoard.title;
      showWorkspaceState();
      const data = await loadBoard(userId, currentBoard.id);
      nodes = data ? data.nodes : [];
      renderNodes();
      loaded = true;
    } catch (err) {
      console.error('Could not load board:', err);
    } finally {
      loading = false;
    }
  }

  return { onShow };
}
