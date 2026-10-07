import { createClient } from '@supabase/supabase-js';
import { syncDemoFlagFromUrl, isDemoMode } from '../demo/demoMode.js';
import { createMemoryClient } from '../demo/memoryClient.js';
import { buildDemoSeed, DEMO_USER_ID, DEMO_EMAIL } from '../demo/demoSeed.js';

// Demo Mode (V3): when the current tab is in demo mode (dashboard.html?demo=1),
// the whole app talks to an in-memory client seeded with sample data
// instead of Supabase. The real client is never even created in that case,
// so demo actions cannot read or write anyone's real account.
syncDemoFlagFromUrl();

function createDemoClient() {
  // Dev-only switch for QA: simulate a database where the V3 migrations
  // haven't been applied yet (?premigration=v3).
  const missing = new Set();
  if (import.meta.env.DEV && new URLSearchParams(location.search).get('premigration') === 'v3') {
    ['semesters', 'courses', 'grade_categories', 'grade_items', 'exams', 'exam_topics', 'task_dependencies', 'task_recurrence_rules', 'resources', 'focus_sessions']
      .forEach((name) => missing.add(name));
  }
  return createMemoryClient({
    seed: () => buildDemoSeed(new Date()),
    session: { user: { id: DEMO_USER_ID, email: DEMO_EMAIL, user_metadata: { name: 'Jordan' } }, access_token: 'demo' },
    missingTables: missing,
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
