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
// or canvas library. That's enough for free-form dragging, click-drag
// panning, and wheel/pinch zooming on a large, scrollable canvas, and keeps
// this feature from pulling in a dependency just for itself (Phase 6).
//
// Collapse/expand state (collapsedNodeIds) is intentionally view-only and
// never persisted or sent to Supabase — it resets on reload, per the Phase
// 6 brief. Search is read-only. Auto Arrange only ever writes
// x_position/y_position via the existing updateNode — it never touches an
// edge or a relationship.
//
// "Break down with AI" (Phase 8) has been removed from the normal product
// (final redesign, Checkpoint A) — this file no longer imports or calls
// aiBreakdownClient.js/aiBreakdownModel.js, so the Board no longer requires
// or triggers the board-ai-breakdown Edge Function in any way. Those files
// and the Edge Function itself are left in the repo untouched as optional/
// future functionality; nothing in the active app references them anymore.

import { t, tCount, getLocale } from '../shared/i18n.js';
import { statusBadgeHtml, statusLabelKey } from '../shared/statusModel.js';
import {
  NODE_TYPES,
  createNodeDefaults,
  computeDragPosition,
  computeEdgeGeometry,
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
  clampZoom,
  computeNodesBoundingBox,
  computeFitView,
  computeCenterOnNodeScroll,
  filterNodesByQuery,
  duplicateNodeFields,
  hasChildren,
  getDescendantNodeIds,
  computeHiddenNodeIds,
  computeAutoLayout,
  selectBoardId,
  filterNodesByBoard,
  filterEdgesByBoard,
  clearedBoardViewState,
  computeEdgeCurvePath,
  computeQuadraticPoint,
  BOARD_TEMPLATES,
  getBoardTemplate,
  buildTemplateStructure,
  NODE_STATUSES,
  normalizeNodeStatus,
  normalizeNodeDueDate,
  normalizeNodeEstimate,
  buildPlannerStatusMap,
  effectiveNodeStatus,
  computeProgress,
  computeNodeProgress,
  classifyNodeDue,
} from './boardModel.js';
import {
  listBoards,
  createBoard,
  loadBoard,
  renameBoard,
  deleteBoard,
  createNode,
  updateNode,
  deleteNode,
  createEdge,
  deleteEdge,
} from './boardData.js';

const ZOOM_STEP = 0.1;
const SEARCH_RESULTS_LIMIT = 8;
const HIGHLIGHT_DURATION_MS = 1600;
const LAST_BOARD_STORAGE_KEY = 'student-scheduler-last-board-id';

function rememberLastBoardId(boardId) {
  try {
    localStorage.setItem(LAST_BOARD_STORAGE_KEY, boardId);
  } catch {
    // per-viewer convenience only — fine if it can't persist
  }
}

function getRememberedBoardId() {
  try {
    return localStorage.getItem(LAST_BOARD_STORAGE_KEY);
  } catch {
    return null;
  }
}

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
  const zoomLabel = document.getElementById('boardZoomLabel');
  // Checkpoint D: the zoom percentage label IS the reset control (click it to
  // return to 100%) — one element serving both roles, rather than a second
  // dedicated reset button competing for space in the compact toolbar. Same
  // existing setZoom(1) wiring below, just attached to this element instead.
  const zoomResetBtn = zoomLabel;
  const toolbar = document.getElementById('boardToolbar');
  const workspace = document.getElementById('boardWorkspace');
  const canvasWrap = document.getElementById('boardCanvasWrap');
  const canvas = document.getElementById('boardCanvas');
  const emptyState = document.getElementById('boardEmptyState');
  const emptyAddNodeBtn = document.getElementById('boardEmptyAddNodeBtn');
  const emptyTemplateBtn = document.getElementById('boardEmptyTemplateBtn');
  const noBoardState = document.getElementById('boardNoBoardState');
  const createBoardBtn = document.getElementById('boardCreateBtn');
  const noBoardTemplateBtn = document.getElementById('boardNoBoardTemplateBtn');
  const templatesBtn = document.getElementById('boardTemplatesBtn');
  const edgesLayer = document.getElementById('boardEdgesLayer');
  const edgeStatus = document.getElementById('boardEdgeStatus');
  const edgeDeleteBtn = document.getElementById('boardEdgeDeleteBtn');
  const fitBtn = document.getElementById('boardFitBtn');
  const autoArrangeBtn = document.getElementById('boardAutoArrangeBtn');
  const searchInput = document.getElementById('boardSearchInput');
  const searchResults = document.getElementById('boardSearchResults');
  const selectorRow = document.getElementById('boardSelectorRow');
  const boardSelect = document.getElementById('boardSelect');
  const newBoardBtn = document.getElementById('boardNewBtn');
  const renameBoardBtn = document.getElementById('boardRenameBtn');
  const deleteBoardBtn = document.getElementById('boardDeleteBoardBtn');

  let currentBoard = null;
  let allBoards = []; // every board this user owns — just {id,title,...}, for the selector
  let switchToken = 0; // guards against a slow board load resolving after a newer switch started
  let nodes = [];
  let edges = [];
  let zoom = 1;
  let loaded = false;
  let loading = false;
  let selectedEdgeId = null;
  let connectingFromNodeId = null;
  let edgeStatusTimeout = null;
  let panning = false;
  let collapsedNodeIds = new Set(); // view-only state, never persisted — see collapse/expand below
  let highlightTimeout = null;
  // V2-D: studySubjectId -> Planner status for linked nodes. Display-only,
  // rebuilt from the Planner's own rows on every Board load/show; never
  // written anywhere.
  let plannerStatusMap = new Map();
  let detailsOpenNodeId = null; // which card has its Details panel open (view-only)
  const progressEl = document.getElementById('boardProgress');
  const progressTextEl = document.getElementById('boardProgressText');
  const progressFillEl = document.getElementById('boardProgressFill');

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

  // Checkpoint D: any open <details>-based dropdown on the Board (the
  // header's board "⋯" menu, or a node's own "⋯" menu) closes on an
  // outside click — native <details> has no such behavior on its own. Same
  // technique already used for the Planner's toolbar "More ▾" menu.
  document.addEventListener('click', (e) => {
    document.querySelectorAll('.board-more-menu[open], .board-node-menu[open]').forEach((d) => {
      if (!d.contains(e.target)) d.open = false;
    });
  });

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
        refreshPlannerStatuses();
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
    conversionModal.minutesInput.value = defaults.minutes_requested ?? '';
    conversionModal.prioritySelect.value = defaults.priority;
    conversionModal.dueInput.value = defaults.due_date || '';
    conversionModal.notesInput.value = '';
    conversionModal.errorMsg.hidden = true;
    conversionModal.overlay.hidden = false;
    conversionModal.nameInput.focus();
  }

  // Checkpoint D: the always-visible footer is now purely informational — a
  // "✓ In Planner" badge once node.linked_study_subject_id is set, nothing
  // to click. Both actual actions ("Send to Planner" / "View in Planner")
  // moved into the node's "⋯" menu (buildNodeMenu, below) to cut per-card
  // clutter; the conversion guard (a linked node can't be re-converted) is
  // unchanged, just expressed there instead of here.
  function buildLinkFooter(node) {
    if (!isNodeConverted(node)) return null;
    const row = document.createElement('div');
    row.className = 'board-node-link-row';
    const badge = document.createElement('span');
    badge.className = 'board-node-link-badge';
    badge.dataset.i18n = 'board.alreadyAdded';
    badge.textContent = t('board.alreadyAdded');
    row.appendChild(badge);
    return row;
  }

  // The node's "⋯" overflow menu: Send to Planner / View in Planner,
  // Duplicate, Collapse/Expand (only if it has children), and Delete — the
  // less-common per-node actions, moved out of always-on card clutter.
  // Every item below reuses the EXACT same click handler and Supabase call
  // the old always-visible buttons used; only the container changed.
  function buildNodeMenu(node) {
    const details = document.createElement('details');
    details.className = 'board-node-menu';

    const summary = document.createElement('summary');
    summary.className = 'board-node-menu-btn';
    summary.textContent = '⋯';
    summary.setAttribute('aria-label', t('board.nodeMenuLabel'));
    summary.dataset.i18nAriaLabel = 'board.nodeMenuLabel';
    stopDragStart(summary);
    details.appendChild(summary);

    const dropdown = document.createElement('div');
    dropdown.className = 'board-node-menu-dropdown';

    if (isNodeConverted(node)) {
      const viewBtn = document.createElement('button');
      viewBtn.type = 'button';
      viewBtn.className = 'board-node-menu-item';
      viewBtn.dataset.i18n = 'board.viewInPlanner';
      viewBtn.textContent = t('board.viewInPlanner');
      viewBtn.addEventListener('click', () => {
        details.open = false;
        if (typeof hostApi.viewInPlanner === 'function') hostApi.viewInPlanner();
      });
      dropdown.appendChild(viewBtn);
    } else {
      const sendBtn = document.createElement('button');
      sendBtn.type = 'button';
      sendBtn.className = 'board-node-menu-item';
      sendBtn.dataset.i18n = 'board.sendToPlanner';
      sendBtn.textContent = t('board.sendToPlanner');
      sendBtn.addEventListener('click', () => {
        details.open = false;
        openConversionModal(node);
      });
      dropdown.appendChild(sendBtn);
    }

    const detailsBtn = document.createElement('button');
    detailsBtn.type = 'button';
    detailsBtn.className = 'board-node-menu-item';
    detailsBtn.dataset.i18n = 'board.details';
    detailsBtn.textContent = t('board.details');
    detailsBtn.addEventListener('click', () => {
      details.open = false;
      detailsOpenNodeId = detailsOpenNodeId === node.id ? null : node.id;
      renderNodes();
      renderEdges();
    });
    dropdown.appendChild(detailsBtn);

    const duplicateBtn = document.createElement('button');
    duplicateBtn.type = 'button';
    duplicateBtn.className = 'board-node-menu-item';
    duplicateBtn.dataset.i18n = 'board.duplicate';
    duplicateBtn.textContent = t('board.duplicate');
    duplicateBtn.addEventListener('click', async () => {
      details.open = false;
      if (!currentBoard) return;
      // duplicateNodeFields deliberately drops linked_study_subject_id (a
      // duplicate is a fresh, unconverted node) and copies no edges —
      // nothing here reads or writes `edges`.
      const fields = duplicateNodeFields(node);
      try {
        const created = await createNode(userId, currentBoard.id, {
          nodeType: fields.node_type,
          title: fields.title,
          x: fields.x_position,
          y: fields.y_position,
          color: fields.color,
        });
        nodes.push(created);
        renderNodes();
      } catch (err) {
        console.error('Could not duplicate node:', err);
      }
    });
    dropdown.appendChild(duplicateBtn);

    if (hasChildren(edges, node.id)) {
      const collapsed = collapsedNodeIds.has(node.id);
      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'board-node-menu-item';
      const key = collapsed ? 'board.expand' : 'board.collapse';
      toggleBtn.dataset.i18n = key;
      toggleBtn.textContent = t(key);
      toggleBtn.addEventListener('click', () => {
        details.open = false;
        // View-only state — never persisted, never deletes anything; just
        // changes what renderNodes()/renderEdges() choose to show.
        if (collapsedNodeIds.has(node.id)) collapsedNodeIds.delete(node.id);
        else collapsedNodeIds.add(node.id);
        renderNodes();
        renderEdges();
      });
      dropdown.appendChild(toggleBtn);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'board-node-menu-item board-node-menu-item-danger';
    deleteBtn.dataset.i18n = 'board.deleteNode';
    deleteBtn.textContent = t('board.deleteNode');
    deleteBtn.addEventListener('click', async () => {
      details.open = false;
      try {
        await deleteNode(userId, node.id);
        nodes = nodes.filter((n) => n.id !== node.id);
        // The database cascades this via ON DELETE CASCADE on
        // board_edges.source_node_id/target_node_id (see 0002_boards.sql);
        // this mirrors it in local state so the lines disappear from the
        // canvas immediately, not just after the next reload.
        edges = removeEdgesForNode(edges, node.id);
        collapsedNodeIds.delete(node.id); // housekeeping — a deleted node can't stay "collapsed"
        hideEdgeDeleteButton();
        renderNodes();
        renderEdges();
      } catch (err) {
        console.error('Could not delete node:', err);
      }
    });
    dropdown.appendChild(deleteBtn);

    details.appendChild(dropdown);
    return details;
  }

  // ---------------- V2-D: status, due date, estimate, progress ----------------
  // Stored status/due/estimate are the student's own, edited from the card.
  // A linked node's status comes from its Planner task and is display-only:
  // refreshPlannerStatuses only READS (via hostApi.getLinkedScheduleItems)
  // and only re-renders — it never calls updateNode, so a Planner change can
  // never write back into board_nodes, and nothing here writes to the
  // Planner. That one-way shape is what rules out a sync loop.

  async function refreshPlannerStatuses() {
    const token = switchToken;
    const linkedIds = Array.from(new Set(nodes.map((n) => n.linked_study_subject_id).filter(Boolean)));
    if (linkedIds.length === 0 || typeof hostApi.getLinkedScheduleItems !== 'function') {
      if (plannerStatusMap.size > 0) {
        plannerStatusMap = new Map();
        renderNodes();
      }
      return;
    }
    try {
      const items = await hostApi.getLinkedScheduleItems(linkedIds);
      if (token !== switchToken) return; // board switched while loading
      const now = new Date();
      plannerStatusMap = buildPlannerStatusMap(nodes, items, { nowMinutes: now.getHours() * 60 + now.getMinutes() });
      renderNodes();
      renderEdges();
    } catch (err) {
      // Fall back to stored statuses (effectiveNodeStatus does this when a
      // node has no map entry) rather than showing a guessed Planner state.
      console.error('Could not load Planner status for linked nodes:', err);
    }
  }

  function localTodayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function formatMinutesShort(minutes) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h === 0) return `${m}m`;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }

  function formatDueShort(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(getLocale(), { month: 'short', day: 'numeric' });
  }

  function progressText(p) {
    return t('board.progressText').replace('{done}', String(p.done)).replace('{total}', String(p.total)).replace('{percent}', String(p.percent));
  }

  function renderBoardProgress() {
    if (!progressEl) return;
    const p = computeProgress(nodes, plannerStatusMap);
    progressEl.hidden = !currentBoard || p.total === 0;
    if (progressEl.hidden) return;
    progressTextEl.textContent = progressText(p);
    progressFillEl.style.width = `${p.percent}%`;
  }

  // Goal/subject nodes: progress of the task/milestone nodes beneath them.
  function buildNodeProgressRow(node) {
    if (node.node_type !== 'goal' && node.node_type !== 'subject') return null;
    const p = computeNodeProgress(nodes, edges, node.id, plannerStatusMap);
    if (p.total === 0) return null;
    const row = document.createElement('div');
    row.className = 'board-node-progress';
    const text = document.createElement('div');
    text.className = 'board-node-progress-text';
    text.textContent = progressText(p);
    const bar = document.createElement('div');
    bar.className = 'board-node-progress-bar';
    bar.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('span');
    fill.style.width = `${p.percent}%`;
    bar.appendChild(fill);
    row.appendChild(text);
    row.appendChild(bar);
    return row;
  }

  async function saveNodeFields(node, fields) {
    try {
      const updated = await updateNode(userId, node.id, fields);
      const index = nodes.findIndex((n) => n.id === node.id);
      if (index !== -1) nodes[index] = { ...nodes[index], ...updated };
    } catch (err) {
      console.error('Could not save node details:', err);
      showBoardStatus(t('board.detailsSaveFailed'));
    }
    renderNodes();
    renderEdges();
  }

  // Status chip + due chip + estimate chip. Only task/milestone nodes and
  // linked nodes show a status chip (a note has no "done"); due/estimate
  // show on any node once set. An unlinked node's status chip cycles
  // planned -> in progress -> done on click; a linked one is read-only.
  function buildNodeMetaRow(node) {
    const linked = isNodeConverted(node);
    const showStatus = linked || node.node_type === 'task' || node.node_type === 'milestone';
    const dueState = classifyNodeDue(node, localTodayStr(), plannerStatusMap);
    const estimate = normalizeNodeEstimate(node.estimated_minutes);
    if (!showStatus && !dueState && !estimate) return null;

    const row = document.createElement('div');
    row.className = 'board-node-meta';

    if (showStatus) {
      const status = effectiveNodeStatus(node, plannerStatusMap);
      const chip = document.createElement(linked ? 'span' : 'button');
      // V2-G: same badge (label/icon/color) as every other status in the app.
      chip.className = 'board-status-chip';
      chip.innerHTML = statusBadgeHtml(status, t(statusLabelKey(status)), { compact: true });
      if (linked) {
        const ps = plannerStatusMap.get(node.linked_study_subject_id);
        chip.title = ps === 'not_scheduled' ? t('board.plannerStatus.not_scheduled') : t('board.statusFromPlannerShort');
        chip.classList.add('is-linked');
      } else {
        chip.type = 'button';
        chip.title = t('board.statusCycleHint');
        chip.setAttribute('aria-label', `${t('board.statusLabel')}: ${t(statusLabelKey(status))}. ${t('board.statusCycleHint')}`);
        stopDragStart(chip);
        chip.addEventListener('click', () => {
          const current = normalizeNodeStatus(node.status);
          const next = NODE_STATUSES[(NODE_STATUSES.indexOf(current) + 1) % NODE_STATUSES.length];
          saveNodeFields(node, { status: next });
        });
      }
      row.appendChild(chip);
    }

    if (dueState) {
      const due = document.createElement('span');
      due.className = `board-node-chip board-due-${dueState}`;
      due.textContent = dueState === 'overdue'
        ? `${t('board.overdue')} · ${formatDueShort(node.due_date)}`
        : dueState === 'today'
          ? t('board.dueToday')
          : `${t('board.due')} ${formatDueShort(node.due_date)}`;
      row.appendChild(due);
    }

    if (estimate) {
      const est = document.createElement('span');
      est.className = 'board-node-chip';
      est.textContent = `~${formatMinutesShort(estimate)}`;
      est.title = t('board.estimateLabel');
      row.appendChild(est);
    }
    return row;
  }

  // Inline Details panel (opened from the "⋯" menu): status, due date,
  // estimate. Kept off the card by default so the canvas stays clean.
  function buildNodeDetailsPanel(node) {
    const panel = document.createElement('div');
    panel.className = 'board-node-details';
    stopDragStart(panel);
    const linked = isNodeConverted(node);

    function labeled(labelKey, control) {
      const label = document.createElement('label');
      label.className = 'board-node-details-field';
      const span = document.createElement('span');
      span.textContent = t(labelKey);
      label.appendChild(span);
      label.appendChild(control);
      return label;
    }

    const statusSelect = document.createElement('select');
    NODE_STATUSES.forEach((st) => {
      const opt = document.createElement('option');
      opt.value = st;
      opt.textContent = t(statusLabelKey(st));
      statusSelect.appendChild(opt);
    });
    statusSelect.value = normalizeNodeStatus(node.status);
    if (linked) {
      // A linked task can be in any of the six shared statuses (e.g.
      // Missed), not just the three a student can set by hand.
      const linkedStatus = effectiveNodeStatus(node, plannerStatusMap);
      if (!NODE_STATUSES.includes(linkedStatus)) {
        const opt = document.createElement('option');
        opt.value = linkedStatus;
        opt.textContent = t(statusLabelKey(linkedStatus));
        statusSelect.appendChild(opt);
      }
      statusSelect.disabled = true;
      statusSelect.value = linkedStatus;
    }
    statusSelect.addEventListener('change', () => saveNodeFields(node, { status: statusSelect.value }));
    panel.appendChild(labeled('board.statusLabel', statusSelect));
    if (linked) {
      const note = document.createElement('p');
      note.className = 'board-node-details-note';
      note.textContent = t('board.statusFromPlanner');
      panel.appendChild(note);
    }

    const dueInput = document.createElement('input');
    dueInput.type = 'date';
    dueInput.value = normalizeNodeDueDate(node.due_date) || '';
    dueInput.addEventListener('change', () => saveNodeFields(node, { dueDate: dueInput.value || null }));
    panel.appendChild(labeled('board.dueDateLabel', dueInput));

    const estInput = document.createElement('input');
    estInput.type = 'number';
    estInput.min = '5';
    estInput.step = '5';
    estInput.inputMode = 'numeric';
    estInput.placeholder = t('board.estimatePlaceholder');
    estInput.value = normalizeNodeEstimate(node.estimated_minutes) ?? '';
    estInput.addEventListener('change', () => saveNodeFields(node, { estimatedMinutes: estInput.value === '' ? null : estInput.value }));
    panel.appendChild(labeled('board.estimateLabel', estInput));

    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'board-node-details-close';
    doneBtn.textContent = t('board.detailsDone');
    doneBtn.addEventListener('click', () => {
      detailsOpenNodeId = null;
      renderNodes();
      renderEdges();
    });
    panel.appendChild(doneBtn);
    return panel;
  }

  // Small monochrome per-type glyphs (same stroke style as the sidebar nav
  // icons) — purely presentational, always paired with the real <select>
  // next to it, which stays the actual node_type control (Checkpoint D
  // doesn't add a second, parallel type-storage mechanism).
  const NODE_TYPE_ICONS = {
    goal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3.2"/></svg>',
    subject: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 5.5h8a3 3 0 0 1 3 3V19a2.5 2.5 0 0 0-2.5-2.5h-8.5z"/><path d="M12.5 8.5h7a3 3 0 0 1 0 6h-.01"/></svg>',
    task: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="4.5" width="15" height="15" rx="2.5"/><path d="M8.5 12.5 11 15l4.5-5.5"/></svg>',
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4.5h9L18.5 8v11a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1z"/><path d="M8.5 10.5h7M8.5 14h5"/></svg>',
    milestone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 20.5V4.5"/><path d="M6 5h11l-2.5 4L17 13H6"/></svg>',
  };
  function nodeTypeIconMarkup(nodeType) {
    return NODE_TYPE_ICONS[nodeType] || NODE_TYPE_ICONS.note;
  }

  function applyZoom() {
    canvas.style.transform = `scale(${zoom})`;
    if (zoomLabel) zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  }

  // Zooms while keeping the canvas-local point under (clientX, clientY)
  // fixed on screen — the standard "zoom toward the cursor" feel. Falls
  // back to a plain zoom (no re-centering) when no pointer position is
  // given, e.g. the toolbar +/- buttons.
  function setZoomAtPoint(next, clientX, clientY) {
    const nextZoom = clampZoom(next);
    if (nextZoom === zoom) return;
    if (typeof clientX === 'number' && typeof clientY === 'number' && canvasWrap) {
      const wrapRect = canvasWrap.getBoundingClientRect();
      const viewportX = clientX - wrapRect.left;
      const viewportY = clientY - wrapRect.top;
      const canvasX = (canvasWrap.scrollLeft + viewportX) / zoom;
      const canvasY = (canvasWrap.scrollTop + viewportY) / zoom;
      zoom = nextZoom;
      applyZoom();
      canvasWrap.scrollLeft = canvasX * zoom - viewportX;
      canvasWrap.scrollTop = canvasY * zoom - viewportY;
    } else {
      zoom = nextZoom;
      applyZoom();
    }
  }

  function setZoom(next) {
    setZoomAtPoint(next, null, null);
  }

  if (zoomInBtn) zoomInBtn.addEventListener('click', () => setZoom(zoom + ZOOM_STEP));
  if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => setZoom(zoom - ZOOM_STEP));
  if (zoomResetBtn) zoomResetBtn.addEventListener('click', () => setZoom(1));

  // Mouse-wheel / trackpad zoom: only when the browser reports a "zoom"
  // gesture (Ctrl/Cmd held, which is also what a trackpad pinch dispatches
  // as on every major browser) — a plain two-finger scroll or mouse wheel
  // is left alone so it keeps doing the canvas-wrap's native scroll (pan),
  // which already works via the existing overflow:auto (see main.css).
  if (canvasWrap) {
    canvasWrap.addEventListener(
      'wheel',
      (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
        setZoomAtPoint(zoom + delta, e.clientX, e.clientY);
      },
      { passive: false }
    );
  }

  // Click-and-drag panning on empty canvas space. Guarded to e.target ===
  // canvas exactly (not a node, not an edge, not the connect handle — each
  // already stops its own pointerdown from bubbling here), the same
  // precise-target technique already used below to deselect an edge on an
  // empty-canvas click.
  if (canvas && canvasWrap) {
    let panPointerId = null;
    let panStartX = 0;
    let panStartY = 0;
    let panScrollLeft = 0;
    let panScrollTop = 0;

    canvas.addEventListener('pointerdown', (e) => {
      if (e.target !== canvas) return;
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      panning = true;
      panPointerId = e.pointerId;
      canvas.classList.add('panning');
      panStartX = e.clientX;
      panStartY = e.clientY;
      panScrollLeft = canvasWrap.scrollLeft;
      panScrollTop = canvasWrap.scrollTop;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!panning || e.pointerId !== panPointerId) return;
      canvasWrap.scrollLeft = panScrollLeft - (e.clientX - panStartX);
      canvasWrap.scrollTop = panScrollTop - (e.clientY - panStartY);
    });
    function endPan(e) {
      if (!panning || e.pointerId !== panPointerId) return;
      panning = false;
      panPointerId = null;
      canvas.classList.remove('panning');
    }
    canvas.addEventListener('pointerup', endPan);
    canvas.addEventListener('pointercancel', endPan);
  }

  // ---------------- fit to board / center on node ----------------

  function fitToBoard() {
    if (!canvasWrap) return;
    const bbox = computeNodesBoundingBox(nodes, NODE_WIDTH, NODE_HEIGHT);
    if (!bbox) return; // nothing to fit
    const { zoom: fitZoom, scrollLeft, scrollTop } = computeFitView({
      bbox,
      viewportWidth: canvasWrap.clientWidth,
      viewportHeight: canvasWrap.clientHeight,
    });
    zoom = fitZoom;
    applyZoom();
    canvasWrap.scrollLeft = scrollLeft;
    canvasWrap.scrollTop = scrollTop;
  }

  if (fitBtn) fitBtn.addEventListener('click', fitToBoard);

  function centerOnNode(node) {
    if (!canvasWrap || !node) return;
    const { scrollLeft, scrollTop } = computeCenterOnNodeScroll({
      node,
      nodeWidth: NODE_WIDTH,
      nodeHeight: NODE_HEIGHT,
      viewportWidth: canvasWrap.clientWidth,
      viewportHeight: canvasWrap.clientHeight,
      zoom,
    });
    canvasWrap.scrollLeft = scrollLeft;
    canvasWrap.scrollTop = scrollTop;
  }

  function highlightNode(nodeId) {
    clearTimeout(highlightTimeout);
    canvas.querySelectorAll('.board-node.search-highlight').forEach((el) => el.classList.remove('search-highlight'));
    const el = canvas.querySelector(`.board-node[data-node-id="${nodeId}"]`);
    if (!el) return;
    el.classList.add('search-highlight');
    highlightTimeout = setTimeout(() => el.classList.remove('search-highlight'), HIGHLIGHT_DURATION_MS);
  }

  // ---------------- search (read-only — never modifies a node) ----------------

  function closeSearchResults() {
    if (searchResults) {
      searchResults.hidden = true;
      searchResults.innerHTML = '';
    }
  }

  function renderSearchResults(query) {
    if (!searchResults) return;
    const matches = filterNodesByQuery(nodes, query).slice(0, SEARCH_RESULTS_LIMIT);
    searchResults.innerHTML = '';
    if (!query.trim()) {
      closeSearchResults();
      return;
    }
    if (matches.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'board-search-empty';
      empty.dataset.i18n = 'board.noMatchingNodes';
      empty.textContent = t('board.noMatchingNodes');
      searchResults.appendChild(empty);
      searchResults.hidden = false;
      return;
    }
    matches.forEach((node) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'board-search-result';
      item.textContent = node.title || t('board.nodeTitlePlaceholder');
      item.addEventListener('click', () => {
        centerOnNode(node);
        highlightNode(node.id);
        closeSearchResults();
        if (searchInput) searchInput.value = '';
      });
      searchResults.appendChild(item);
    });
    searchResults.hidden = false;
  }

  if (searchInput) {
    searchInput.addEventListener('input', () => renderSearchResults(searchInput.value));
    searchInput.addEventListener('focus', () => {
      if (searchInput.value.trim()) renderSearchResults(searchInput.value);
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        searchInput.value = '';
        closeSearchResults();
        searchInput.blur();
      }
    });
    document.addEventListener('click', (e) => {
      if (!searchInput.contains(e.target) && !searchResults.contains(e.target)) closeSearchResults();
    });
  }

  // ---------------- auto arrange ----------------

  async function autoArrange() {
    if (nodes.length === 0) return;
    const positions = computeAutoLayout(nodes, edges);
    const updates = [];
    nodes = nodes.map((node) => {
      const pos = positions[node.id];
      if (!pos) return node;
      updates.push(updateNode(userId, node.id, { x: pos.x_position, y: pos.y_position }));
      return { ...node, x_position: pos.x_position, y_position: pos.y_position };
    });
    renderNodes();
    renderEdges();
    try {
      await Promise.all(updates);
    } catch (err) {
      console.error('Could not save arranged positions:', err);
    }
  }

  if (autoArrangeBtn) autoArrangeBtn.addEventListener('click', autoArrange);

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
    // The curve's actual midpoint (t=0.5), not the straight-line one — the
    // button would otherwise sit visibly off the bowed line (Checkpoint D).
    const mid = computeQuadraticPoint(x1, y1, x2, y2, 0.5);
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

    const hiddenNodeIds = computeHiddenNodeIds(edges, Array.from(collapsedNodeIds));

    edges.forEach((edge) => {
      const source = nodes.find((n) => n.id === edge.source_node_id);
      const target = nodes.find((n) => n.id === edge.target_node_id);
      if (!source || !target) return; // stale local edge referencing an already-removed node
      // A collapsed branch hides its descendant nodes AND every edge
      // touching one — view-only, nothing is deleted (see collapsedNodeIds).
      if (hiddenNodeIds.has(source.id) || hiddenNodeIds.has(target.id)) return;

      const { x1, y1, x2, y2 } = computeEdgeGeometry(source, target, NODE_WIDTH, NODE_HEIGHT);
      // Checkpoint D: a gentle bow instead of a dead-straight line — same
      // node-center anchors, just drawn as a single quadratic curve. The
      // marker-end arrow follows a <path>'s tangent at its endpoint exactly
      // as it did for a <line>, so direction is unaffected.
      const d = computeEdgeCurvePath(x1, y1, x2, y2);

      const g = svgEl('g');
      g.setAttribute('class', 'board-edge');
      g.dataset.edgeId = edge.id;
      if (edge.id === selectedEdgeId) g.classList.add('selected');

      const line = svgEl('path');
      line.setAttribute('class', 'board-edge-line');
      line.setAttribute('d', d);
      line.setAttribute('marker-end', 'url(#boardEdgeArrow)');

      const hit = svgEl('path');
      hit.setAttribute('class', 'board-edge-hit');
      hit.setAttribute('d', d);
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
    el.dataset.status = effectiveNodeStatus(node, plannerStatusMap);
    el.style.left = `${node.x_position}px`;
    el.style.top = `${node.y_position}px`;

    const head = document.createElement('div');
    head.className = 'board-node-head';

    const typeIcon = document.createElement('span');
    typeIcon.className = 'board-node-type-icon';
    typeIcon.setAttribute('aria-hidden', 'true');
    typeIcon.innerHTML = nodeTypeIconMarkup(node.node_type);

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
      typeIcon.innerHTML = nodeTypeIconMarkup(nextType);
      try {
        await updateNode(userId, node.id, { nodeType: nextType });
      } catch (err) {
        console.error('Could not save node type:', err);
      }
    });
    stopDragStart(typeSelect);

    head.appendChild(typeIcon);
    head.appendChild(typeSelect);
    // Checkpoint D: Edit/Duplicate/Collapse/Send to Planner/Delete all live
    // under this one "⋯" menu now — the connection handle (bottom-right) is
    // the only per-node affordance left always on the card, per the "reduce
    // clutter" brief. See buildNodeMenu above.
    head.appendChild(buildNodeMenu(node));

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

    const progressRow = buildNodeProgressRow(node);
    if (progressRow) el.appendChild(progressRow);
    const metaRow = buildNodeMetaRow(node);
    if (metaRow) el.appendChild(metaRow);
    if (detailsOpenNodeId === node.id) el.appendChild(buildNodeDetailsPanel(node));

    const linkFooter = buildLinkFooter(node);
    if (linkFooter) el.appendChild(linkFooter);

    // Section 15: a collapsed branch shows how much it's hiding rather than
    // just a bare Expand button with no context.
    if (collapsedNodeIds.has(node.id)) {
      const hiddenCount = getDescendantNodeIds(edges, node.id).length;
      if (hiddenCount > 0) {
        const badge = document.createElement('div');
        badge.className = 'board-node-hidden-badge';
        badge.textContent = tCount('board.hiddenItems', hiddenCount);
        el.appendChild(badge);
      }
    }

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
    // Collapsing a branch hides its descendants (view-only — see
    // collapsedNodeIds); the collapsed node itself stays visible.
    const hiddenNodeIds = computeHiddenNodeIds(edges, Array.from(collapsedNodeIds));
    nodes.filter((node) => !hiddenNodeIds.has(node.id)).forEach((node) => canvas.appendChild(buildNodeEl(node)));
    if (emptyState) emptyState.hidden = nodes.length > 0;
    renderBoardProgress();
  }

  function showNoBoardState() {
    if (workspace) workspace.hidden = true;
    if (toolbar) toolbar.hidden = true;
    if (selectorRow) selectorRow.hidden = true;
    if (noBoardState) noBoardState.hidden = false;
    if (titleInput) titleInput.value = '';
  }

  function showWorkspaceState() {
    if (noBoardState) noBoardState.hidden = true;
    if (workspace) workspace.hidden = false;
    if (toolbar) toolbar.hidden = false;
    if (selectorRow) selectorRow.hidden = false;
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

  // ---------------- multiple boards (Phase 7) ----------------

  function refreshBoardSelect() {
    if (!boardSelect) return;
    boardSelect.innerHTML = '';
    allBoards.forEach((b) => {
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = b.title; // user-created content — never translated
      boardSelect.appendChild(opt);
    });
    if (currentBoard) boardSelect.value = currentBoard.id;
  }

  // The single place that loads a different board's data. Clears every bit
  // of the previous board's rendered/selected state FIRST (before the new
  // board has even started loading), so a slow connection never leaves the
  // old board's nodes/edges visible while the new one is in flight — and
  // switchToken guards against an old, slow switchToBoard call finishing
  // AFTER a newer one and clobbering it with stale data.
  async function switchToBoard(boardId) {
    if (!boardId) return;
    const token = ++switchToken;

    const cleared = clearedBoardViewState();
    nodes = cleared.nodes;
    edges = cleared.edges;
    collapsedNodeIds = cleared.collapsedNodeIds;
    plannerStatusMap = new Map();
    detailsOpenNodeId = null;
    selectedEdgeId = cleared.selectedEdgeId;
    connectingFromNodeId = cleared.connectingFromNodeId;
    if (edgeDeleteBtn) edgeDeleteBtn.hidden = true;
    closeSearchResults();
    if (previewLine) previewLine.hidden = true;
    renderNodes();
    renderEdges();

    // Reset the viewport for the new board rather than trying to remember
    // a per-board scroll/zoom — simple and deterministic.
    zoom = 1;
    applyZoom();
    if (canvasWrap) {
      canvasWrap.scrollLeft = 0;
      canvasWrap.scrollTop = 0;
    }

    try {
      const data = await loadBoard(userId, boardId);
      if (token !== switchToken) return; // a newer switch already started — discard this result
      if (!data) {
        console.error('Could not load board: it may have just been deleted.');
        return;
      }
      currentBoard = data.board;
      nodes = filterNodesByBoard(data.nodes, currentBoard.id);
      edges = filterEdgesByBoard(data.edges, currentBoard.id);
      if (titleInput) titleInput.value = currentBoard.title;
      showBoardSelectView();
      refreshBoardSelect();
      renderNodes();
      renderEdges();
      rememberLastBoardId(currentBoard.id);
      refreshPlannerStatuses();
    } catch (err) {
      if (token !== switchToken) return;
      console.error('Could not load board:', err);
    }
  }

  if (boardSelect) {
    boardSelect.addEventListener('change', () => {
      if (boardSelect.value && (!currentBoard || boardSelect.value !== currentBoard.id)) {
        switchToBoard(boardSelect.value);
      }
    });
  }

  async function createNewBoard() {
    const title = window.prompt(t('board.boardNameLabel'), '');
    if (title === null) return; // cancelled
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      const created = await createBoard(userId, trimmed);
      allBoards = [created, ...allBoards];
      showWorkspaceState();
      // switchToBoard itself calls refreshBoardSelect() once currentBoard
      // is updated to this new board.
      await switchToBoard(created.id);
      showBoardStatus(t('board.boardCreated'));
    } catch (err) {
      console.error('Could not create board:', err);
    }
  }

  if (createBoardBtn) createBoardBtn.addEventListener('click', createNewBoard);
  if (newBoardBtn) newBoardBtn.addEventListener('click', createNewBoard);

  // ---------------- Board templates (Checkpoint D) ----------------
  // Deterministic, local, non-AI starter content (BOARD_TEMPLATES in
  // boardModel.js) — no network call, no second Board engine. Applying a
  // template ALWAYS creates a brand-new board and never touches the
  // currently open one, so there is no scenario where an existing board's
  // nodes could be silently overwritten (Template Safety, section 12/13):
  // picking a template from this picker IS the explicit confirmation.
  let templateModal = null; // built lazily on first use, like conversionModal above

  function closeTemplateModal() {
    if (templateModal) templateModal.overlay.hidden = true;
  }

  function buildTemplateModal() {
    const overlay = document.createElement('div');
    overlay.className = 'board-modal-overlay';
    overlay.hidden = true;

    const modal = document.createElement('div');
    modal.className = 'board-modal board-template-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const heading = document.createElement('h3');
    heading.className = 'board-modal-title';
    heading.textContent = t('board.templatesModalTitle');

    const subtitle = document.createElement('p');
    subtitle.className = 'hint board-template-modal-subtitle';
    subtitle.textContent = t('board.templatesModalSubtitle');

    const list = document.createElement('div');
    list.className = 'board-template-list';

    BOARD_TEMPLATES.forEach((template) => {
      const card = document.createElement('div');
      card.className = 'board-template-card';

      const cardTitle = document.createElement('div');
      cardTitle.className = 'board-template-card-title';
      cardTitle.textContent = t(template.titleKey);

      const steps = document.createElement('p');
      steps.className = 'hint board-template-card-steps';
      steps.textContent = [t(template.root.titleKey), ...template.children.map((c) => t(c.titleKey))].join(' · ');

      const useBtn = document.createElement('button');
      useBtn.type = 'button';
      useBtn.className = 'btn-secondary';
      useBtn.textContent = t('board.useTemplate');
      useBtn.addEventListener('click', () => applyTemplate(template.key, useBtn));

      card.appendChild(cardTitle);
      card.appendChild(steps);
      card.appendChild(useBtn);
      list.appendChild(card);
    });

    const actions = document.createElement('div');
    actions.className = 'board-modal-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = t('board.cancel');
    cancelBtn.addEventListener('click', closeTemplateModal);
    actions.appendChild(cancelBtn);

    modal.appendChild(heading);
    modal.appendChild(subtitle);
    modal.appendChild(list);
    modal.appendChild(actions);
    overlay.appendChild(modal);

    // Appended to <body>, same rationale as buildConversionModal above (the
    // canvas's zoom transform would otherwise break position:fixed).
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeTemplateModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.hidden) closeTemplateModal();
    });

    return { overlay };
  }

  function openTemplateModal() {
    if (!templateModal) templateModal = buildTemplateModal();
    templateModal.overlay.hidden = false;
  }

  // Creates a brand-new board, then the template's root + child nodes and
  // the parent edges connecting them, then hands the result to the EXISTING
  // autoArrange() (defined above) for layout + position persistence — reuse
  // of createBoard/createNode/createEdge/autoArrange end to end, no
  // duplicate persistence or layout logic.
  async function applyTemplate(templateKey, triggerBtn) {
    const template = getBoardTemplate(templateKey);
    const structure = buildTemplateStructure(template);
    if (!structure) return;
    if (triggerBtn) triggerBtn.disabled = true;
    // Tracked outside the try so the catch block below can tell whether the
    // board itself was actually created before something else in the
    // sequence failed (see the partial-failure handling there).
    let createdBoardId = null;
    try {
      const board = await createBoard(userId, t(structure.boardTitleKey));
      createdBoardId = board.id;
      allBoards = [board, ...allBoards];
      showWorkspaceState();
      // switchToBoard clears local state and loads this (still-empty) board.
      await switchToBoard(board.id);

      const createdIds = [];
      for (const spec of structure.nodes) {
        const created = await createNode(userId, board.id, { nodeType: spec.nodeType, title: t(spec.titleKey), x: 0, y: 0 });
        nodes.push(created);
        createdIds.push(created.id);
      }
      for (const edgeSpec of structure.edges) {
        const created = await createEdge(userId, board.id, createdIds[edgeSpec.fromIndex], createdIds[edgeSpec.toIndex], edgeSpec.relationship);
        edges.push(created);
      }
      // Every node was created at (0,0) — go straight to the arranged
      // layout in one render pass via autoArrange() (which renders itself)
      // rather than rendering the stacked-at-origin state first; a
      // template should never flash a pile of overlapping cards before
      // snapping into its real layout.
      await autoArrange(); // lays out the new tree cleanly and persists it
      closeTemplateModal();
      showBoardStatus(t('board.templateCreated'));
    } catch (err) {
      console.error('Could not create board from template:', err);
      showBoardStatus(t('board.templateCreateFailed'));
      // The board (and possibly some of its nodes/edges) may already be
      // real rows in Supabase even though the sequence above failed
      // partway through — re-load from the database rather than leave the
      // UI showing empty/stale local state that doesn't match what's
      // actually there. switchToBoard is the exact same load path a normal
      // board switch already uses, so this is never a second render path.
      if (createdBoardId) {
        try {
          await switchToBoard(createdBoardId);
        } catch (reloadErr) {
          console.error('Could not reload the partially-created board:', reloadErr);
        }
      }
    } finally {
      if (triggerBtn) triggerBtn.disabled = false;
    }
  }

  if (templatesBtn) templatesBtn.addEventListener('click', openTemplateModal);
  if (emptyTemplateBtn) emptyTemplateBtn.addEventListener('click', openTemplateModal);
  if (noBoardTemplateBtn) noBoardTemplateBtn.addEventListener('click', openTemplateModal);
  // Reuses the exact existing "Add node" handler — same technique as the
  // Home page's Quick Actions calling other buttons' .click() directly.
  if (emptyAddNodeBtn) emptyAddNodeBtn.addEventListener('click', () => addNodeBtn && addNodeBtn.click());

  // Checkpoint D: the board selector row shows either the <select> (normal
  // browsing) or the title <input> (actively renaming) — never both — so
  // the compact header never needs a permanently-visible text field just
  // for the rare rename action. Exactly the same renameBoard call/handler
  // as before; only which control is on screen has changed.
  function showBoardSelectView() {
    if (boardSelect) boardSelect.hidden = false;
    if (titleInput) titleInput.hidden = true;
  }
  function showBoardRenameView() {
    if (!currentBoard || !titleInput) return;
    if (boardSelect) boardSelect.hidden = true;
    titleInput.hidden = false;
    titleInput.value = currentBoard.title;
    titleInput.focus();
    titleInput.select();
  }

  if (renameBoardBtn) {
    renameBoardBtn.addEventListener('click', () => {
      const menu = renameBoardBtn.closest('.board-more-menu');
      if (menu) menu.open = false;
      showBoardRenameView();
    });
  }

  if (titleInput) {
    titleInput.addEventListener('blur', showBoardSelectView);
    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') titleInput.blur(); // triggers 'change' (if edited) then the blur handler above
      if (e.key === 'Escape') {
        titleInput.value = currentBoard ? currentBoard.title : '';
        titleInput.blur();
      }
    });
    titleInput.addEventListener('change', async () => {
      if (!currentBoard) return;
      const nextTitle = titleInput.value.trim() || 'Untitled board';
      titleInput.value = nextTitle;
      try {
        currentBoard = await renameBoard(userId, currentBoard.id, nextTitle);
        // Renaming never touches nodes/edges/linked study tasks — only the
        // board's own title, here and in the local selector cache.
        allBoards = allBoards.map((b) => (b.id === currentBoard.id ? currentBoard : b));
        refreshBoardSelect();
        showBoardStatus(t('board.boardRenamed'));
      } catch (err) {
        console.error('Could not rename board:', err);
      }
    });
  }

  if (deleteBoardBtn) {
    deleteBoardBtn.addEventListener('click', async () => {
      if (!currentBoard) return;
      const message = `${t('board.deleteBoardWarning')}\n\n${t('board.deleteBoardQuestion')}`;
      if (!window.confirm(message)) return;

      const deletingId = currentBoard.id;
      try {
        // The database cascades this to the board's own board_nodes/
        // board_edges (ON DELETE CASCADE, migration 0002). study_subjects
        // has no reference back to boards/board_nodes, so any Planner
        // tasks created from this board's nodes are never touched.
        await deleteBoard(userId, deletingId);
        allBoards = allBoards.filter((b) => b.id !== deletingId);
        if (getRememberedBoardId() === deletingId) rememberLastBoardId('');

        if (allBoards.length === 0) {
          currentBoard = null;
          const cleared = clearedBoardViewState();
          nodes = cleared.nodes;
          edges = cleared.edges;
          collapsedNodeIds = cleared.collapsedNodeIds;
          renderNodes();
          renderEdges();
          showNoBoardState();
        } else {
          showWorkspaceState();
          // switchToBoard itself calls refreshBoardSelect() once
          // currentBoard is updated to the new selection.
          await switchToBoard(allBoards[0].id);
        }
        showBoardStatus(t('board.boardDeleted'));
      } catch (err) {
        console.error('Could not delete board:', err);
      }
    });
  }

  applyZoom();

  // Lazy-loaded the first time the Board nav item is clicked, so a user who
  // never opens the Board never pays for a boards/nodes/edges round trip.
  async function onShow() {
    // Already loaded: just re-read linked tasks' Planner status, so work
    // finished in the Planner since the last visit shows here.
    if (loaded && !loading) {
      refreshPlannerStatuses();
      return;
    }
    if (loading) return;
    loading = true;
    try {
      allBoards = await listBoards(userId);
      if (!allBoards || allBoards.length === 0) {
        allBoards = [];
        currentBoard = null;
        showNoBoardState();
        loaded = true;
        return;
      }
      showWorkspaceState();
      // switchToBoard populates the selector's options once it sets
      // currentBoard — avoids briefly showing the wrong board selected if
      // the remembered board isn't first in allBoards' order.
      const chosenId = selectBoardId(allBoards, getRememberedBoardId());
      await switchToBoard(chosenId);
      loaded = true;
    } catch (err) {
      console.error('Could not load boards:', err);
    } finally {
      loading = false;
    }
  }

  // ---------------- cross-feature bridges (Phase 9: AI Advisor) ----------------
  // The Advisor never imports boardData.js or reaches into this module's
  // internals — it only ever gets here through dashboard.js's hostApi, the
  // same bridge pattern Board's own "Add to Planner" (Phase 5) already
  // uses in the other direction. Board stays the sole owner of its
  // Supabase calls and rendered state.

  // A small, sanitized summary of the CURRENTLY LOADED board's nodes —
  // titles and types only, capped, no ids — for the Advisor's planning
  // context. Returns [] if no board has been loaded this session (the
  // user never opened Board yet); this never triggers a fetch of its own.
  function getGoalNodesSummary() {
    return nodes.slice(0, 30).map((n) => ({ title: n.title, nodeType: n.node_type }));
  }

  // Creates a single top-level node on the currently active board from a
  // plain title string — used by the Advisor's "Add to Board" action.
  // Reuses the exact same createNodeDefaults placement + createNode call
  // the "+ Add node" button already uses; the only difference is the
  // caller-supplied title. Throws 'no_active_board' if the user hasn't
  // opened/created a board yet this session, so the caller can show a
  // clear, translated message rather than a silent failure.
  async function addNodeFromExternal(title) {
    if (!currentBoard) throw new Error('no_active_board');
    const defaults = createNodeDefaults(nodes.length, 'task');
    const created = await createNode(userId, currentBoard.id, {
      nodeType: defaults.node_type,
      title: title || defaults.title,
      x: defaults.x_position,
      y: defaults.y_position,
    });
    nodes.push(created);
    renderNodes();
    return created;
  }

  return { onShow, getGoalNodesSummary, addNodeFromExternal };
}
