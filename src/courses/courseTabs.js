// Course page tab registry. Grades, Exams and Resources live in their own
// modules and plug a tab into each course page through here, so the course
// page organises those systems without owning (or duplicating) them.

const tabs = [];

/**
 * @param {{ id:string, order:number, labelKey:string, render:(container:HTMLElement, ctx:{course:object, refresh:Function}) => (void|Promise<void>), count?:(course)=>Promise<number|null> }} tab
 */
export function registerCourseTab(tab) {
  const existing = tabs.findIndex((x) => x.id === tab.id);
  if (existing >= 0) tabs.splice(existing, 1, tab);
  else tabs.push(tab);
  tabs.sort((a, b) => a.order - b.order);
}

export function courseTabs() {
  return tabs.slice();
}

// Small widgets other modules add to a course's Overview (e.g. the grade
// summary card, next exam). Each returns an html fragment or ''.
const overviewWidgets = [];
export function registerCourseOverviewWidget(widget) {
  if (!overviewWidgets.some((w) => w.id === widget.id)) overviewWidgets.push(widget);
  overviewWidgets.sort((a, b) => a.order - b.order);
}
export function courseOverviewWidgets() {
  return overviewWidgets.slice();
}

// Per-course figures shown on the Courses list cards (e.g. current grade).
const cardProviders = [];
export function registerCourseCardProvider(provider) {
  if (!cardProviders.some((p) => p.id === provider.id)) cardProviders.push(provider);
}
export function courseCardProviders() {
  return cardProviders.slice();
}
