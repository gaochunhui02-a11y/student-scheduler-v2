// Backup & restore (V3-O), pure. Restore never overwrites anything:
//   1. parse        — valid JSON, the right format marker, a known version
//   2. validate     — every row of every known table checked against a
//                     per-table schema (types, lengths, dates, enums);
//                     unknown tables and unknown columns are ignored
//   3. plan         — a COPY of the data with brand-new ids, all foreign
//                     keys rewritten consistently, user_id set to the
//                     signed-in user; conflicts resolved conservatively:
//                       * a day that already has a plan in this account is
//                         skipped with everything on it (never mixed in)
//                       * a course with the same name + code is linked to
//                         the existing course instead of duplicated
//                       * a semester with the same name + start date is reused
//                       * a record whose id is still in this account (a
//                         backup of this same account) is kept, not copied
//   4. preview      — counts, conflicts and skipped rows shown to the student
//   5. confirm      — only then does backupData.js write (and roll back if
//                     anything fails part-way)

export const BACKUP_FORMAT = 'student-scheduler-export';
export const BACKUP_VERSION = 3;
export const SUPPORTED_VERSIONS = [1, 3];
export const MAX_ROWS = 50000;
export const MAX_BYTES = 25 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}(:\d{2})?$/;

// Column specs: [type, required?, extra]. Types: id, ref (uuid or null),
// text (max len), date, time, ts, int (min,max), num (min,max), bool,
// enum (values), json-array, json-object.
const S = {
  semesters: {
    id: ['id', true], name: ['text', true, 120], start_date: ['date', true], end_date: ['date', true], breaks: ['breaks'], is_current: ['bool'],
  },
  courses: {
    id: ['id', true], semester_id: ['ref'], name: ['text', true, 120], code: ['text', false, 32], instructor: ['text', false, 120], color: ['color'],
    location: ['text', false, 120], notes: ['text', false, 5000], target_grade: ['num', false, [0, 100]], credits: ['num', false, [0, 50]], archived: ['bool'], sort_order: ['int', false, [-1e6, 1e6]],
  },
  schedules: {
    id: ['id', true], for_date: ['date', true], wake_time: ['time'], sleep_time: ['time'], breakfast_on: ['bool'], breakfast_time: ['time'], lunch_on: ['bool'], lunch_time: ['time'],
    dinner_on: ['bool'], dinner_time: ['time'], session_cap_minutes: ['int', false, [1, 1440]], stamina_break_minutes: ['int', false, [0, 1440]], switch_break_minutes: ['int', false, [0, 1440]],
    min_block_minutes: ['int', false, [1, 1440]], preferred_study_period: ['enum', false, ['none', 'morning', 'afternoon', 'evening']], earliest_study_time: ['time'], latest_study_time: ['time'],
    max_daily_study_minutes: ['int', false, [1, 1440]],
  },
  classes: {
    id: ['id', true], schedule_id: ['ref', true], name: ['text', true, 200], start_time: ['time', true], end_time: ['time', true], sort_order: ['int', false, [-1e6, 1e6]],
    source: ['enum', false, ['manual', 'imported', 'recurring']], course_id: ['ref'],
  },
  class_series: {
    id: ['id', true], name: ['text', true, 100], days_of_week: ['days'], start_time: ['time', true], end_time: ['time', true], start_date: ['date', true], end_date: ['date', true], course_id: ['ref'],
  },
  class_series_exceptions: {
    id: ['id', true], series_id: ['ref', true], exception_date: ['date', true], action: ['enum', true, ['skip', 'modify']], override_name: ['text', false, 100], override_start_time: ['time'], override_end_time: ['time'],
  },
  task_recurrence_rules: {
    id: ['id', true], course_id: ['ref'], name: ['text', true, 200], minutes: ['int', true, [5, 1440]], priority: ['enum', false, ['low', 'medium', 'high']], tags: ['tags'], days_of_week: ['days'],
    start_date: ['date', true], end_date: ['date', true], due_offset_days: ['int', false, [0, 30]], active: ['bool'],
  },
  exams: {
    id: ['id', true], course_id: ['ref'], name: ['text', true, 120], exam_date: ['date', true], start_time: ['time'], duration_minutes: ['int', false, [1, 720]], location: ['text', false, 120],
    weight: ['num', false, [0, 100]], notes: ['text', false, 5000],
  },
  exam_topics: {
    id: ['id', true], exam_id: ['ref', true], name: ['text', true, 120], difficulty: ['int', false, [1, 3]], confidence: ['int', false, [1, 5]], estimated_minutes: ['int', false, [1, 6000]],
    completed_minutes: ['int', false, [0, 20000]], status: ['enum', false, ['not_started', 'in_progress', 'done']], sort_order: ['int', false, [-1e6, 1e6]],
  },
  study_subjects: {
    id: ['id', true], schedule_id: ['ref', true], name: ['text', true, 200], minutes_requested: ['int', true, [1, 1440]], sort_order: ['int', false, [-1e6, 1e6]], priority: ['enum', false, ['low', 'medium', 'high']],
    due_date: ['date'], notes: ['text', false, 5000], tags: ['tags'], origin_subject_id: ['ref'], course_id: ['ref'], completed_at: ['ts'], actual_minutes: ['int', false, [0, 10000]],
    dependency_override: ['bool'], exam_topic_id: ['ref'], recurrence_rule_id: ['ref'], recurrence_date: ['date'],
  },
  study_subject_subtasks: { id: ['id', true], subject_id: ['ref', true], title: ['text', false, 200], completed: ['bool'], sort_order: ['int', false, [-1e6, 1e6]] },
  task_dependencies: { id: ['id', true], task_id: ['ref', true], depends_on_id: ['ref', true] },
  schedule_items: {
    id: ['id', true], schedule_id: ['ref', true], item_type: ['enum', true, ['class', 'meal', 'study', 'break', 'free']], name: ['text', true, 200], start_minutes: ['int', true, [-1440, 2880]],
    end_minutes: ['int', true, [-1440, 2880]], sort_order: ['int', false, [-1e6, 1e6]], locked: ['bool'], completed: ['bool'], source_subject_id: ['ref'], completed_minutes: ['int', false, [0, 2880]],
    missed: ['bool'], carried_over_minutes: ['int', false, [0, 2880]],
  },
  boards: { id: ['id', true], title: ['text', false, 200], course_id: ['ref'] },
  board_nodes: {
    id: ['id', true], board_id: ['ref', true], node_type: ['enum', false, ['goal', 'subject', 'task', 'note', 'milestone']], title: ['text', false, 2000], x_position: ['num', false, [-1e7, 1e7]],
    y_position: ['num', false, [-1e7, 1e7]], color: ['text', false, 40], linked_study_subject_id: ['ref'], status: ['enum', false, ['planned', 'in_progress', 'done']], due_date: ['date'],
    estimated_minutes: ['int', false, [1, 1e6]], course_id: ['ref'],
  },
  board_edges: { id: ['id', true], board_id: ['ref', true], source_node_id: ['ref', true], target_node_id: ['ref', true], relationship: ['enum', false, ['parent', 'related']] },
  grade_categories: { id: ['id', true], course_id: ['ref', true], name: ['text', true, 80], weight: ['num', false, [0, 100]], sort_order: ['int', false, [-1e6, 1e6]] },
  grade_items: {
    id: ['id', true], course_id: ['ref', true], category_id: ['ref'], name: ['text', true, 120], earned_points: ['num', false, [0, 200000]], possible_points: ['num', true, [0.0001, 100000]],
    due_date: ['date'], counts: ['bool'], notes: ['text', false, 2000], sort_order: ['int', false, [-1e6, 1e6]],
  },
  resources: {
    id: ['id', true], course_id: ['ref'], task_id: ['ref'], title: ['text', true, 200], url: ['url', true], kind: ['enum', false, ['link', 'document', 'lecture', 'syllabus', 'reference']], notes: ['text', false, 2000],
  },
  focus_sessions: {
    id: ['id', true], schedule_item_id: ['ref'], task_id: ['ref'], course_id: ['ref'], started_at: ['ts', true], ended_at: ['ts'], planned_minutes: ['int', false, [0, 1440]],
    actual_minutes: ['int', false, [0, 1440]], outcome: ['enum', false, ['completed', 'finished_early', 'stopped']], notes: ['text', false, 2000],
  },
};

// Insert order (parents before children).
export const BACKUP_TABLES = Object.keys(S);

// Foreign keys to rewrite: table -> { column: parentTable }
export const REFS = {
  courses: { semester_id: 'semesters' },
  classes: { schedule_id: 'schedules', course_id: 'courses' },
  class_series: { course_id: 'courses' },
  class_series_exceptions: { series_id: 'class_series' },
  task_recurrence_rules: { course_id: 'courses' },
  exams: { course_id: 'courses' },
  exam_topics: { exam_id: 'exams' },
  study_subjects: { schedule_id: 'schedules', origin_subject_id: 'study_subjects', course_id: 'courses', exam_topic_id: 'exam_topics', recurrence_rule_id: 'task_recurrence_rules' },
  study_subject_subtasks: { subject_id: 'study_subjects' },
  task_dependencies: { task_id: 'study_subjects', depends_on_id: 'study_subjects' },
  schedule_items: { schedule_id: 'schedules', source_subject_id: 'study_subjects' },
  boards: { course_id: 'courses' },
  board_nodes: { board_id: 'boards', linked_study_subject_id: 'study_subjects', course_id: 'courses' },
  board_edges: { board_id: 'boards', source_node_id: 'board_nodes', target_node_id: 'board_nodes' },
  grade_categories: { course_id: 'courses' },
  grade_items: { course_id: 'courses', category_id: 'grade_categories' },
  resources: { course_id: 'courses', task_id: 'study_subjects' },
  focus_sessions: { schedule_item_id: 'schedule_items', task_id: 'study_subjects', course_id: 'courses' },
};

// A row is dropped (with its dependants) when a REQUIRED parent is missing;
// an optional reference to a missing parent just becomes null.
function requiredRefs(table) {
  return Object.keys(REFS[table] || {}).filter((col) => S[table][col] && S[table][col][1]);
}

export function buildBackup({ tables = {}, errors = {}, exportedAt }) {
  const out = {};
  const counts = {};
  BACKUP_TABLES.forEach((name) => {
    if (errors[name]) return;
    out[name] = Array.isArray(tables[name]) ? tables[name] : [];
    counts[name] = out[name].length;
  });
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt,
    counts,
    skipped: BACKUP_TABLES.filter((n) => errors[n]).map((n) => ({ table: n, reason: String(errors[n]) })),
    tables: out,
  };
}

export function backupFilename(dateStr) {
  return `student-scheduler-backup-${/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr)) ? dateStr : 'data'}.json`;
}

// ---------------- 1. parse ----------------
export function parseBackup(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'backup.errEmpty' };
  if (text.length > MAX_BYTES) return { ok: false, error: 'backup.errTooLarge' };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'backup.errNotJson' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'backup.errFormat' };
  if (data.format !== BACKUP_FORMAT) return { ok: false, error: 'backup.errFormat' };
  if (!SUPPORTED_VERSIONS.includes(data.version)) return { ok: false, error: 'backup.errVersion', params: { version: String(data.version) } };
  if (!data.tables || typeof data.tables !== 'object' || Array.isArray(data.tables)) return { ok: false, error: 'backup.errFormat' };
  const total = Object.values(data.tables).reduce((s, rows) => s + (Array.isArray(rows) ? rows.length : 0), 0);
  if (total > MAX_ROWS) return { ok: false, error: 'backup.errTooLarge' };
  return { ok: true, data };
}

// ---------------- 2. validate ----------------
function checkValue(type, value, extra) {
  if (value === null || value === undefined) return true; // required-ness checked separately
  switch (type) {
    case 'id':
    case 'ref': return typeof value === 'string' && UUID.test(value);
    case 'text': return typeof value === 'string' && value.length <= (extra || 10000);
    case 'date': return typeof value === 'string' && DATE.test(value);
    case 'time': return typeof value === 'string' && TIME.test(value);
    case 'ts': return typeof value === 'string' && !Number.isNaN(Date.parse(value));
    case 'int': return Number.isInteger(value) && (!extra || (value >= extra[0] && value <= extra[1]));
    case 'num': {
      const n = typeof value === 'string' ? Number(value) : value;
      return typeof n === 'number' && Number.isFinite(n) && (!extra || (n >= extra[0] && n <= extra[1]));
    }
    case 'bool': return typeof value === 'boolean';
    case 'enum': return extra.includes(value);
    case 'array': return Array.isArray(value) && value.length <= 200;
    // jsonb arrays get their real shapes, not just "an array":
    case 'tags': return Array.isArray(value) && value.length <= 50 && value.every((x) => typeof x === 'string' && x.length <= 60);
    case 'days': return Array.isArray(value) && value.length <= 7 && value.every((x) => Number.isInteger(x) && x >= 0 && x <= 6);
    case 'breaks': return Array.isArray(value) && value.length <= 50 && value.every((b) => b && typeof b === 'object' && !Array.isArray(b)
      && DATE.test(b.start_date || '') && DATE.test(b.end_date || '') && (b.name === undefined || (typeof b.name === 'string' && b.name.length <= 80)));
    case 'color': return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
    case 'url': return typeof value === 'string' && value.length <= 2048 && /^https?:\/\/\S+$/i.test(value);
    default: return false;
  }
}

/**
 * @returns {{ ok:boolean, errors:Array<{table,index,column,problem}>, tables:Object, counts:Object, ignoredTables:string[] }}
 * `tables` holds only known tables with only known columns.
 */
export function validateBackup(data) {
  const errors = [];
  const tables = {};
  const counts = {};
  const ignoredTables = Object.keys(data.tables).filter((n) => !S[n]);
  BACKUP_TABLES.forEach((name) => {
    const rows = data.tables[name];
    if (rows === undefined) return;
    if (!Array.isArray(rows)) {
      errors.push({ table: name, index: -1, column: '', problem: 'not_a_list' });
      return;
    }
    const spec = S[name];
    const seen = new Set();
    tables[name] = rows.map((row, index) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        errors.push({ table: name, index, column: '', problem: 'not_an_object' });
        return null;
      }
      const clean = {};
      Object.entries(spec).forEach(([col, [type, required, extra]]) => {
        const value = row[col];
        if ((value === null || value === undefined || value === '') && required) {
          errors.push({ table: name, index, column: col, problem: 'missing' });
          return;
        }
        if (!checkValue(type, value, extra)) {
          errors.push({ table: name, index, column: col, problem: 'invalid' });
          return;
        }
        if (value !== undefined) clean[col] = type === 'num' && typeof value === 'string' ? Number(value) : value;
      });
      if (clean.id) {
        if (seen.has(clean.id)) errors.push({ table: name, index, column: 'id', problem: 'duplicate' });
        seen.add(clean.id);
      }
      return clean;
    }).filter(Boolean);
    counts[name] = tables[name].length;
  });
  // Cross-row sanity: end after start.
  (tables.semesters || []).forEach((r, i) => { if (r.end_date < r.start_date) errors.push({ table: 'semesters', index: i, column: 'end_date', problem: 'invalid' }); });
  (tables.schedule_items || []).forEach((r, i) => { if (r.end_minutes < r.start_minutes) errors.push({ table: 'schedule_items', index: i, column: 'end_minutes', problem: 'invalid' }); });
  return { ok: errors.length === 0, errors, tables, counts, ignoredTables };
}

// V3 columns added to V2 tables, by capability (see shared/capabilities.js).
// When a capability is missing those columns are left out of the insert.
export const CAPABILITY_COLUMNS = {
  courseLinks: { study_subjects: ['course_id'] },
  classCourseLinks: { classes: ['course_id'], class_series: ['course_id'] },
  boardCourseLinks: { boards: ['course_id'], board_nodes: ['course_id'] },
  taskExtensions: { study_subjects: ['completed_at', 'actual_minutes', 'dependency_override', 'exam_topic_id', 'recurrence_rule_id', 'recurrence_date'] },
};
// Which table each capability-gated table needs.
export const TABLE_CAPABILITY = {
  semesters: 'semesters', courses: 'courses', grade_categories: 'grades', grade_items: 'grades', exams: 'exams', exam_topics: 'exams',
  task_recurrence_rules: 'recurringTasks', task_dependencies: 'dependencies', resources: 'resources', focus_sessions: 'focusSessions',
};

export function restoreAvailability(caps) {
  const availableTables = BACKUP_TABLES.filter((tbl) => !TABLE_CAPABILITY[tbl] || caps[TABLE_CAPABILITY[tbl]]);
  const unavailableColumns = {};
  Object.entries(CAPABILITY_COLUMNS).forEach(([cap, byTable]) => {
    if (caps[cap]) return;
    Object.entries(byTable).forEach(([tbl, cols]) => { unavailableColumns[tbl] = [...(unavailableColumns[tbl] || []), ...cols]; });
  });
  return { availableTables, unavailableColumns };
}

// ---------------- 3. plan ----------------
/**
 * @param {object} p
 * @param {Object} p.tables           validated tables (from validateBackup)
 * @param {Object} p.existing         { scheduleDates:Set, courses:[{id,name,code}], semesters:[{id,name,start_date}], ids?:{table:Set} }
 * @param {string[]} p.availableTables tables the connected database has
 * @param {Object<string,string[]>} [p.unavailableColumns] V3 columns on V2 tables the database lacks
 * @param {() => string} p.newId
 * @param {string} p.userId
 * @returns {{ inserts:Object<string,Array>, counts:Object, conflicts:{days:number, courses:number, semesters:number}, skipped:Object<string,number>, unavailable:string[] }}
 */
export function planRestore({ tables, existing, availableTables, unavailableColumns = {}, newId, userId }) {
  const available = new Set(availableTables);
  const idMap = Object.fromEntries(BACKUP_TABLES.map((t) => [t, new Map()]));
  const inserts = {};
  const skipped = {};
  const unavailable = [];
  const conflicts = { days: 0, courses: 0, semesters: 0, existing: 0 };
  const existingIds = existing.ids || {};
  const existingCourse = new Map((existing.courses || []).map((c) => [`${String(c.name).trim().toLowerCase()}|${String(c.code || '').trim().toLowerCase()}`, c.id]));
  const existingSemester = new Map((existing.semesters || []).map((s) => [`${String(s.name).trim().toLowerCase()}|${s.start_date}`, s.id]));
  const reused = new Set(); // "table:newId" rows that map to existing records (not inserted)

  BACKUP_TABLES.forEach((table) => {
    const rows = tables[table] || [];
    if (!rows.length) return;
    if (!available.has(table)) {
      unavailable.push(table);
      skipped[table] = rows.length;
      return;
    }
    const out = [];
    const refs = REFS[table] || {};
    const required = requiredRefs(table);
    // Self-references (study_subjects.origin_subject_id) need roots first.
    const ordered = table === 'study_subjects' ? rows.slice().sort((a, b) => Number(Boolean(a.origin_subject_id)) - Number(Boolean(b.origin_subject_id))) : rows;
    ordered.forEach((row) => {
      if (table === 'schedules' && existing.scheduleDates && existing.scheduleDates.has(row.for_date)) {
        conflicts.days += 1; // reported as a conflict, not also as "skipped"
        return;
      }
      // The very same record is still in this account (restoring a backup
      // of this account): keep it, don't duplicate it.
      if (existingIds[table] && existingIds[table].has(row.id)) {
        idMap[table].set(row.id, row.id);
        conflicts.existing += 1;
        return;
      }
      if (table === 'courses') {
        const key = `${String(row.name).trim().toLowerCase()}|${String(row.code || '').trim().toLowerCase()}`;
        if (existingCourse.has(key)) {
          idMap.courses.set(row.id, existingCourse.get(key));
          conflicts.courses += 1;
          reused.add(`courses:${existingCourse.get(key)}`);
          return;
        }
      }
      if (table === 'semesters') {
        const key = `${String(row.name).trim().toLowerCase()}|${row.start_date}`;
        if (existingSemester.has(key)) {
          idMap.semesters.set(row.id, existingSemester.get(key));
          conflicts.semesters += 1;
          return;
        }
      }
      const next = { ...row, id: newId(), user_id: userId };
      let drop = false;
      Object.entries(refs).forEach(([col, parent]) => {
        if (row[col] === null || row[col] === undefined) return;
        const mapped = idMap[parent].get(row[col]);
        if (mapped) next[col] = mapped;
        else if (required.includes(col)) drop = true;
        else next[col] = null;
      });
      // Restored courses/semesters are never "current" — the account's own
      // current semester stays as it is.
      if (table === 'semesters') next.is_current = false;
      if (table === 'task_dependencies' && next.task_id === next.depends_on_id) drop = true;
      if (drop) {
        skipped[table] = (skipped[table] || 0) + 1;
        return;
      }
      idMap[table].set(row.id, next.id);
      // Omit nulls so each column's database default applies (several V2/V3
      // columns are NOT NULL with a default, e.g. notes = '').
      Object.keys(next).forEach((k) => { if (next[k] === null || next[k] === undefined) delete next[k]; });
      (unavailableColumns[table] || []).forEach((k) => { delete next[k]; });
      out.push(next);
    });
    if (out.length) inserts[table] = out;
  });
  const counts = Object.fromEntries(Object.entries(inserts).map(([t, r]) => [t, r.length]));
  return { inserts, counts, conflicts, skipped, unavailable, reusedCount: reused.size };
}
