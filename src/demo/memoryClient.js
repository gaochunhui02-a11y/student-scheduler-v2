// In-memory stand-in for the Supabase client, used ONLY by Demo Mode
// (see src/lib/supabaseClient.js). It implements the small slice of the
// query-builder API this app actually calls — from/select/insert/update/
// upsert/delete with eq/neq/in/gte/lte/is/not/or/order/limit/single/
// maybeSingle — against plain arrays, applying each table's column
// defaults on insert.
//
// Isolation guarantee: this module never imports @supabase/supabase-js and
// never makes a network request. Everything lives in sessionStorage for the
// current tab only, so demo edits can never reach a real account and
// disappear when the tab closes (or on "Reset demo").

const now = () => new Date().toISOString();
const uuid = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
};

// Column defaults mirroring supabase/schema.sql + every migration, so a
// demo row looks exactly like one Postgres would return.
export const TABLE_DEFAULTS = {
  profiles: () => ({ onboarding_completed_at: null, preferences: {} }),
  schedules: () => ({
    wake_time: '07:00:00', sleep_time: '22:30:00', breakfast_on: true, breakfast_time: '08:00:00', lunch_on: true, lunch_time: '12:30:00',
    dinner_on: true, dinner_time: '19:00:00', session_cap_minutes: 60, stamina_break_minutes: 15, switch_break_minutes: 10, min_block_minutes: 30,
    preferred_study_period: 'none', earliest_study_time: null, latest_study_time: null, max_daily_study_minutes: null,
  }),
  classes: () => ({ sort_order: 0, source: 'manual', course_id: null }),
  study_subjects: () => ({
    sort_order: 0, priority: 'medium', notes: '', due_date: null, tags: [], origin_subject_id: null, course_id: null, space_id: null, project_id: null, project_milestone_id: null, due_time: null, start_time: null, status_override: null, project_sort: 0, planned_by: null,
    actual_minutes: null, completed_at: null, dependency_override: false, exam_topic_id: null, recurrence_rule_id: null, recurrence_date: null,
  }),
  schedule_items: () => ({ sort_order: 0, locked: false, completed: false, completed_minutes: 0, missed: false, carried_over_minutes: 0, source_subject_id: null }),
  boards: () => ({ title: 'Untitled board', course_id: null, space_id: null }),
  board_nodes: () => ({ node_type: 'note', title: '', x_position: 0, y_position: 0, color: null, linked_study_subject_id: null, status: 'planned', due_date: null, estimated_minutes: null, course_id: null }),
  board_edges: () => ({ relationship: 'related' }),
  study_subject_subtasks: () => ({ title: '', completed: false, sort_order: 0 }),
  class_series: () => ({ days_of_week: [], course_id: null }),
  class_series_exceptions: () => ({ override_name: null, override_start_time: null, override_end_time: null }),
  semesters: () => ({ breaks: [], is_current: false }),
  spaces: () => ({ icon: 'circle', color: null, archived: false, sort_order: 0 }),
  projects: () => ({ space_id: null, description: '', status: 'active', priority: 'medium', start_date: null, due_date: null, estimated_minutes: null, progress_mode: 'auto', manual_progress: null, sort_order: 0, completed_at: null }),
  project_milestones: () => ({ description: '', due_date: null, status: 'open', completed_at: null, sort_order: 0 }),
  courses: () => ({ space_id: null, semester_id: null, code: null, instructor: null, color: null, location: null, notes: '', target_grade: null, credits: null, archived: false, sort_order: 0 }),
  grade_categories: () => ({ weight: 0, sort_order: 0 }),
  grade_items: () => ({ category_id: null, earned_points: null, due_date: null, counts: true, notes: '', sort_order: 0 }),
  exams: () => ({ course_id: null, start_time: null, duration_minutes: null, location: null, weight: null, notes: '' }),
  exam_topics: () => ({ difficulty: 2, confidence: 3, estimated_minutes: 60, completed_minutes: 0, status: 'not_started', sort_order: 0 }),
  task_dependencies: () => ({}),
  task_recurrence_rules: () => ({ course_id: null, priority: 'medium', tags: [], days_of_week: [], due_offset_days: 0, active: true }),
  resources: () => ({ course_id: null, task_id: null, kind: 'link', notes: '' }),
  focus_sessions: () => ({ schedule_item_id: null, task_id: null, course_id: null, ended_at: null, planned_minutes: 0, actual_minutes: 0, outcome: 'completed', notes: '' }),
};

// Foreign keys that cascade on delete, so deleting a parent in the demo
// behaves like Postgres (child -> [parentTable, fkColumn]).
const CASCADES = [
  ['classes', 'schedules', 'schedule_id'],
  ['study_subjects', 'schedules', 'schedule_id'],
  ['schedule_items', 'schedules', 'schedule_id'],
  ['study_subject_subtasks', 'study_subjects', 'subject_id'],
  ['class_series_exceptions', 'class_series', 'series_id'],
  ['board_nodes', 'boards', 'board_id'],
  ['board_edges', 'boards', 'board_id'],
  ['board_edges', 'board_nodes', 'source_node_id'],
  ['board_edges', 'board_nodes', 'target_node_id'],
  ['grade_categories', 'courses', 'course_id'],
  ['grade_items', 'courses', 'course_id'],
  ['exam_topics', 'exams', 'exam_id'],
  ['task_dependencies', 'study_subjects', 'task_id'],
  ['task_dependencies', 'study_subjects', 'depends_on_id'],
  ['resources', 'courses', 'course_id'],
  ['resources', 'study_subjects', 'task_id'],
  // V4-B: milestones belong to their project
  ['project_milestones', 'projects', 'project_id'],
];
const SET_NULLS = [
  ['schedule_items', 'study_subjects', 'source_subject_id'],
  ['study_subjects', 'study_subjects', 'origin_subject_id'],
  ['board_nodes', 'study_subjects', 'linked_study_subject_id'],
  ['study_subjects', 'courses', 'course_id'],
  ['classes', 'courses', 'course_id'],
  ['class_series', 'courses', 'course_id'],
  ['boards', 'courses', 'course_id'],
  ['board_nodes', 'courses', 'course_id'],
  ['exams', 'courses', 'course_id'],
  ['task_recurrence_rules', 'courses', 'course_id'],
  ['courses', 'semesters', 'semester_id'],
  ['grade_items', 'grade_categories', 'category_id'],
  ['study_subjects', 'exam_topics', 'exam_topic_id'],
  ['study_subjects', 'task_recurrence_rules', 'recurrence_rule_id'],
  ['focus_sessions', 'schedule_items', 'schedule_item_id'],
  ['focus_sessions', 'study_subjects', 'task_id'],
  ['focus_sessions', 'courses', 'course_id'],
  // V4 (0018)
  ['courses', 'spaces', 'space_id'],
  ['study_subjects', 'spaces', 'space_id'],
  ['boards', 'spaces', 'space_id'],
  // V4-B: deleting a project keeps its tasks
  ['projects', 'spaces', 'space_id'],
  ['study_subjects', 'projects', 'project_id'],
  ['study_subjects', 'project_milestones', 'project_milestone_id'],
];

function cmp(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  return a < b ? -1 : 1;
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/**
 * @param {object} options
 * @param {() => object} options.seed  builds the initial tables
 * @param {object} options.session     the fake auth session to report
 * @param {string} [options.storageKey]
 * @param {Set<string>} [options.missingTables] tables to report as absent (simulates un-migrated databases)
 * @param {Object<string, string[]>} [options.missingColumns] table -> columns to report as absent (selecting or writing them errors, like Postgres 42703)
 */
export function createMemoryClient({ seed, session, storageKey = 'student-scheduler-demo-db', missingTables = new Set(), missingColumns = {} }) {
  function load() {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) return JSON.parse(raw);
    } catch {
      // fall through to a fresh seed
    }
    return seed();
  }
  let db = load();
  let persistTimer = null;
  function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(db));
      } catch {
        // storage full/blocked — the demo still works for this page view
      }
    }, 50);
  }
  function table(name) {
    if (!db[name]) db[name] = [];
    return db[name];
  }

  function cascadeDelete(name, removedRows) {
    if (removedRows.length === 0) return;
    const ids = new Set(removedRows.map((r) => r.id));
    CASCADES.filter(([, parent]) => parent === name).forEach(([child, , fk]) => {
      const rows = table(child);
      const gone = rows.filter((r) => ids.has(r[fk]));
      if (gone.length === 0) return;
      db[child] = rows.filter((r) => !ids.has(r[fk]));
      cascadeDelete(child, gone);
    });
    SET_NULLS.filter(([, parent]) => parent === name).forEach(([child, , fk]) => {
      table(child).forEach((r) => {
        if (ids.has(r[fk])) r[fk] = null;
      });
    });
  }

  function checkUnique(name, row, rows) {
    if (name === 'schedules') return !rows.some((r) => r !== row && r.user_id === row.user_id && r.for_date === row.for_date);
    if (name === 'task_dependencies') return !rows.some((r) => r !== row && r.task_id === row.task_id && r.depends_on_id === row.depends_on_id);
    if (name === 'study_subjects' && row.recurrence_rule_id) {
      return !rows.some((r) => r !== row && r.recurrence_rule_id === row.recurrence_rule_id && r.recurrence_date === row.recurrence_date);
    }
    return true;
  }

  class Query {
    constructor(name) {
      this.name = name;
      this.op = 'select';
      this.filters = [];
      this.orders = [];
      this.limitN = null;
      this.mode = 'many';
      this.payload = null;
      this.head = false;
      this.returning = false;
      this.onConflict = null;
      this.embeds = [];
    }

    select(cols, opts = {}) {
      if (this.op === 'select') {
        this.cols = cols;
        this.head = Boolean(opts.head);
        // "*, schedules(for_date)" — a many-to-one embed through `<singular>_id`
        for (const m of String(cols || '').matchAll(/(\w+)\(([^)]*)\)/g)) {
          this.embeds.push({ rel: m[1], cols: m[2].split(',').map((c) => c.trim()).filter(Boolean) });
        }
      } else {
        this.returning = true;
      }
      return this;
    }
    insert(rows) { this.op = 'insert'; this.payload = rows; return this; }
    update(patch) { this.op = 'update'; this.payload = patch; return this; }
    upsert(row, opts = {}) { this.op = 'upsert'; this.payload = row; this.onConflict = opts.onConflict || 'id'; return this; }
    delete() { this.op = 'delete'; return this; }
    eq(col, v) { this.filters.push((r) => r[col] === v); return this; }
    neq(col, v) { this.filters.push((r) => r[col] !== v); return this; }
    in(col, arr) { const set = new Set(arr); this.filters.push((r) => set.has(r[col])); return this; }
    gte(col, v) { this.filters.push((r) => r[col] !== null && r[col] !== undefined && r[col] >= v); return this; }
    lte(col, v) { this.filters.push((r) => r[col] !== null && r[col] !== undefined && r[col] <= v); return this; }
    gt(col, v) { this.filters.push((r) => r[col] !== null && r[col] !== undefined && r[col] > v); return this; }
    lt(col, v) { this.filters.push((r) => r[col] !== null && r[col] !== undefined && r[col] < v); return this; }
    is(col, v) { this.filters.push((r) => (v === null ? r[col] === null || r[col] === undefined : r[col] === v)); return this; }
    not(col, op, v) {
      if (op === 'is' && v === null) this.filters.push((r) => r[col] !== null && r[col] !== undefined);
      else throw new Error(`demo client: unsupported not(${op})`);
      return this;
    }
    or(expr) {
      const parts = expr.split(',').map((p) => {
        const [col, op, ...rest] = p.split('.');
        if (op !== 'eq') throw new Error(`demo client: unsupported or op ${op}`);
        return [col, rest.join('.')];
      });
      this.filters.push((r) => parts.some(([c, v]) => String(r[c]) === v));
      return this;
    }
    order(col, opts = {}) { this.orders.push([col, opts.ascending !== false]); return this; }
    limit(n) { this.limitN = n; return this; }
    range(from, to) { this.offsetN = from; this.limitN = to - from + 1; return this; }
    single() { this.mode = 'single'; return this; }
    maybeSingle() { this.mode = 'maybe'; return this; }

    matches(r) { return this.filters.every((f) => f(r)); }

    withEmbeds(row) {
      if (this.embeds.length === 0) return row;
      const out = { ...row };
      this.embeds.forEach(({ rel, cols }) => {
        const fk = `${rel.replace(/s$/, '')}_id`;
        const parent = table(rel).find((p) => p.id === row[fk]);
        out[rel] = parent ? Object.fromEntries(cols.map((c) => [c, parent[c]])) : null;
      });
      return out;
    }

    run() {
      const absentCols = missingColumns[this.name];
      if (absentCols && absentCols.length) {
        const asked = this.op === 'select'
          ? String(this.cols || '').split(',').map((c) => c.trim()).filter((c) => c && c !== '*' && !c.includes('('))
          : (Array.isArray(this.payload) ? this.payload : [this.payload]).flatMap((p) => Object.keys(p || {}));
        const bad = asked.find((c) => absentCols.includes(c));
        if (bad) return { data: null, error: { message: `column ${this.name}.${bad} does not exist`, code: '42703' } };
      }
      if (missingTables.has(this.name)) {
        return { data: null, error: { message: `relation "public.${this.name}" does not exist`, code: '42P01' } };
      }
      const rows = table(this.name);
      const defaults = TABLE_DEFAULTS[this.name] ? TABLE_DEFAULTS[this.name]() : {};
      let result;
      if (this.op === 'select') {
        result = rows.filter((r) => this.matches(r));
        this.orders.slice().reverse().forEach(([col, asc]) => {
          result = result.slice().sort((a, b) => (asc ? cmp(a[col], b[col]) : cmp(b[col], a[col])));
        });
        if (this.limitN !== null) result = result.slice(this.offsetN || 0, (this.offsetN || 0) + this.limitN);
        if (this.head) return { data: null, error: null, count: result.length };
        result = result.map((r) => this.withEmbeds(r));
      } else if (this.op === 'insert') {
        const list = Array.isArray(this.payload) ? this.payload : [this.payload];
        const created = list.map((p) => ({ id: uuid(), created_at: now(), updated_at: now(), ...defaults, ...clone(p) }));
        for (const row of created) {
          if (!checkUnique(this.name, row, [...rows, ...created])) {
            return { data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' } };
          }
        }
        rows.push(...created);
        result = created;
        persist();
      } else if (this.op === 'update') {
        result = rows.filter((r) => this.matches(r));
        result.forEach((r) => Object.assign(r, clone(this.payload)));
        persist();
      } else if (this.op === 'upsert') {
        const keys = this.onConflict.split(',');
        const existing = rows.find((r) => keys.every((k) => r[k] === this.payload[k]));
        if (existing) {
          Object.assign(existing, clone(this.payload));
          result = [existing];
        } else {
          const row = { id: uuid(), created_at: now(), updated_at: now(), ...defaults, ...clone(this.payload) };
          rows.push(row);
          result = [row];
        }
        persist();
      } else if (this.op === 'delete') {
        result = rows.filter((r) => this.matches(r));
        db[this.name] = rows.filter((r) => !this.matches(r));
        cascadeDelete(this.name, result);
        persist();
      }
      result = clone(result);
      if (this.mode === 'single') {
        if (result.length !== 1) return { data: null, error: { message: `Expected 1 row from ${this.name}, got ${result.length}`, code: 'PGRST116' } };
        return { data: result[0], error: null };
      }
      if (this.mode === 'maybe') return { data: result[0] || null, error: null };
      return { data: this.op === 'select' || this.returning ? result : null, error: null };
    }

    then(resolve, reject) {
      // A tiny async gap so UI code sees realistic loading states.
      return new Promise((r) => setTimeout(r, 4)).then(() => this.run()).then(resolve, reject);
    }
  }

  const authListeners = new Set();
  return {
    from: (name) => new Query(name),
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      getUser: async () => ({ data: { user: session.user }, error: null }),
      onAuthStateChange: (cb) => {
        authListeners.add(cb);
        return { data: { subscription: { unsubscribe: () => authListeners.delete(cb) } } };
      },
      signOut: async () => ({ error: null }),
      signInWithPassword: async () => ({ data: { session }, error: null }),
      signUp: async () => ({ data: {}, error: null }),
      resetPasswordForEmail: async () => ({ error: null }),
      updateUser: async () => ({ error: null }),
    },
    functions: { invoke: async () => ({ data: null, error: { message: 'Not available in demo mode' } }) },
    // Demo-only helpers (never present on the real client).
    __demo: {
      reset: () => {
        try { sessionStorage.removeItem(storageKey); } catch { /* ignore */ }
        db = seed();
      },
      snapshot: () => clone(db),
    },
  };
}
