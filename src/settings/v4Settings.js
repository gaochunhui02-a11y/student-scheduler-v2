// Settings additions (V4-I):
//   Data › "Export as files" — tasks.csv, notes.md, routine log, attendance,
//                              goal check-ins (next to the JSON backup)
//   Privacy                  — what is stored where, the on-device offline
//                              copy switch, clearing this device's app data
//   Notifications            — routine and weekly-review reminders (opt-in)

import { t } from '../shared/i18n.js';
import { h } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { confirmAction } from '../ui/drawer.js';
import { app } from '../app/context.js';
import { has } from '../shared/capabilities.js';
import { todayStr, addDays, minutesOfDay } from '../shared/dates.js';
import { listCourses, listTaskRowsInWindow, listBlocksForSubjectIds } from '../academics/academicsData.js';
import { buildTaskGroups } from '../tasks/taskModel.js';
import { listProjects } from '../projects/projectsData.js';
import { listGoals, listGoalLogs } from '../goals/goalsData.js';
import { listRoutines, listCompletions } from '../routines/routinesData.js';
import { listNotes } from '../notes/notesData.js';
import { listAttendance } from '../attendance/attendanceData.js';
import { tasksCsv, notesMarkdown, routineLogCsv, attendanceCsv, goalCheckInsCsv, exportFilename } from '../export/exportModel.js';
import { offlineCopyEnabled, setOfflineCopyEnabled, clearOfflineSnapshots } from '../offline/offlineSnapshot.js';
import { readReminderPrefs, writeReminderPrefs } from '../notifications/v4Reminders.js';

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const EXPORTS = [
  { id: 'tasks', labelKey: 'export.tasks', available: () => true },
  { id: 'notes', labelKey: 'export.notes', available: () => has('notes') },
  { id: 'routines', labelKey: 'export.routines', available: () => has('routines') },
  { id: 'attendance', labelKey: 'export.attendance', available: () => has('attendance') },
  { id: 'goals', labelKey: 'export.goals', available: () => has('goals') },
];

async function buildExport(id) {
  const uid = app().userId;
  const today = todayStr();
  if (id === 'tasks') {
    const [rows, courses, projects, goals] = await Promise.all([
      listTaskRowsInWindow(uid, addDays(today, -730), addDays(today, 730)),
      has('courses') ? listCourses(uid).catch(() => []) : [], has('projects') ? listProjects(uid).catch(() => []) : [], has('goals') ? listGoals(uid).catch(() => []) : [],
    ]);
    const blocks = await listBlocksForSubjectIds(rows.map((r) => r.id)).catch(() => []);
    const groups = buildTaskGroups(rows, blocks, { today, nowMinutes: minutesOfDay() });
    const name = (list, key) => (id2) => { const x = list.find((r) => r.id === id2); return x ? (x.code || x[key]) : ''; };
    return { text: tasksCsv(groups, { courseName: name(courses, 'name'), projectName: name(projects, 'title'), goalName: name(goals, 'title') }), type: 'text/csv;charset=utf-8' };
  }
  if (id === 'notes') return { text: notesMarkdown(await listNotes(uid), { untitled: t('notes.untitled'), exportedAt: new Date().toISOString() }), type: 'text/markdown;charset=utf-8' };
  if (id === 'routines') {
    const [routines, comps] = await Promise.all([listRoutines(uid), listCompletions(uid, '2000-01-01')]);
    return { text: routineLogCsv(routines, comps), type: 'text/csv;charset=utf-8' };
  }
  if (id === 'attendance') {
    const [records, courses] = await Promise.all([listAttendance(uid), listCourses(uid).catch(() => [])]);
    return { text: attendanceCsv(records, (cid) => { const c = courses.find((x) => x.id === cid); return c ? (c.code || c.name) : ''; }), type: 'text/csv;charset=utf-8' };
  }
  const [goals, logs] = await Promise.all([listGoals(uid), listGoalLogs(uid)]);
  return { text: goalCheckInsCsv(goals, logs), type: 'text/csv;charset=utf-8' };
}

export function renderFileExports(root) {
  if (!root) return;
  root.innerHTML = '';
  root.appendChild(h('h3', { class: 'settings3-subhead' }, t('export.title')));
  root.appendChild(h('p', { class: 'hint' }, t('export.hint')));
  const row = h('div', { class: 'settings-btn-row export-row' });
  EXPORTS.filter((x) => x.available()).forEach((x) => {
    const b = h('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-export': x.id }, h('span', {}, t(x.labelKey)));
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const { text, type } = await buildExport(x.id);
        download(exportFilename(x.id, todayStr()), text, type);
        toast(t('export.done'), { kind: 'success' });
      } catch (err) {
        console.error('Export failed', err);
        toast(t('export.failed'), { kind: 'error' });
      } finally {
        b.disabled = false;
      }
    });
    row.appendChild(b);
  });
  root.appendChild(row);
  root.appendChild(h('p', { class: 'field-hint' }, t('export.csvSafe')));
}

// App data this device keeps (never the sign-in session, language or theme).
const DEVICE_PREFIXES = ['student-scheduler-offline:', 'student-scheduler-workspace:', 'student-scheduler-dashboard:', 'student-scheduler-energy:', 'student-scheduler-reviews:', 'student-scheduler-space:',
  'student-scheduler-tasks-', 'student-scheduler-projects-filter', 'student-scheduler-goals-filter', 'student-scheduler-routines-filter', 'student-scheduler-notes-view', 'student-scheduler-review-area',
  'student-scheduler-v4-reminders', 'student-scheduler-exam-reminders', 'student-scheduler-week-mode'];

export function deviceDataKeys(keys) {
  return keys.filter((k) => DEVICE_PREFIXES.some((p) => k.startsWith(p)));
}

export function renderPrivacy(root) {
  if (!root) return;
  root.innerHTML = '';
  root.appendChild(h('h2', {}, t('privacy.title')));
  root.appendChild(h('p', { class: 'hint' }, t('privacy.intro')));
  const list = h('ul', { class: 'privacy-list' });
  ['account', 'device', 'noAi', 'noTracking', 'private'].forEach((k) => list.appendChild(h('li', {}, h('strong', {}, t(`privacy.${k}Title`)), h('span', {}, t(`privacy.${k}Body`)))));
  root.appendChild(list);

  root.appendChild(h('h3', { class: 'settings3-subhead' }, t('privacy.offlineTitle')));
  const cb = h('input', { type: 'checkbox', id: 'privacyOffline' });
  cb.checked = offlineCopyEnabled();
  cb.addEventListener('change', () => {
    setOfflineCopyEnabled(cb.checked);
    toast(cb.checked ? t('privacy.offlineOn') : t('privacy.offlineOff'));
  });
  root.appendChild(h('div', { class: 'checkbox-row' }, cb, h('label', { for: 'privacyOffline' }, t('privacy.offlineLabel'))));
  root.appendChild(h('p', { class: 'field-hint' }, t('privacy.offlineHint')));

  root.appendChild(h('h3', { class: 'settings3-subhead' }, t('privacy.deviceTitle')));
  root.appendChild(h('p', { class: 'hint' }, t('privacy.deviceHint')));
  const clear = h('button', { type: 'button', class: 'btn btn--secondary btn--sm' }, h('span', {}, t('privacy.clearDevice')));
  clear.addEventListener('click', async () => {
    const ok = await confirmAction({ title: t('privacy.clearTitle'), message: t('privacy.clearBody'), confirmLabel: t('privacy.clearConfirm'), danger: true });
    if (!ok) return;
    try {
      deviceDataKeys(Object.keys(localStorage)).forEach((k) => localStorage.removeItem(k));
      clearOfflineSnapshots();
      toast(t('privacy.cleared'), { kind: 'success' });
    } catch {
      toast(t('v3.saveError'), { kind: 'error' });
    }
  });
  root.appendChild(clear);

  root.appendChild(h('h3', { class: 'settings3-subhead' }, t('privacy.yourDataTitle')));
  root.appendChild(h('p', { class: 'hint' }, t('privacy.yourDataBody')));
}

export function renderV4Reminders(root) {
  if (!root) return;
  root.innerHTML = '';
  const prefs = readReminderPrefs();
  root.appendChild(h('h3', { class: 'settings3-subhead' }, t('reminders4.title')));
  [['routines', 'reminders4.routines', () => has('routines')], ['weeklyReview', 'reminders4.weeklyReview', () => true]].forEach(([key, labelKey, ok]) => {
    if (!ok()) return;
    const id = `rem4-${key}`;
    const cb = h('input', { type: 'checkbox', id });
    cb.checked = prefs[key];
    cb.addEventListener('change', () => writeReminderPrefs({ ...readReminderPrefs(), [key]: cb.checked }));
    root.appendChild(h('div', { class: 'checkbox-row' }, cb, h('label', { for: id }, t(labelKey))));
  });
  root.appendChild(h('p', { class: 'field-hint' }, t('reminders4.hint')));
}
