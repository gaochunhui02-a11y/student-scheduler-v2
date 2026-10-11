// Workspace modes and module visibility (V4-A). Pure — no DOM, no Supabase.
//
// "Simple by default, advanced when needed": a workspace mode (School, Work,
// Personal, Self-study, Multiple areas) decides which pages appear in the
// navigation by default; the student can switch any module on or off.
//
// An account that has never chosen a mode is a LEGACY (V3) account: it keeps
// exactly the V3 navigation — nothing disappears, and new V4 pages
// (Projects…) don't appear until the student turns them on or picks a mode.

export const MODES = ['school', 'work', 'personal', 'selfstudy', 'multiple'];

// Sections, in sidebar order.
export const SECTIONS = ['home', 'plan', 'work', 'academics', 'organize', 'review'];

// Every page the navigation can show. `built: false` = arrives in a later
// V4 checkpoint; it is never shown until it exists. `core` modules can't be
// switched off (the app is unusable without them).
export const MODULES = [
  { id: 'home', v3: true, section: 'home', view: 'analyticsView', labelKey: 'nav.home', built: true, core: true },
  { id: 'today', section: 'home', view: 'todayView', labelKey: 'nav.today', built: true },
  { id: 'planner', v3: true, section: 'plan', view: 'plannerForm', labelKey: 'nav.planner', built: true, core: true },
  { id: 'week', v3: true, section: 'plan', view: 'weekView', labelKey: 'nav.week', built: true },
  { id: 'calendar', v3: true, section: 'plan', view: 'calendarView', labelKey: 'nav.calendar', built: true },
  { id: 'semester', v3: true, section: 'plan', view: 'semesterView', labelKey: 'nav.semester', built: true },
  { id: 'tasks', v3: true, section: 'work', view: 'tasksView', labelKey: 'nav.tasks', built: true },
  { id: 'projects', section: 'work', view: 'projectsView', labelKey: 'nav.projects', built: true },
  { id: 'goals', section: 'work', view: 'goalsView', labelKey: 'nav.goals', built: true },
  { id: 'routines', section: 'work', view: 'routinesView', labelKey: 'nav.routines', built: true },
  { id: 'courses', v3: true, section: 'academics', view: 'coursesView', labelKey: 'nav.courses', built: true },
  { id: 'exams', v3: true, section: 'academics', view: 'examsView', labelKey: 'nav.exams', built: true },
  { id: 'grades', v3: true, section: 'academics', view: 'gradesView', labelKey: 'nav.grades', built: true },
  { id: 'board', v3: true, section: 'organize', view: 'boardView', labelKey: 'nav.boards', built: true },
  { id: 'notes', section: 'organize', view: 'notesView', labelKey: 'nav.notes', built: false },
  { id: 'history', v3: true, section: 'review', view: 'historyView', labelKey: 'nav.history', built: true },
  { id: 'insights', v3: true, section: 'review', view: 'insightsView', labelKey: 'nav.insights', built: true },
  { id: 'review', section: 'review', view: 'reviewView', labelKey: 'nav.weeklyReview', built: true },
];

const ALL = MODULES.map((m) => m.id);

// Default modules per mode (spec §3). Unbuilt ones are listed so they appear
// automatically when their checkpoint lands.
export const MODE_DEFAULTS = {
  school: ['home', 'today', 'planner', 'week', 'calendar', 'semester', 'tasks', 'courses', 'exams', 'grades', 'board', 'insights', 'review'],
  work: ['home', 'today', 'planner', 'week', 'calendar', 'tasks', 'projects', 'goals', 'board', 'insights', 'review'],
  personal: ['home', 'today', 'planner', 'calendar', 'tasks', 'goals', 'routines', 'insights', 'review'],
  selfstudy: ['home', 'today', 'planner', 'week', 'calendar', 'tasks', 'goals', 'routines', 'exams', 'board', 'insights', 'review'],
  multiple: ALL,
};

export function moduleById(id) {
  return MODULES.find((m) => m.id === id) || null;
}

export function moduleForView(view) {
  return MODULES.find((m) => m.view === view) || null;
}

/**
 * Cleans whatever is stored in profiles.preferences.workspace (or the local
 * cache) into a known shape. Unknown keys and values are dropped.
 * @returns {{ mode: string|null, modules: Object<string, boolean>, defaultSpaceId: string|null }}
 */
export function normalizeWorkspace(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const mode = MODES.includes(src.mode) ? src.mode : null;
  const modules = {};
  if (src.modules && typeof src.modules === 'object' && !Array.isArray(src.modules)) {
    Object.entries(src.modules).forEach(([id, on]) => {
      const m = moduleById(id);
      if (m && !m.core && typeof on === 'boolean') modules[id] = on;
    });
  }
  const defaultSpaceId = typeof src.defaultSpaceId === 'string' && /^[0-9a-f-]{36}$/i.test(src.defaultSpaceId) ? src.defaultSpaceId : null;
  return { mode, modules, defaultSpaceId };
}

/** Legacy = never chose a mode: show everything V3 showed. */
export function isLegacyWorkspace(ws) {
  return !ws || !ws.mode;
}

/** Is a module switched on (ignores whether it is built yet)? */
export function isModuleEnabled(ws, id) {
  const m = moduleById(id);
  if (!m) return false;
  if (m.core) return true;
  const w = ws || {};
  if (w.modules && typeof w.modules[id] === 'boolean') return w.modules[id];
  if (isLegacyWorkspace(w)) return Boolean(m.v3);
  return (MODE_DEFAULTS[w.mode] || ALL).includes(id);
}

/** Modules to show in the navigation: enabled AND built, in sidebar order. */
export function visibleModules(ws) {
  return MODULES.filter((m) => m.built && isModuleEnabled(ws, m.id)).map((m) => m.id);
}

/**
 * Switching mode resets per-module overrides that just restate the new
 * mode's default, but keeps the student's deliberate differences.
 */
export function withMode(ws, mode) {
  if (!MODES.includes(mode)) return ws;
  const base = normalizeWorkspace(ws);
  const defaults = MODE_DEFAULTS[mode];
  const modules = {};
  Object.entries(base.modules).forEach(([id, on]) => {
    if (on !== defaults.includes(id)) modules[id] = on;
  });
  return { ...base, mode, modules };
}

export function withModule(ws, id, on) {
  const m = moduleById(id);
  const base = normalizeWorkspace(ws);
  if (!m || m.core) return base;
  // A legacy account that starts customising becomes "multiple" so its choice
  // is remembered; V4 modules it never had stay off unless switched on here.
  const mode = base.mode || 'multiple';
  const modules = { ...base.modules };
  if (!base.mode) MODULES.filter((x) => !x.v3 && !x.core).forEach((x) => { if (!(x.id in modules)) modules[x.id] = false; });
  const def = MODE_DEFAULTS[mode].includes(id);
  if (on === def) delete modules[id];
  else modules[id] = Boolean(on);
  return { ...base, mode, modules };
}

/** Sidebar sections that have at least one visible module. */
export function visibleSections(ws) {
  const vis = new Set(visibleModules(ws));
  return SECTIONS.filter((s) => MODULES.some((m) => m.section === s && vis.has(m.id)));
}
