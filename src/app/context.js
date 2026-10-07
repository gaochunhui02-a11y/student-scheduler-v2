// Shared services for V3 page modules. dashboard.js fills this in once at
// startup (setAppContext) with the user id and the navigation/refresh
// hooks it owns; V3 modules call app().navigate(...), app().refreshPlanner()
// etc. instead of reaching into dashboard.js internals. Same bridge idea
// as V2's per-section hostApi objects, without threading a dozen
// callbacks through every constructor.

const ctx = {
  userId: null,
  displayName: '',
  isDemo: false,
  navigate: () => {},
  openCourse: () => {},
  openPlannerForDate: () => {},
  refreshPlanner: () => {},
  plannerDate: () => null,
  openQuickAdd: () => {},
  onDataChanged: () => {},
};

const listeners = new Set();

export function setAppContext(patch) {
  Object.assign(ctx, patch);
}

export function app() {
  return ctx;
}

// Lightweight change bus: modules call emitChange('courses') after a write
// so other mounted views (Dashboard, palette index…) can refresh lazily.
export function emitChange(topic) {
  listeners.forEach((fn) => {
    try {
      fn(topic);
    } catch (err) {
      console.error('change listener failed', err);
    }
  });
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
