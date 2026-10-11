// Hash routes for the single-page dashboard, so pages are linkable, the
// browser Back button works, and a reload returns to the same page.
// Pure mapping functions are exported for tests.
//
//   #/home  #/courses  #/courses/<id>  #/tasks  #/grades  #/exams
//   #/planner  #/week  #/semester  #/calendar  #/boards  #/history
//   #/insights  #/settings  #/settings/<tab>

export const ROUTES = {
  home: 'analyticsView',
  courses: 'coursesView',
  tasks: 'tasksView',
  projects: 'projectsView',
  today: 'todayView',
  review: 'reviewView',
  goals: 'goalsView',
  routines: 'routinesView',
  grades: 'gradesView',
  exams: 'examsView',
  planner: 'plannerForm',
  week: 'weekView',
  semester: 'semesterView',
  calendar: 'calendarView',
  boards: 'boardView',
  history: 'historyView',
  insights: 'insightsView',
  settings: 'settingsView',
};

const VIEW_TO_SLUG = Object.fromEntries(Object.entries(ROUTES).map(([slug, view]) => [view, slug]));

// "#/courses/abc" -> { view: 'coursesView', slug: 'courses', param: 'abc' }
export function parseHash(hash) {
  const clean = String(hash || '').replace(/^#\/?/, '');
  if (!clean) return null;
  const [slug, ...rest] = clean.split('/');
  const view = ROUTES[slug];
  if (!view) return null;
  const param = rest.length ? decodeURIComponent(rest.join('/')) : null;
  // Params are ids, dates or "<id>:<tab>" — nothing else is accepted.
  return { view, slug, param: param && /^[\w:-]{1,80}$/.test(param) ? param : null };
}

export function buildHash(view, param = null) {
  const slug = VIEW_TO_SLUG[view];
  if (!slug) return '';
  return `#/${slug}${param ? `/${encodeURIComponent(param)}` : ''}`;
}

// Records a navigation in browser history without triggering our own
// hashchange handling twice.
let suppressNext = false;
export function pushRoute(view, param = null, { replace = false } = {}) {
  const next = buildHash(view, param);
  if (!next || location.hash === next) return;
  suppressNext = true;
  if (replace) history.replaceState(null, '', next);
  else history.pushState(null, '', next);
  // pushState doesn't fire hashchange; reset the guard on the next tick.
  setTimeout(() => { suppressNext = false; }, 0);
}

export function onRouteChange(handler) {
  window.addEventListener('popstate', () => {
    if (suppressNext) return;
    const route = parseHash(location.hash);
    if (route) handler(route);
  });
}
