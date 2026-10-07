// V3 onboarding writes: semester, courses and weekly classes, through the
// same data functions the Semester and Courses pages use. Anything whose
// database feature is missing is skipped silently (the V2 steps still run).

import { has } from '../shared/capabilities.js';
import { createSemester, setCurrentSemester, createCourse, listCourses, createCourseMeeting, setClassCourse } from '../academics/academicsData.js';
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
      const row = await createCourse(userId, { name: c.name, code: c.code, color, semester_id: semesterId, ...(academics.spaceId && has('spaceLinks') ? { space_id: academics.spaceId } : {}) });
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

/**
 * After the Planner saved today's one-off classes: link each to the course
 * picked for it. classIds line up with academics.classCourse.
 */
export async function linkOnboardingClasses(classIds, academics, courseIds) {
  if (!academics || !has('classCourseLinks')) return;
  await Promise.all(classIds.map((id, i) => {
    const idx = academics.classCourse[i];
    return id && idx !== null && idx !== undefined && courseIds[idx] ? setClassCourse(id, courseIds[idx]) : null;
  }));
}
