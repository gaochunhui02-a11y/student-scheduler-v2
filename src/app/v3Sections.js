// Registry of the V3 page modules. dashboard.js asks for these once at
// startup and treats each like any V2 section: { onShow(param) }.
// Each page owns its own <section id="…View"> container.

import { setHtml } from '../ui/dom.js';
import { pageHead, emptyState } from '../ui/components.js';
import { t } from '../shared/i18n.js';
import { initCoursesPage } from '../courses/coursesPage.js';
import { initSemesterPage } from '../semester/semesterPage.js';
import { initGradesPage } from '../grades/gradesUI.js';
import { initExamsPage } from '../exams/examsPage.js';
import { initTasksPage } from '../tasks/tasksPage.js';
import { initProjectsPage } from '../projects/projectsPage.js';
import { initGoalsPage } from '../goals/goalsPage.js';
import { initTodayPage } from '../today/todayPage.js';
import { initReviewPage } from '../review/reviewPage.js';
import { initNotesPage } from '../notes/notesPage.js';
import '../notes/linkedPanels.js';
import { initRoutinesPage } from '../routines/routinesPage.js';
import '../tasks/taskEditorSections.js';
import '../resources/resourcesUI.js';
import '../board/boardCourseWidget.js';
import '../attendance/attendanceUI.js';

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
    tasksView: initTasksPage(),
    projectsView: initProjectsPage(),
    goalsView: initGoalsPage(),
    todayView: initTodayPage(),
    reviewView: initReviewPage(),
    notesView: initNotesPage(),
    routinesView: initRoutinesPage(),
    gradesView: initGradesPage(),
    examsView: initExamsPage(),
    semesterView: initSemesterPage(),
  };
}
