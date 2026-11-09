// Product tours (V5-A), pure — no DOM, no Supabase.
//
// A tour is a short list of steps for one page. Each step points at a real
// element by CSS selector (first match of `target`, tried in order); `area`
// widens the highlight to the closest ancestor matching it (e.g. a card).
// A step without a target is a centred card (intro / outro).
//
// Targets are resolved when a step is shown, so a tour survives elements
// that are missing, hidden by a module setting, or not rendered yet: such a
// step is skipped in the direction of travel. Copy lives in i18n under
// `tour.<tourId>.<stepKey>.title|body`.

export const TOUR_IDS = ['today', 'planner', 'tasks', 'courses', 'projects', 'goals', 'routines', 'calendar', 'focus', 'board', 'analytics'];

/** Hash route each tour runs on (see app/router.js ROUTES). */
export const TOUR_ROUTE = {
  today: 'today',
  planner: 'planner',
  tasks: 'tasks',
  courses: 'courses',
  projects: 'projects',
  goals: 'goals',
  routines: 'routines',
  calendar: 'calendar',
  focus: 'today',
  board: 'boards',
  analytics: 'insights',
};

/** Module (workspace/modules.js) a tour belongs to — hidden modules hide their guide. */
export const TOUR_MODULE = {
  today: 'today', planner: 'planner', tasks: 'tasks', courses: 'courses', projects: 'projects',
  goals: 'goals', routines: 'routines', calendar: 'calendar', focus: 'today', board: 'board', analytics: 'insights',
};

export const TOURS = {
  today: [
    { key: 'intro' },
    { key: 'next', target: ['#todayNext', '#todayTopHead'], area: '.card' },
    { key: 'capture', target: ['#todayCapture'], area: 'form' },
    { key: 'catchup', target: ['[data-action="today-catchup"]', '#todayAttention'], area: '.notice' },
    { key: 'deadlines', target: ['#todayDeadlinesHead', '#todayDueHead'], area: '.card' },
    { key: 'schedule', target: ['#todaySchedHead'], area: '.card' },
    { key: 'plan', target: ['[data-action="today-semester"]', '[data-action="today-planner"]'] },
  ],
  planner: [
    { key: 'date', target: ['#plannerDateHeading', '#forDate'] },
    { key: 'add', target: ['#addStudyBtn'] },
    { key: 'backlog', target: ['#addFromBacklogBtn'] },
    { key: 'generate', target: ['#generateBtn', '#regenerateBtn'] },
    { key: 'output', target: ['#output'] },
    { key: 'more', target: ['#plannerMoreTools'] },
  ],
  tasks: [
    { key: 'add', target: ['[data-action="add-task"]'] },
    { key: 'search', target: ['#tasksSearch'] },
    { key: 'filters', target: ['#tasksCourse', '#tasksPriority'], area: '.toolbar' },
    { key: 'open', target: ['#tasksView [data-action="open-task"]'], area: '.list-row' },
  ],
  courses: [
    { key: 'add', target: ['[data-action="new-course"]'] },
    { key: 'semester', target: ['#coursesSemesterFilter'] },
    { key: 'card', target: ['#coursesView .course-card'] },
    { key: 'import', target: ['[data-action="import-syllabus"]'] },
  ],
  projects: [
    { key: 'add', target: ['[data-action="new-project"]'] },
    { key: 'filter', target: ['#projectSearch'], area: '.toolbar' },
    { key: 'card', target: ['#projectsView .project-card'] },
  ],
  goals: [
    { key: 'add', target: ['[data-action="new-goal"]'] },
    { key: 'filter', target: ['#goalSearch'], area: '.toolbar' },
    { key: 'card', target: ['#goalsView .goal-card'] },
  ],
  routines: [
    { key: 'add', target: ['[data-action="new-routine"]'] },
    { key: 'today', target: ['#routinesTodayHead'], area: '.card' },
    { key: 'tick', target: ['#routinesView [data-action="toggle"]'] },
    { key: 'all', target: ['#routinesAllHead'], area: '.card' },
  ],
  calendar: [
    { key: 'views', target: ['#calendarV3 .seg'] },
    { key: 'body', target: ['#cal3Body'] },
    { key: 'import', target: ['#calendarImportCard'] },
    { key: 'export', target: ['#calendarExportCard'] },
  ],
  focus: [
    { key: 'intro' },
    { key: 'start', target: ['#todayView [data-action="focus-task"]', '#todayView [data-action="focus-next"]'] },
    { key: 'outro' },
  ],
  board: [
    { key: 'select', target: ['#boardSelectorRow'] },
    { key: 'add', target: ['#boardAddNodeBtn'] },
    { key: 'templates', target: ['#boardTemplatesBtn'] },
    { key: 'canvas', target: ['#boardCanvasWrap'] },
    { key: 'progress', target: ['#boardProgress'] },
  ],
  analytics: [
    { key: 'metrics', target: ['#insightsMetrics'] },
    { key: 'breakdown', target: ['#insightsV3'] },
    { key: 'actual', target: ['#analyticsActualCard'] },
  ],
};

/** Which tour belongs to the page whose view id is shown. */
const VIEW_TOUR = {
  todayView: 'today', plannerForm: 'planner', tasksView: 'tasks', coursesView: 'courses',
  projectsView: 'projects', goalsView: 'goals', routinesView: 'routines', calendarView: 'calendar',
  boardView: 'board', insightsView: 'analytics',
};
export function tourForView(viewId) {
  return VIEW_TOUR[viewId] || null;
}

export function stepTitleKey(tourId, step) {
  return `tour.${tourId}.${step.key}.title`;
}
export function stepBodyKey(tourId, step) {
  return `tour.${tourId}.${step.key}.body`;
}

// ---------------- saved state (profiles.preferences.tours) ----------------

const STATUSES = ['done', 'skipped'];

/** { seen: { [tourId]: 'done'|'skipped' }, offered: { [tourId]: true }, tips: boolean } */
export function normalizeTourState(raw) {
  const out = { seen: {}, offered: {}, tips: true };
  if (!raw || typeof raw !== 'object') return out;
  if (raw.seen && typeof raw.seen === 'object') {
    TOUR_IDS.forEach((id) => { if (STATUSES.includes(raw.seen[id])) out.seen[id] = raw.seen[id]; });
  }
  if (raw.offered && typeof raw.offered === 'object') {
    TOUR_IDS.forEach((id) => { if (raw.offered[id] === true) out.offered[id] = true; });
  }
  if (raw.tips === false) out.tips = false;
  return out;
}

export function markTour(state, tourId, status) {
  const s = normalizeTourState(state);
  if (!TOUR_IDS.includes(tourId) || !STATUSES.includes(status)) return s;
  return { ...s, seen: { ...s.seen, [tourId]: status }, offered: { ...s.offered, [tourId]: true } };
}

export function markOffered(state, tourId) {
  const s = normalizeTourState(state);
  if (!TOUR_IDS.includes(tourId)) return s;
  return { ...s, offered: { ...s.offered, [tourId]: true } };
}

/**
 * Offer a page's guide (once, ever) the first time someone opens that page —
 * never during onboarding, never if tips are off, never twice.
 */
export function shouldOfferTour(state, tourId, { onboardingOpen = false } = {}) {
  const s = normalizeTourState(state);
  if (onboardingOpen || !s.tips || !TOUR_IDS.includes(tourId)) return false;
  return !s.seen[tourId] && !s.offered[tourId];
}

// ---------------- navigation ----------------

/**
 * Next step index to show, given a predicate telling whether a step can be
 * shown now (its target exists and is visible, or it has no target).
 * Moves in `dir` (+1 / -1) from `from` (exclusive); returns -1 when there is
 * no such step (past the end, or before the start).
 */
export function nextVisibleStep(steps, from, dir, canShow) {
  for (let i = from + dir; i >= 0 && i < steps.length; i += dir) {
    if (canShow(steps[i], i)) return i;
  }
  return -1;
}

/** The steps that can be shown right now (for "2 of 5" counts). */
export function visibleSteps(steps, canShow) {
  return steps.map((s, i) => (canShow(s, i) ? i : -1)).filter((i) => i >= 0);
}

/** "n of total" for the step at `index` among the visible ones (1-based). */
export function stepPosition(visible, index) {
  const pos = visible.indexOf(index);
  return { n: pos + 1, total: visible.length };
}

/**
 * Where to put the card relative to the highlighted rectangle.
 * Pure geometry so it can be tested: returns { placement, top, left }.
 * @param {{top,left,width,height}|null} rect   highlighted area (viewport px)
 * @param {{width,height}} card                  card size
 * @param {{width,height}} viewport
 * @param {number} [gap]
 */
export function placeCard(rect, card, viewport, gap = 14) {
  const margin = 12;
  const clampX = (x) => Math.max(margin, Math.min(x, viewport.width - card.width - margin));
  const clampY = (y) => Math.max(margin, Math.min(y, viewport.height - card.height - margin));
  if (!rect) {
    return { placement: 'center', top: clampY((viewport.height - card.height) / 2), left: clampX((viewport.width - card.width) / 2) };
  }
  const below = viewport.height - (rect.top + rect.height) - gap;
  const above = rect.top - gap;
  const centerX = rect.left + rect.width / 2 - card.width / 2;
  if (below >= card.height) return { placement: 'bottom', top: rect.top + rect.height + gap, left: clampX(centerX) };
  if (above >= card.height) return { placement: 'top', top: rect.top - gap - card.height, left: clampX(centerX) };
  const right = viewport.width - (rect.left + rect.width) - gap;
  if (right >= card.width) return { placement: 'right', top: clampY(rect.top), left: rect.left + rect.width + gap };
  const left = rect.left - gap;
  if (left >= card.width) return { placement: 'left', top: clampY(rect.top), left: rect.left - gap - card.width };
  // Nothing fits (a tall element on a small screen): overlap the bottom.
  return { placement: 'overlay', top: clampY(viewport.height - card.height - margin), left: clampX(centerX) };
}
