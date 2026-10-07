// Which V3 database features exist yet. V3's tables/columns arrive through
// migrations 0010–0017, which the owner applies by hand after review — so
// the app must keep working (as V2) on a database that doesn't have them.
//
// probeCapabilities() runs one tiny, zero-row SELECT per feature at startup
// (in parallel) and remembers the answers for the session. Each feature's
// UI checks has(name) and shows a calm "needs a database update" note
// instead of failing.

import { supabase } from '../lib/supabaseClient.js';

// feature -> [table, column list to probe]
const PROBES = {
  semesters: ['semesters', 'id, breaks, is_current'],
  courses: ['courses', 'id, semester_id, color'],
  courseLinks: ['study_subjects', 'id, course_id'],
  classCourseLinks: ['class_series', 'id, course_id'],
  boardCourseLinks: ['board_nodes', 'id, course_id'],
  grades: ['grade_items', 'id, earned_points, counts'],
  exams: ['exam_topics', 'id, confidence, completed_minutes'],
  taskExtensions: ['study_subjects', 'id, completed_at, actual_minutes, dependency_override, exam_topic_id, recurrence_rule_id'],
  dependencies: ['task_dependencies', 'id, depends_on_id'],
  recurringTasks: ['task_recurrence_rules', 'id, days_of_week'],
  resources: ['resources', 'id, url, kind'],
  focusSessions: ['focus_sessions', 'id, actual_minutes, outcome'],
  preferences: ['profiles', 'id, preferences'],
  // V4
  spaces: ['spaces', 'id, icon, archived'],
  spaceLinks: ['study_subjects', 'id, space_id'],
  projects: ['project_milestones', 'id, project_id, status'],
  projectLinks: ['study_subjects', 'id, project_id, project_milestone_id'],
  taskFieldsV4: ['study_subjects', 'id, due_time, start_time, status_override, project_sort'],
  unscheduledTasks: ['study_subjects', 'id, planned_by'],
};

// Which migration file provides each feature (shown in Settings → About).
export const FEATURE_MIGRATIONS = {
  semesters: '0010_semesters.sql',
  courses: '0011_courses.sql',
  courseLinks: '0011_courses.sql',
  classCourseLinks: '0011_courses.sql',
  boardCourseLinks: '0011_courses.sql',
  grades: '0012_grades.sql',
  exams: '0013_exams.sql',
  taskExtensions: '0014_task_extensions.sql',
  dependencies: '0014_task_extensions.sql',
  recurringTasks: '0014_task_extensions.sql',
  resources: '0015_resources.sql',
  focusSessions: '0016_focus_sessions.sql',
  preferences: '0017_profile_preferences.sql',
  spaces: '0018_spaces.sql',
  spaceLinks: '0018_spaces.sql',
  projects: '0019_projects.sql',
  projectLinks: '0019_projects.sql',
  taskFieldsV4: '0020_task_fields.sql',
  unscheduledTasks: '0021_unscheduled_tasks.sql',
};

let state = null;
let pending = null;

export async function probeCapabilities() {
  if (state) return state;
  if (pending) return pending;
  pending = (async () => {
    const entries = await Promise.all(
      Object.entries(PROBES).map(async ([feature, [tableName, columns]]) => {
        try {
          const { error } = await supabase.from(tableName).select(columns).limit(0);
          return [feature, !error];
        } catch {
          return [feature, false];
        }
      })
    );
    state = Object.fromEntries(entries);
    return state;
  })();
  return pending;
}

export function has(feature) {
  return Boolean(state && state[feature]);
}

export function capabilitySnapshot() {
  return state ? { ...state } : {};
}

export function missingMigrations() {
  if (!state) return [];
  return [...new Set(Object.entries(state).filter(([, ok]) => !ok).map(([f]) => FEATURE_MIGRATIONS[f]))].sort();
}

// For tests only.
export function __setCapabilities(next) {
  state = next ? { ...next } : null;
  pending = null;
}
