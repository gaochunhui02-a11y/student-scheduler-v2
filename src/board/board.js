// Visual Board client controller — owns all #boardView DOM, all board_nodes
// dragging, and all Board Supabase calls (via boardData.js). Completely
// isolated from src/dashboard/dashboard.js: no scheduling state is read or
// written here, and dashboard.js only ever calls initBoardSection(userId,
// hostApi) and the returned onShow(); it never reaches into this module's
// internals.
//
// The one intentional bridge to the scheduler's data is "Add to Planner"
// (Phase 5): this file never imports src/dashboard/data.js and never talks
// to the study_subjects table directly — it calls the small `hostApi`
// object dashboard.js passes in (getActiveScheduleId/
// createStudyTaskFromBoard/viewInPlanner), which itself routes through the
// EXISTING insertStudySubject + addStudyRow code path. No second study-task
// system is created here.
//
// Native Pointer Events only (pointerdown/pointermove/pointerup) — no drag
// or canvas library. That's enough for free-form dragging on a large,
// scrollable canvas, and keeps this feature from pulling in a dependency
// just for itself.

import { t } from '../shared/i18n.js';
import {
  NODE_TYPES,
  createNodeDefaults,
  computeDragPosition,
  computeEdgeGeometry,
  edgeMidpoint,
  screenToCanvasPoint,
  isSelfEdge,
  isDuplicateEdge,
  removeEdgesForNode,
  removeEdgeById,
  studyTaskDefaultsFromNode,
  buildStudyTaskFields,
  isStudyTaskFieldsValid,
  isNodeConverted,
  canConvertNode,
  linkNodeToStudyTask,
} from './boardModel.js';
import {
  listBoards,
  createBoard,
  loadBoard,
  renameBoard,
  createNode,
  updateNode,
  deleteNode,
  createEdge,
  deleteEdge,
} from './boardData.js';

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.1;

// Nominal card size used only for edge-anchor math (see computeEdgeGeometry
// in boardModel.js) — matches .board-node's CSS width; height is an
// approximation since card height varies slightly with content, which is
// fine because lines are visually clipped at the opaque card boundary
// rather than needing a pixel-perfect anchor.
const NODE_WIDTH = 200;
const NODE_HEIGHT = 100;

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag) {
  return document.createElementNS(SVG_NS, tag);
}

export function initBoardSection(userId, hostApi = {}) {
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
  const edgesLayer = document.getElementById('boardEdgesLayer');
  const edgeStatus = document.getElementById('boardEdgeStatus');
  const edgeDeleteBtn = document.getElementById('boardEdgeDeleteBtn');

  let currentBoard = null;
  let nodes = [];
  let edges = [];
  let zoom = 1;
  let loaded = false;
  let loading = false;
  let selectedEdgeId = null;
  let connectingFromNodeId = null;
  let edgeStatusTimeout = null;

  // A single reusable dashed preview line shown while dragging from a
  // node's connection handle — created once, toggled hidden/visible rather
  // than added/removed, so it never interferes with edge hit-testing.
  const previewLine = svgEl('line');
  previewLine.setAttribute('class', 'board-edge-preview');
  previewLine.hidden = true;
  if (edgesLayer) edgesLayer.appendChild(previewLine);

  // Reused for both edge-connection feedback (Phase 4) and conversion
  // feedback (Phase 5) — it's a generic transient status line for the Board,
  // not specific to edges; kept on the same #boardEdgeStatus element rather
  // than adding a second one.
  function showBoardStatus(message) {
    if (!edgeStatus) return;
    edgeStatus.textContent = message;
    edgeStatus.hidden = false;
    clearTimeout(edgeStatusTimeout);
    edgeStatusTimeout = setTimeout(() => {
      edgeStatus.hidden = true;
    }, 3000);
  }

  // ---------------- convert node to study task (Phase 5) ----------------

  let conversionModal = null; // built lazily on first use
  let conversionTargetNode = null;

  function buildConversionModal() {
    const overlay = document.createElement('div');
    overlay.className = 'board-modal-overlay';
    overlay.hidden = true;

    const modal = document.createElement('div');
    modal.className = 'board-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const heading = document.createElement('h3');
    heading.className = 'board-modal-title';
    heading.dataset.i18n = 'board.convertToStudyTask';
    heading.textContent = t('board.convertToStudyTask');

    function field(labelKey, inputEl) {
      const wrap = document.createElement('label');
      wrap.className = 'board-modal-field';
      const span = document.createElement('span');
      span.dataset.i18n = labelKey;
      span.textContent = t(labelKey);
      wrap.appendChild(span);
      wrap.appendChild(inputEl);
      return wrap;
    }

    const nameInput = document.createElement('input');
    nameInput.type = 'text';

    const minutesInput = document.createElement('input');
    minutesInput.type = 'number';
    minutesInput.min = '5';
    minutesInput.step = '5';

    const prioritySelect = document.createElement('select');
    [
      ['low', 'board.priorityLow'],
      ['medium', 'board.priorityMedium'],
      ['high', 'board.priorityHigh'],
    ].forEach(([value, key]) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.dataset.i18n = key;
      opt.textContent = t(key);
      prioritySelect.appendChild(opt);
    });

    const dueInput = document.createElement('input');
    dueInput.type = 'date';

    const notesInput = document.createElement('input');
    notesInput.type = 'text';

    const errorMsg = document.createElement('p');
    errorMsg.className = 'hint board-modal-error';
    errorMsg.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'board-modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-secondary';
    cancelBtn.dataset.i18n = 'board.cancel';
    cancelBtn.textContent = t('board.cancel');

    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'btn-primary';
    submitBtn.dataset.i18n = 'board.addToPlanner';
    submitBtn.textContent = t('board.addToPlanner');

    actions.appendChild(cancelBtn);
    actions.appendChild(submitBtn);

    modal.appendChild(heading);
    modal.appendChild(field('board.taskName', nameInput));
    modal.appendChild(field('board.estimatedMinutes', minutesInput));
    modal.appendChild(field('board.priority', prioritySelect));
    modal.appendChild(field('board.dueDate', dueInput));
    modal.appendChild(field('board.notes', notesInput));
    modal.appendChild(errorMsg);
    modal.appendChild(actions);
    overlay.appendChild(modal);

    // Appended to <body>, not #boardCanvas: the canvas has a CSS transform
    // (for zoom), and a transformed ancestor becomes the containing block
    // for any position:fixed descendant — appending inside it would break
    // the overlay's full-viewport positioning at any zoom level other than
    // exactly 100%.
    document.body.appendChild(overlay);

    cancelBtn.addEventListener('click', closeConversionModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeConversionModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.hidden) closeConversionModal();
    });

    submitBtn.addEventListener('click', async () => {
      const node = conversionTargetNode;
      if (!node) return;
      // Belt-and-suspenders: the "Add to Planner" action is only ever
      // shown on an unconverted node (see buildLinkRow below), but this is
      // the actual gate that prevents a duplicate study_subjects row.
      if (!canConvertNode(node)) {
        closeConversionModal();
        return;
      }

      const fields = buildStudyTaskFields({
        name: nameInput.value,
        minutes: minutesInput.value,
        priority: prioritySelect.value,
        dueDate: dueInput.value,
        notes: notesInput.value,
      });
      if (!isStudyTaskFieldsValid(fields)) {
        errorMsg.textContent = t('board.conversionFailed');
        errorMsg.hidden = false;
        return;
      }
      if (typeof hostApi.getActiveScheduleId !== 'function' || typeof hostApi.createStudyTaskFromBoard !== 'function') {
        errorMsg.textContent = t('board.conversionFailed');
        errorMsg.hidden = false;
        return;
      }
      const scheduleId = hostApi.getActiveScheduleId();
      if (!scheduleId) {
        errorMsg.textContent = t('board.conversionFailed');
        errorMsg.hidden = false;
        return;
      }

      submitBtn.disabled = true;
      try {
        const created = await hostApi.createStudyTaskFromBoard(fields);
        await updateNode(userId, node.id, { linkedStudySubjectId: created.id });
        const index = nodes.findIndex((n) => n.id === node.id);
        if (index !== -1) nodes[index] = linkNodeToStudyTask(nodes[index], created.id);
        closeConversionModal();
        renderNodes();
        showBoardStatus(t('board.taskCreated'));
      } catch (err) {
        console.error('Could not convert node to study task:', err);
        errorMsg.textContent = t('board.conversionFailed');
        errorMsg.hidden = false;
      } finally {
        submitBtn.disabled = false;
      }
    });

    return { overlay, nameInput, minutesInput, prioritySelect, dueInput, notesInput, errorMsg };
  }

  function closeConversionModal() {
    if (conversionModal) conversionModal.overlay.hidden = true;
    conversionTargetNode = null;
  }

  function openConversionModal(node) {
    if (!canConvertNode(node)) return; // already linked — nothing to do
    if (!conversionModal) conversionModal = buildConversionModal();
    conversionTargetNode = node;
    const defaults = studyTaskDefaultsFromNode(node);
    conversionModal.nameInput.value = defaults.name;
    conversionModal.minutesInput.value = '';
    conversionModal.prioritySelect.value = defaults.priority;
    conversionModal.dueInput.value = '';
    conversionModal.notesInput.value = '';
    conversionModal.errorMsg.hidden = true;
    conversionModal.overlay.hidden = false;
    conversionModal.nameInput.focus();
  }

  // The small footer row on every node card: either "Add to Planner", or —
  // once node.linked_study_subject_id is set — a static "Already added to
  // Planner" badge plus "View in Planner". This is also what prevents a
  // duplicate conversion in the UI: once linked, the create action is gone.
  function buildLinkRow(node) {
    const row = document.createElement('div');
    row.className = 'board-node-link-row';

    if (isNodeConverted(node)) {
      const badge = document.createElement('span');
      badge.className = 'board-node-link-badge';
      badge.dataset.i18n = 'board.alreadyAdded';
      badge.textContent = t('board.alreadyAdded');

      const viewBtn = document.createElement('button');
      viewBtn.type = 'button';
      viewBtn.className = 'board-node-link-btn';
      viewBtn.dataset.i18n = 'board.viewInPlanner';
      viewBtn.textContent = t('board.viewInPlanner');
      viewBtn.addEventListener('click', () => {
        if (typeof hostApi.viewInPlanner === 'function') hostApi.viewInPlanner();
      });
      stopDragStart(viewBtn);

      row.appendChild(badge);
      row.appendChild(viewBtn);
    } else {
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'board-node-link-btn board-node-link-btn-primary';
      addBtn.dataset.i18n = 'board.addToPlanner';
      addBtn.textContent = t('board.addToPlanner');
      addBtn.addEventListener('click', () => openConversionModal(node));
      stopDragStart(addBtn);

      row.appendChild(addBtn);
    }

    return row;
  }

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

  // ---------------- edges (Phase 4) ----------------

  function positionEdgeDeleteButton(edgeId) {
    const edge = edges.find((e) => e.id === edgeId);
    const source = edge && nodes.find((n) => n.id === edge.source_node_id);
    const target = edge && nodes.find((n) => n.id === edge.target_node_id);
    if (!edge || !source || !target) {
      hideEdgeDeleteButton();
      return;
    }
    const { x1, y1, x2, y2 } = computeEdgeGeometry(source, target, NODE_WIDTH, NODE_HEIGHT);
    const mid = edgeMidpoint(x1, y1, x2, y2);
    if (edgeDeleteBtn) {
      edgeDeleteBtn.style.left = `${mid.x}px`;
      edgeDeleteBtn.style.top = `${mid.y}px`;
      edgeDeleteBtn.hidden = false;
    }
  }

  function hideEdgeDeleteButton() {
    selectedEdgeId = null;
    if (edgeDeleteBtn) edgeDeleteBtn.hidden = true;
    if (edgesLayer) edgesLayer.querySelectorAll('.board-edge.selected').forEach((g) => g.classList.remove('selected'));
  }

  function selectEdge(edgeId) {
    selectedEdgeId = edgeId;
    if (edgesLayer) {
      edgesLayer.querySelectorAll('.board-edge').forEach((g) => {
        g.classList.toggle('selected', g.dataset.edgeId === edgeId);
      });
    }
    positionEdgeDeleteButton(edgeId);
  }

  // Full teardown + rebuild of every edge line — simple and, at the node/edge
  // counts a single board reasonably holds, cheap enough to call on every
  // node drag pointermove (see wireDrag below) so connected lines visually
  // follow the node in real time without any database write.
  function renderEdges() {
    if (!edgesLayer) return;
    edgesLayer.querySelectorAll('.board-edge').forEach((g) => g.remove());

    edges.forEach((edge) => {
      const source = nodes.find((n) => n.id === edge.source_node_id);
      const target = nodes.find((n) => n.id === edge.target_node_id);
      if (!source || !target) return; // stale local edge referencing an already-removed node

      const { x1, y1, x2, y2 } = computeEdgeGeometry(source, target, NODE_WIDTH, NODE_HEIGHT);

      const g = svgEl('g');
      g.setAttribute('class', 'board-edge');
      g.dataset.edgeId = edge.id;
      if (edge.id === selectedEdgeId) g.classList.add('selected');

      const line = svgEl('line');
      line.setAttribute('class', 'board-edge-line');
      line.setAttribute('x1', x1);
      line.setAttribute('y1', y1);
      line.setAttribute('x2', x2);
      line.setAttribute('y2', y2);
      line.setAttribute('marker-end', 'url(#boardEdgeArrow)');

      const hit = svgEl('line');
      hit.setAttribute('class', 'board-edge-hit');
      hit.setAttribute('x1', x1);
      hit.setAttribute('y1', y1);
      hit.setAttribute('x2', x2);
      hit.setAttribute('y2', y2);
      hit.setAttribute('aria-label', t('board.connectionLabel'));
      hit.dataset.i18nAriaLabel = 'board.connectionLabel';
      hit.addEventListener('click', (e) => {
        e.stopPropagation();
        selectEdge(edge.id);
      });

      g.appendChild(line);
      g.appendChild(hit);
      edgesLayer.appendChild(g);
    });

    if (selectedEdgeId) {
      if (edges.some((e) => e.id === selectedEdgeId)) {
        positionEdgeDeleteButton(selectedEdgeId);
      } else {
        hideEdgeDeleteButton();
      }
    }
  }

  if (edgeDeleteBtn) {
    edgeDeleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!selectedEdgeId) return;
      const edgeId = selectedEdgeId;
      try {
        await deleteEdge(userId, edgeId);
        edges = removeEdgeById(edges, edgeId);
        hideEdgeDeleteButton();
        renderEdges();
      } catch (err) {
        console.error('Could not delete connection:', err);
      }
    });
  }

  // Clicking empty canvas (not a node, not an edge, not the delete button —
  // each of those stops propagation on its own click/pointerdown) deselects
  // any selected edge.
  if (canvas) {
    canvas.addEventListener('click', (e) => {
      if (e.target === canvas) hideEdgeDeleteButton();
    });
  }

  // Drag-to-connect: pointerdown on a node's handle starts a temporary
  // preview line; dropping on another node's card creates the edge via the
  // existing Phase 2 boardData.createEdge (which re-validates server-side).
  // Dropping on empty canvas cancels cleanly — nothing is written.
  function wireConnectHandle(handleEl, node) {
    function pointToCanvas(e) {
      const rect = canvas.getBoundingClientRect();
      return screenToCanvasPoint({ canvasLeft: rect.left, canvasTop: rect.top, clientX: e.clientX, clientY: e.clientY, zoom });
    }

    handleEl.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      connectingFromNodeId = node.id;
      const start = pointToCanvas(e);
      previewLine.setAttribute('x1', start.x);
      previewLine.setAttribute('y1', start.y);
      previewLine.setAttribute('x2', start.x);
      previewLine.setAttribute('y2', start.y);
      previewLine.hidden = false;
      handleEl.setPointerCapture(e.pointerId);
    });

    handleEl.addEventListener('pointermove', (e) => {
      if (connectingFromNodeId !== node.id) return;
      const point = pointToCanvas(e);
      previewLine.setAttribute('x2', point.x);
      previewLine.setAttribute('y2', point.y);
    });

    async function endConnect(e) {
      if (connectingFromNodeId !== node.id) return;
      const sourceId = connectingFromNodeId;
      connectingFromNodeId = null;
      previewLine.hidden = true;

      const dropTarget = document.elementFromPoint(e.clientX, e.clientY);
      const targetEl = dropTarget ? dropTarget.closest('.board-node') : null;
      const targetNodeId = targetEl ? targetEl.dataset.nodeId : null;
      if (!targetNodeId) return; // dropped on empty canvas — cancel cleanly, nothing written

      if (isSelfEdge(sourceId, targetNodeId)) {
        showBoardStatus(t('board.invalidConnection'));
        return;
      }
      if (isDuplicateEdge(edges, sourceId, targetNodeId)) {
        showBoardStatus(t('board.connectionExists'));
        return;
      }
      if (!currentBoard) return;
      try {
        const created = await createEdge(userId, currentBoard.id, sourceId, targetNodeId);
        edges.push(created);
        renderEdges();
      } catch (err) {
        console.error('Could not create connection:', err);
        showBoardStatus(t('board.invalidConnection'));
      }
    }

    handleEl.addEventListener('pointerup', endConnect);
    handleEl.addEventListener('pointercancel', () => {
      connectingFromNodeId = null;
      previewLine.hidden = true;
    });
  }

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
      // In-memory only — no database write happens until endDrag below.
      // Keeping node.x_position/y_position live during the move (rather
      // than only at drag end, as in Phase 3) is what lets renderEdges()
      // draw connected lines following the node in real time.
      node.x_position = x_position;
      node.y_position = y_position;
      renderEdges();
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
        // The database cascades this via ON DELETE CASCADE on
        // board_edges.source_node_id/target_node_id (see 0002_boards.sql);
        // this mirrors it in local state so the lines disappear from the
        // canvas immediately, not just after the next reload.
        edges = removeEdgesForNode(edges, node.id);
        hideEdgeDeleteButton();
        renderNodes();
        renderEdges();
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
    el.appendChild(buildLinkRow(node));

    const handle = document.createElement('div');
    handle.className = 'board-node-handle';
    handle.setAttribute('aria-label', t('board.dragToConnect'));
    handle.dataset.i18nAriaLabel = 'board.dragToConnect';
    handle.setAttribute('title', t('board.dragToConnect'));
    handle.dataset.i18nTitle = 'board.dragToConnect';
    wireConnectHandle(handle, node);
    el.appendChild(handle);

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
        edges = [];
        hideEdgeDeleteButton();
        if (titleInput) titleInput.value = currentBoard.title;
        showWorkspaceState();
        renderNodes();
        renderEdges();
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
      edges = data ? data.edges : [];
      renderNodes();
      renderEdges();
      loaded = true;
    } catch (err) {
      console.error('Could not load board:', err);
    } finally {
      loading = false;
    }
  }

  return { onShow };
}
