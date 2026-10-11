// File exports (V4-I), pure. Readable files for spreadsheets and other
// apps, next to the full JSON backup:
//   tasks.csv · notes.md · routine-log.csv · attendance.csv · goal-check-ins.csv
// CSV cells are quoted when needed, and a cell that starts with = + - @ (or
// a tab / carriage return) is prefixed with ' so a spreadsheet can never run
// it as a formula (CSV injection).

const FORMULA = /^[=+\-@\t\r]/;

export function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = Array.isArray(value) ? value.join('; ') : String(value);
  if (FORMULA.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** rows: array of arrays; header first. CRLF line endings + BOM for Excel. */
export function toCsv(rows) {
  return `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function tasksCsv(groups = [], { courseName = () => '', projectName = () => '', goalName = () => '' } = {}) {
  const header = ['Task', 'Status', 'Due date', 'Scheduled date', 'Priority', 'Minutes needed', 'Minutes left', 'Course', 'Project', 'Goal', 'Tags', 'Notes', 'Completed at'];
  const rows = groups.map((g) => [
    g.name, g.done ? 'done' : g.status, g.dueDate || '', g.scheduledDate || '', g.priority, g.requestedMinutes, g.remainingMinutes,
    courseName(g.courseId), projectName(g.projectId), goalName(g.goalId), g.tags || [], g.notes || '', g.completedAt || '',
  ]);
  return toCsv([header, ...rows]);
}

export function routineLogCsv(routines = [], completions = []) {
  const byId = new Map(routines.map((r) => [r.id, r]));
  const rows = completions
    .filter((c) => byId.has(c.routine_id))
    .sort((a, b) => String(a.completed_on).localeCompare(String(b.completed_on)))
    .map((c) => [c.completed_on, byId.get(c.routine_id).title, c.status, c.note || '']);
  return toCsv([['Date', 'Routine', 'Status', 'Note'], ...rows]);
}

export function attendanceCsv(records = [], courseName = () => '') {
  const rows = records
    .slice()
    .sort((a, b) => String(a.attended_on).localeCompare(String(b.attended_on)) || a.start_minutes - b.start_minutes)
    .map((r) => [r.attended_on, `${String(Math.floor(r.start_minutes / 60)).padStart(2, '0')}:${String(r.start_minutes % 60).padStart(2, '0')}`, courseName(r.course_id), r.status, r.note || '']);
  return toCsv([['Date', 'Start', 'Course', 'Status', 'Note'], ...rows]);
}

export function goalCheckInsCsv(goals = [], logs = []) {
  const byId = new Map(goals.map((g) => [g.id, g]));
  const rows = logs
    .filter((l) => byId.has(l.goal_id))
    .sort((a, b) => String(a.logged_on).localeCompare(String(b.logged_on)))
    .map((l) => [l.logged_on, byId.get(l.goal_id).title, l.value, byId.get(l.goal_id).unit || '', l.note || '']);
  return toCsv([['Date', 'Goal', 'Value', 'Unit', 'Note'], ...rows]);
}

/** All notes in one Markdown file, newest first, each under its own heading. */
export function notesMarkdown(notes = [], { untitled = 'Untitled', exportedAt = '' } = {}) {
  const parts = [`# Notes${exportedAt ? ` — exported ${exportedAt.slice(0, 10)}` : ''}`, ''];
  notes
    .slice()
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    .forEach((n) => {
      const title = (n.title || '').trim() || untitled;
      parts.push(`## ${title.replace(/\n/g, ' ')}`, '');
      const meta = [n.updated_at ? `Edited ${String(n.updated_at).slice(0, 10)}` : '', (n.tags || []).length ? `Tags: ${n.tags.join(', ')}` : '', n.archived ? 'Archived' : ''].filter(Boolean).join(' · ');
      if (meta) parts.push(`_${meta}_`, '');
      // Demote the note's own headings so they sit under its title.
      parts.push(String(n.body || '').replace(/^(#{1,4})\s/gm, (m, hashes) => `${hashes}## `), '');
      parts.push('---', '');
    });
  return parts.join('\n');
}

export function exportFilename(kind, dateStr) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr)) ? dateStr : 'export';
  const ext = kind === 'notes' ? 'md' : 'csv';
  return `student-scheduler-${kind}-${d}.${ext}`;
}
