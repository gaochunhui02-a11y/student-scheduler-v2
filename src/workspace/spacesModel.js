// Spaces (V4-A), pure. A space is an area of life: School, Work, Personal…
// Items point at a space with a nullable space_id; a task without its own
// space inherits its course's space, so existing academic data shows up in
// a School space as soon as its courses are put there.

export const SPACE_ICONS = ['school', 'briefcase', 'home', 'heart', 'dumbbell', 'language', 'code', 'book', 'flask', 'music', 'leaf', 'star', 'circle'];
export const SPACE_COLORS = ['#3b6fe0', '#0f9488', '#c27c0a', '#d9466b', '#7c5ce0', '#2f9e57', '#e06a2c', '#0e93b8'];
export const SPACE_NAME_MAX = 60;
export const NO_SPACE = '__none';

export function validateSpaceFields(input = {}) {
  const errors = {};
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) errors.name = 'spaces.errName';
  else if (name.length > SPACE_NAME_MAX) errors.name = 'spaces.errNameLong';
  const icon = SPACE_ICONS.includes(input.icon) ? input.icon : 'circle';
  const color = typeof input.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.color) ? input.color : null;
  return { ok: Object.keys(errors).length === 0, errors, fields: { name, icon, color } };
}

/** The space an item belongs to: its own, else its course's, else none. */
export function effectiveSpaceId(item, courseById = new Map()) {
  if (!item) return null;
  const own = item.spaceId !== undefined ? item.spaceId : item.space_id;
  if (own) return own;
  const courseId = item.courseId !== undefined ? item.courseId : item.course_id;
  const course = courseId ? courseById.get(courseId) : null;
  return (course && course.space_id) || null;
}

/**
 * @param {string|null} itemSpaceId
 * @param {string|null} filter  null = all spaces, NO_SPACE = items without one, else a space id
 */
export function matchesSpace(itemSpaceId, filter) {
  if (!filter) return true;
  if (filter === NO_SPACE) return !itemSpaceId;
  return itemSpaceId === filter;
}

export function sortSpaces(spaces = []) {
  return spaces.slice().sort((a, b) => Number(a.archived) - Number(b.archived) || (a.sort_order || 0) - (b.sort_order || 0) || String(a.name).localeCompare(String(b.name)));
}

/** A stored filter that points at a space that no longer exists/is archived falls back to "all". */
export function resolveSpaceFilter(filter, spaces = []) {
  if (!filter) return null;
  if (filter === NO_SPACE) return NO_SPACE;
  return spaces.some((s) => s.id === filter && !s.archived) ? filter : null;
}

// The space a workspace mode suggests creating (onboarding / Settings).
export const MODE_SPACE = {
  school: { nameKey: 'spaces.defaultSchool', icon: 'school', color: '#3b6fe0' },
  work: { nameKey: 'spaces.defaultWork', icon: 'briefcase', color: '#0f9488' },
  personal: { nameKey: 'spaces.defaultPersonal', icon: 'home', color: '#d9466b' },
  selfstudy: { nameKey: 'spaces.defaultSelfStudy', icon: 'book', color: '#7c5ce0' },
};

/**
 * "Put my courses in a School space": which courses would move. Only courses
 * that have no space yet — a course the student already placed is never
 * moved. Pure, so the preview and the write use the same list.
 */
export function coursesToAssign(courses = [], targetSpaceId) {
  return courses.filter((c) => !c.space_id && c.id && targetSpaceId);
}
