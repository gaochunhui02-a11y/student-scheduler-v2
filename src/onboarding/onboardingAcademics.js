// V3 onboarding writes: semester, courses and weekly classes, through the
// same data functions the Semester and Courses pages use. Anything whose
// database feature is missing is skipped silently (the V2 steps still run).

import { has } from '../shared/capabilities.js';
import { createSemester, setCurrentSemester, createCourse, listCourses, createCourseMeeting } from '../academics/academicsData.js';
import { pickCourseColor } from '../academics/courseModel.js';

/**
 * @param {string} userId
 * @param {ReturnType<import('../dashboard/onboardingModel.js').buildOnboardingAcademics>} academics
 * @returns {Promise<{ courseIds: Array<string|null> }>} ids aligned with academics.courses
 */
export async function applyOnboardingAcademics(userId, academics) {
  const courseIds = [];
  if (!academics) return { courseIds };
  let semesterId = null;
  if (academics.semester && has('semesters')) {
    const sem = await createSemester(userId, { ...academics.semester, breaks: [] });
    semesterId = sem.id;
    await setCurrentSemester(userId, sem.id);
  }
  if (has('courses')) {
    const existing = await listCourses(userId).catch(() => []);
    const all = [...existing];
    for (const c of academics.courses) {
      const color = pickCourseColor(all);
      const row = await createCourse(userId, { name: c.name, code: c.code, color, semester_id: semesterId });
      all.push(row);
      courseIds.push(row.id);
    }
  }
  for (const cls of academics.weeklyClasses) {
    const { courseIndex, ...fields } = cls;
    const courseId = courseIndex !== null && courseIds[courseIndex] ? courseIds[courseIndex] : null;
    await createCourseMeeting(userId, { ...fields, ...(courseId && has('classCourseLinks') ? { course_id: courseId } : {}) });
  }
  return { courseIds };
}
