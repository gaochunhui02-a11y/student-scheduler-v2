// Registry of the V3 page modules. dashboard.js asks for these once at
// startup and treats each like any V2 section: { onShow(param) }.
// Each page owns its own <section id="…View"> container.

import { setHtml } from '../ui/dom.js';
import { pageHead, emptyState } from '../ui/components.js';
import { t } from '../shared/i18n.js';

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
    coursesView: placeholderSection('coursesView', 'nav.courses'),
    tasksView: placeholderSection('tasksView', 'nav.tasks'),
    gradesView: placeholderSection('gradesView', 'nav.grades'),
    examsView: placeholderSection('examsView', 'nav.exams'),
    semesterView: placeholderSection('semesterView', 'nav.semester'),
  };
}
