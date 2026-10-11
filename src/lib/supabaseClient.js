import { createClient } from '@supabase/supabase-js';
import { syncDemoFlagFromUrl, isDemoMode } from '../demo/demoMode.js';
import { createMemoryClient } from '../demo/memoryClient.js';
import { buildDemoSeed, DEMO_USER_ID, DEMO_EMAIL } from '../demo/demoSeed.js';

// Demo Mode (V3): when the current tab is in demo mode (dashboard.html?demo=1),
// the whole app talks to an in-memory client seeded with sample data
// instead of Supabase. The real client is never even created in that case,
// so demo actions cannot read or write anyone's real account.
syncDemoFlagFromUrl();

// V4 migrations in order, with what each adds (for the QA switch below).
const V4_STEPS = [
  { level: 'v4', tables: ['spaces', 'projects', 'project_milestones'], columns: { study_subjects: ['space_id', 'project_id', 'project_milestone_id', 'due_time', 'start_time', 'status_override', 'project_sort', 'planned_by'], courses: ['space_id'], boards: ['space_id'] } }, // 0018–0021
  { level: 'v4c', tables: ['goals', 'goal_milestones', 'goal_progress_log', 'routines', 'routine_completions'], columns: { study_subjects: ['goal_id'], projects: ['goal_id'] } }, // 0022–0023
  { level: 'v4g', tables: ['attendance_records'], columns: {} }, // 0024
  { level: 'v4h', tables: ['notes'], columns: { resources: ['project_id', 'goal_id', 'exam_id', 'space_id', 'in_library', 'favorite', 'tags'] } }, // 0025–0026
];

function createDemoClient() {
  // Dev-only switch for QA: simulate a database where migrations haven't
  // been applied yet. ?premigration=v3 = no V3 migrations either;
  // v4 = a V3 database (no 0018+); v4c = a V4-B database (no 0022+);
  // v4g = no 0024+; v4h = no 0025+.
  const missing = new Set();
  const missingColumns = {};
  const pre = import.meta.env.DEV ? new URLSearchParams(location.search).get('premigration') : null;
  if (pre === 'v3') {
    ['semesters', 'courses', 'grade_categories', 'grade_items', 'exams', 'exam_topics', 'task_dependencies', 'task_recurrence_rules', 'resources', 'focus_sessions']
      .forEach((name) => missing.add(name));
  }
  const from = pre === 'v3' ? 0 : V4_STEPS.findIndex((s) => s.level === pre);
  if (from >= 0) {
    V4_STEPS.slice(from).forEach((step) => {
      step.tables.forEach((name) => missing.add(name));
      Object.entries(step.columns).forEach(([tbl, cols]) => { missingColumns[tbl] = [...(missingColumns[tbl] || []), ...cols]; });
    });
  }
  return createMemoryClient({
    seed: () => buildDemoSeed(new Date()),
    session: { user: { id: DEMO_USER_ID, email: DEMO_EMAIL, user_metadata: { name: 'Jordan' } }, access_token: 'demo' },
    missingTables: missing,
    missingColumns,
  });
}

function createRealClient() {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      'Missing Supabase environment variables. Copy .env.example to .env and fill in ' +
      'VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY from your Supabase project settings.'
    );
  }
  return createClient(supabaseUrl, supabaseKey);
}

export const IS_DEMO = isDemoMode();
export const supabase = IS_DEMO ? createDemoClient() : createRealClient();
