// Registry of the V3 page modules. dashboard.js asks for these once at
// startup and treats each like any V2 section: { onShow(param) }.
// Each page owns its own <section id="…View"> container.

import { setHtml } from '../ui/dom.js';
import { pageHead, emptyState } from '../ui/components.js';
import { t } from '../shared/i18n.js';
import { initCoursesPage } from '../courses/coursesPage.js';
import { initSemesterPage } from '../semester/semesterPage.js';
import { initGradesPage } from '../grades/gradesUI.js';

function placeholderSection(viewId, titleKey) {
  const root = document.getElementById(viewId);
  return {
    onShow() {
      setHtml(root, [pageHead({ title: t(titleKey) }), emptyState({ title: t(titleKey) })]);
    },
  };
}

export function initV3Sections() {
  return {
    coursesView: initCoursesPage(),
    tasksView: placeholderSection('tasksView', 'nav.tasks'),
    gradesView: initGradesPage(),
    examsView: placeholderSection('examsView', 'nav.exams'),
    semesterView: initSemesterPage(),
  };
}
