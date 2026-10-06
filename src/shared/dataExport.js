// Pure helpers for Settings → Data → "Export my data" (V2-F). No DOM, no
// Supabase: data.js fetches the rows, this file shapes them into one
// self-describing JSON document. Export only — there is deliberately no
// import counterpart yet (a bulk-write surface needs its own validation
// design and a separate sign-off).

export const EXPORT_FORMAT = 'student-scheduler-export';
export const EXPORT_FORMAT_VERSION = 1;

// Every user-owned table, in a stable, human-readable order (parents
// before children).
export const EXPORT_TABLES = [
  'profiles',
  'schedules',
  'classes',
  'class_series',
  'class_series_exceptions',
  'study_subjects',
  'study_subject_subtasks',
  'schedule_items',
  'boards',
  'board_nodes',
  'board_edges',
];

// @param {object} args
// @param {Object<string, object[]>} args.tables — rows per table name
// @param {Object<string, string>} [args.errors] — table -> error message for
//   tables that couldn't be read (e.g. a migration not applied yet); these
//   are listed in the file rather than failing the whole export
// @param {string} args.exportedAt — ISO timestamp (passed in, not read
//   from the clock, so this stays deterministic and testable)
export function buildExportPayload({ tables = {}, errors = {}, exportedAt }) {
  const outTables = {};
  const counts = {};
  EXPORT_TABLES.forEach((name) => {
    if (errors[name]) return;
    const rows = Array.isArray(tables[name]) ? tables[name] : [];
    outTables[name] = rows;
    counts[name] = rows.length;
  });
  const skipped = EXPORT_TABLES.filter((name) => errors[name]).map((name) => ({ table: name, reason: String(errors[name]) }));
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_FORMAT_VERSION,
    exportedAt,
    counts,
    skipped,
    tables: outTables,
  };
}

// "student-scheduler-export-2026-10-06.json"
export function buildExportFilename(dateStr) {
  const safe = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr)) ? dateStr : 'data';
  return `student-scheduler-export-${safe}.json`;
}

export function totalExportedRows(payload) {
  return Object.values(payload?.counts || {}).reduce((sum, n) => sum + n, 0);
}
