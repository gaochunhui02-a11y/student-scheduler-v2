// Customizable dashboard (V4-D), pure — no DOM, no Supabase.
//
// The Home dashboard is a list of widgets. Which ones show, and in what
// order, is stored in profiles.preferences.dashboard as
//   { order: ['now', 'top3', …], hidden: ['exams', …] }
// Nothing stored = the default for the workspace mode. An account that has
// never chosen a mode (legacy V3) gets exactly the V3 dashboard.
// Widgets whose feature isn't available (database not migrated, module
// switched off) are skipped when rendering but keep their place.

export const WIDGETS = [
  { id: 'now', labelKey: 'dash.w_now', size: 'sm' },
  { id: 'top3', labelKey: 'dash.w_top3', size: 'sm' },
  { id: 'progress', labelKey: 'dash.w_progress', size: 'sm' },
  { id: 'urgent', labelKey: 'dash.w_urgent', size: 'sm' },
  { id: 'routines', labelKey: 'dash.w_routines', size: 'sm', needs: 'routines' },
  { id: 'deadlines', labelKey: 'dash.w_deadlines', size: 'sm' },
  { id: 'exams', labelKey: 'dash.w_exams', size: 'sm', module: 'exams' },
  { id: 'headsUp', labelKey: 'dash.w_headsUp', size: 'sm' },
  { id: 'projects', labelKey: 'dash.w_projects', size: 'sm', needs: 'projects' },
  { id: 'goals', labelKey: 'dash.w_goals', size: 'sm', needs: 'goals' },
  { id: 'overview', labelKey: 'dash.w_overview', size: 'lg', module: 'courses' },
];
const IDS = WIDGETS.map((w) => w.id);

// The V3 dashboard, card for card.
const V3 = ['now', 'progress', 'urgent', 'deadlines', 'exams', 'headsUp', 'overview'];

export const MODE_WIDGETS = {
  legacy: V3,
  school: ['now', 'top3', 'progress', 'urgent', 'deadlines', 'exams', 'headsUp', 'overview'],
  work: ['now', 'top3', 'progress', 'urgent', 'projects', 'goals', 'deadlines', 'headsUp'],
  personal: ['now', 'top3', 'routines', 'goals', 'urgent', 'deadlines'],
  selfstudy: ['now', 'top3', 'routines', 'progress', 'goals', 'exams', 'deadlines', 'headsUp'],
  multiple: ['now', 'top3', 'progress', 'urgent', 'routines', 'deadlines', 'exams', 'headsUp', 'projects', 'goals', 'overview'],
};

export function widgetById(id) {
  return WIDGETS.find((w) => w.id === id) || null;
}

function defaultsFor(mode) {
  return MODE_WIDGETS[mode] || MODE_WIDGETS.legacy;
}

/** Cleans a stored value; null = "never customized". */
export function normalizeDashboard(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.order)) return null;
  const order = [...new Set(raw.order.filter((id) => IDS.includes(id)))];
  const hidden = [...new Set((Array.isArray(raw.hidden) ? raw.hidden : []).filter((id) => IDS.includes(id)))];
  return { order, hidden };
}

/** Full ordered state for the mode: every widget, with on/off. */
export function resolveDashboard(stored, mode) {
  const dash = normalizeDashboard(stored);
  const defaults = defaultsFor(mode);
  if (!dash) {
    const rest = IDS.filter((id) => !defaults.includes(id));
    return [...defaults.map((id) => ({ id, on: true })), ...rest.map((id) => ({ id, on: false }))];
  }
  // Widgets added after the student customized go to the end, switched off.
  const order = [...dash.order, ...IDS.filter((id) => !dash.order.includes(id))];
  const known = new Set(dash.order);
  return order.map((id) => ({ id, on: known.has(id) && !dash.hidden.includes(id) }));
}

/**
 * Widgets to render, in order.
 * @param {(w) => boolean} isAvailable  feature/module check per widget
 */
export function visibleWidgets(stored, mode, isAvailable = () => true) {
  return resolveDashboard(stored, mode).filter((x) => x.on).map((x) => widgetById(x.id)).filter((w) => w && isAvailable(w));
}

function toStored(list) {
  return { order: list.map((x) => x.id), hidden: list.filter((x) => !x.on).map((x) => x.id) };
}

export function setWidget(stored, mode, id, on) {
  return toStored(resolveDashboard(stored, mode).map((x) => (x.id === id ? { ...x, on: Boolean(on) } : x)));
}

/** Moves a widget up/down among all widgets (shown and hidden keep one order). */
export function moveWidget(stored, mode, id, direction) {
  const list = resolveDashboard(stored, mode);
  const i = list.findIndex((x) => x.id === id);
  const j = i + (direction === 'up' ? -1 : 1);
  if (i < 0 || j < 0 || j >= list.length) return toStored(list);
  [list[i], list[j]] = [list[j], list[i]];
  return toStored(list);
}

/** Is the stored layout the same as the mode's default? */
export function isDefaultDashboard(stored, mode) {
  const a = resolveDashboard(stored, mode);
  const b = resolveDashboard(null, mode);
  return a.every((x, i) => x.id === b[i].id && x.on === b[i].on);
}
