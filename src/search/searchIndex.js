// Universal search index for the Ctrl/Cmd+K palette (V3-Q). The palette
// asks for commands synchronously, so this keeps a small in-memory index
// of the student's courses, tasks, exams, recurring classes and boards,
// refreshed in the background (on startup, after changes, and each time
// the palette opens). Reads only; nothing here writes.

import { app, onChange } from '../app/context.js';
import { has } from '../shared/capabilities.js';
import { todayStr, addDays } from '../shared/dates.js';
import { listCourses, listTaskRowsInWindow, listAllClassSeries } from '../academics/academicsData.js';
import { listExams } from '../exams/examsData.js';
import { listBoards } from '../board/boardData.js';
import { listProjects, listProjectTaskRows } from '../projects/projectsData.js';
import { listGoals } from '../goals/goalsData.js';
import { listRoutines } from '../routines/routinesData.js';
import { listNotes } from '../notes/notesData.js';

let index = { courses: [], tasks: [], exams: [], series: [], boards: [], projects: [], goals: [], routines: [], notes: [] };
let pending = null;
let stale = true;

export async function refreshSearchIndex() {
  if (pending) return pending;
  const ctx = app();
  if (!ctx.userId) return index;
  pending = (async () => {
    const today = todayStr();
    const [courses, windowRows, exams, series, boards, projects, projectRows, goals, routines, notes] = await Promise.all([
      has('courses') ? listCourses(ctx.userId).catch(() => []) : [],
      listTaskRowsInWindow(ctx.userId, addDays(today, -30), addDays(today, 90)).catch(() => []),
      has('exams') ? listExams(ctx.userId).catch(() => []) : [],
      listAllClassSeries(ctx.userId).catch(() => []),
      listBoards(ctx.userId).catch(() => []),
      listProjects(ctx.userId).catch(() => []),
      listProjectTaskRows(ctx.userId).catch(() => []),
      listGoals(ctx.userId).catch(() => []),
      listRoutines(ctx.userId).catch(() => []),
      listNotes(ctx.userId).catch(() => []),
    ]);
    const byId = new Map(windowRows.map((r) => [r.id, r]));
    projectRows.forEach((r) => { if (!byId.has(r.id)) byId.set(r.id, r); });
    const rows = [...byId.values()];
    // One entry per task (roots only — chunks of a multi-day task share it).
    const roots = rows.filter((r) => !r.origin_subject_id || !rows.some((x) => x.id === r.origin_subject_id));
    index = { courses, tasks: roots, exams, series, boards, projects, goals, routines, notes };
    stale = false;
    pending = null;
    return index;
  })().catch((err) => {
    pending = null;
    console.error('Search index refresh failed', err);
    return index;
  });
  return pending;
}

export function searchIndex() {
  if (stale) refreshSearchIndex();
  return index;
}

onChange(() => { stale = true; });
