// Settings V3: the new tabs (Courses & semester, Keyboard, About) and the
// Data tab's full backup / restore. The V2 tabs keep their own wiring in
// dashboard.js; this module only renders into its own containers.

import { supabase } from '../lib/supabaseClient.js';
import { t, tCount } from '../shared/i18n.js';
import { html, raw, setHtml, h } from '../ui/dom.js';
import { button, migrationNotice, errorNotice, progressBar } from '../ui/components.js';
import { openDrawer } from '../ui/drawer.js';
import { toast } from '../ui/toast.js';
import { icon } from '../ui/icons.js';
import { app, emitChange } from '../app/context.js';
import { invalidate } from '../app/store.js';
import { has, probeCapabilities, capabilitySnapshot, missingMigrations, FEATURE_MIGRATIONS } from '../shared/capabilities.js';
import { listSemesters, listCourses } from '../academics/academicsData.js';
import { pickCurrentSemester, semesterProgress } from '../academics/semesterModel.js';
import { getDailyMaxStudyMinutes } from '../workload/loadData.js';
import { todayStr } from '../shared/dates.js';
import { fmtDate, fmtDateWithYear } from '../ui/format.js';
import { buildShortcutList } from '../shared/shortcutList.js';
import { exportBackup, prepareRestore, executeRestore } from '../backup/backupData.js';
import { parseBackup, validateBackup, backupFilename, BACKUP_TABLES } from '../backup/backupModel.js';
import { APP_VERSION } from '../app/version.js';
import { renderWorkspace } from './workspaceSettings.js';
import { examRemindersEnabled, setExamRemindersEnabled, startExamReminders } from '../notifications/examReminders.js';
import { listExams } from '../exams/examsData.js';

const MIN_DAILY = 30;
const MAX_DAILY = 960;

function download(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: filename });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function tableLabel(name) {
  return t(`backup.table_${name}`);
}

// ---------------- Courses & semester ----------------
async function renderAcademics(root) {
  setHtml(root, html`<h2>${t('settings3.tabAcademics')}</h2><p class="hint">${t('common.loading')}</p>`);
  await probeCapabilities();
  const userId = app().userId;
  if (!has('semesters') && !has('courses')) {
    setHtml(root, html`<h2>${t('settings3.tabAcademics')}</h2>${migrationNotice('courses')}`);
    return;
  }
  let semesters = [];
  let courses = [];
  let dailyMax = 240;
  try {
    [semesters, courses, dailyMax] = await Promise.all([
      has('semesters') ? listSemesters(userId) : [],
      has('courses') ? listCourses(userId) : [],
      getDailyMaxStudyMinutes(userId).catch(() => 240),
    ]);
  } catch (err) {
    setHtml(root, html`<h2>${t('settings3.tabAcademics')}</h2>${errorNotice(err.message)}`);
    return;
  }
  const today = todayStr();
  const current = pickCurrentSemester(semesters, today);
  const prog = current ? semesterProgress(current, today) : null;
  const active = courses.filter((c) => !c.archived);
  setHtml(root, html`
    <h2>${t('settings3.tabAcademics')}</h2>
    <div class="settings3-summary">
      <div class="settings3-stat">
        <span class="settings3-stat-label">${t('settings3.currentSemester')}</span>
        <strong>${current ? current.name : t('settings3.noSemester')}</strong>
        ${current ? html`<span class="muted">${fmtDate(current.start_date)} – ${fmtDateWithYear(current.end_date)}${prog && !prog.notStarted && !prog.finished ? ` · ${t('settings3.weekOf').replace('{n}', prog.weekIndex).replace('{total}', prog.totalWeeks)}` : ''}</span>` : ''}
      </div>
      <div class="settings3-stat">
        <span class="settings3-stat-label">${t('settings3.activeCourses')}</span>
        <strong>${active.length}</strong>
        <span class="muted">${tCount('settings3.archivedCount', courses.length - active.length)}</span>
      </div>
    </div>
    <div class="settings-btn-row">
      ${button(t('settings3.manageSemester'), { action: 'go-semester', iconName: 'calendar' })}
      ${button(t('settings3.manageCourses'), { action: 'go-courses', iconName: 'book' })}
    </div>

    <h3 class="settings3-subhead">${t('settings3.dailyMaxTitle')}</h3>
    <p class="hint">${t('settings3.dailyMaxHint')}</p>
    ${has('preferences') ? html`
      <form class="settings3-inline-form" data-form="daily-max">
        <label class="sr-only" for="settings3DailyMax">${t('settings3.dailyMaxTitle')}</label>
        <input type="number" id="settings3DailyMax" class="input settings3-num" min="${MIN_DAILY}" max="${MAX_DAILY}" step="15" value="${dailyMax}" inputmode="numeric">
        <span class="muted">${t('settings3.minutesPerDay')}</span>
        <button type="submit" class="btn btn--primary btn--sm"><span>${t('common.save')}</span></button>
      </form>
      <p class="hint" data-role="daily-max-msg" aria-live="polite"></p>` : migrationNotice('preferences')}
  `);
  root.querySelector('[data-action="go-semester"]').addEventListener('click', () => app().navigate('semesterView'));
  root.querySelector('[data-action="go-courses"]').addEventListener('click', () => app().navigate('coursesView'));
  const form = root.querySelector('[data-form="daily-max"]');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = form.querySelector('input');
      const msg = root.querySelector('[data-role="daily-max-msg"]');
      const value = Number(input.value);
      if (!Number.isInteger(value) || value < MIN_DAILY || value > MAX_DAILY) {
        msg.textContent = t('settings3.dailyMaxInvalid').replace('{min}', MIN_DAILY).replace('{max}', MAX_DAILY);
        msg.classList.add('hint-error');
        input.focus();
        return;
      }
      msg.classList.remove('hint-error');
      try {
        const { data } = await supabase.from('profiles').select('preferences').eq('id', userId).maybeSingle();
        const prefs = { ...((data && data.preferences) || {}), maxDailyStudyMinutes: value };
        const { error } = await supabase.from('profiles').update({ preferences: prefs }).eq('id', userId);
        if (error) throw error;
        invalidate('prefs:');
        emitChange('preferences');
        msg.textContent = t('settings3.saved');
      } catch (err) {
        msg.textContent = t('settings3.saveFailed');
        msg.classList.add('hint-error');
      }
    });
  }
}

// ---------------- Keyboard ----------------
function renderKeyboard(root) {
  setHtml(root, html`<h2>${t('settings3.tabKeyboard')}</h2><p class="hint">${t('settings3.keyboardHint')}</p>`);
  root.appendChild(buildShortcutList());
}

// ---------------- About ----------------
async function renderAbout(root) {
  await probeCapabilities();
  const caps = capabilitySnapshot();
  const missing = missingMigrations();
  const features = Object.keys(FEATURE_MIGRATIONS);
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  setHtml(root, html`
    <h2>${t('settings3.tabAbout')}</h2>
    <dl class="settings3-about">
      <div><dt>${t('settings3.version')}</dt><dd>${APP_VERSION}</dd></div>
      <div><dt>${t('settings3.mode')}</dt><dd>${app().isDemo ? t('settings3.modeDemo') : t('settings3.modeAccount')}</dd></div>
      <div><dt>${t('settings3.connection')}</dt><dd>${online ? t('settings3.online') : t('offline.title')}</dd></div>
      <div><dt>${t('settings3.aiNote')}</dt><dd>${t('settings3.aiNoteValue')}</dd></div>
    </dl>
    <h3 class="settings3-subhead">${t('settings3.dbStatus')}</h3>
    ${missing.length === 0
      ? html`<p class="settings3-ok">${raw(icon('check'))} ${t('settings3.dbAllGood')}</p>`
      : html`<div class="notice notice--info">${raw(icon('info'))}<div>
          <p class="notice-title">${t('settings3.dbMissingTitle')}</p>
          <p>${t('settings3.dbMissingBody')}</p>
          <ul class="settings3-migrations">${missing.map((f) => html`<li><code>${f}</code></li>`)}</ul>
        </div></div>`}
    <ul class="settings3-features">
      ${features.map((f) => html`<li class="${caps[f] ? 'is-on' : 'is-off'}">
        <span class="settings3-feature-dot" aria-hidden="true"></span>
        <span>${t(`settings3.feature_${f}`)}</span>
        <span class="muted">${caps[f] ? t('settings3.available') : t('settings3.needsUpdate')}</span>
      </li>`)}
    </ul>
    ${app().isDemo ? html`<p class="hint">${t('settings3.demoInfo')}</p>` : ''}
  `);
}

// ---------------- Data: backup & restore ----------------
function renderBackup(root) {
  setHtml(root, html`
    <h3 class="settings3-subhead">${t('backup.title')}</h3>
    <p class="hint">${t('backup.hint')}</p>
    <div class="settings-btn-row">
      ${button(t('backup.download'), { variant: 'primary', action: 'backup-download', iconName: 'download' })}
      ${button(t('backup.restore'), { action: 'backup-restore', iconName: 'upload' })}
    </div>
    <p class="hint" data-role="backup-msg" aria-live="polite"></p>
  `);
  const msg = root.querySelector('[data-role="backup-msg"]');
  const dl = root.querySelector('[data-action="backup-download"]');
  dl.addEventListener('click', async () => {
    dl.disabled = true;
    msg.classList.remove('hint-error');
    msg.textContent = t('settings.exportPreparing');
    try {
      await probeCapabilities();
      const backup = await exportBackup(app().userId);
      download(backupFilename(todayStr()), JSON.stringify(backup, null, 2));
      const rows = Object.values(backup.counts).reduce((s, n) => s + n, 0);
      msg.textContent = tCount('settings.exportDone', rows);
    } catch (err) {
      console.error('Backup failed', err);
      msg.classList.add('hint-error');
      msg.textContent = t('settings.exportFailed');
    } finally {
      dl.disabled = false;
    }
  });
  root.querySelector('[data-action="backup-restore"]').addEventListener('click', () => openRestoreDrawer());
}

function errorText(result) {
  let text = t(result.error);
  if (result.params) Object.entries(result.params).forEach(([k, v]) => { text = text.replace(`{${k}}`, v); });
  return text;
}

function openRestoreDrawer() {
  let plan = null;
  openDrawer({
    title: t('backup.restoreTitle'),
    subtitle: t('backup.restoreSub'),
    render: (body, api) => {
      const fileInput = h('input', { type: 'file', accept: 'application/json,.json', id: 'restoreFile', class: 'input', 'data-autofocus': true });
      const label = h('label', { for: 'restoreFile', class: 'field-label' }, t('backup.chooseFile'));
      const status = h('div', { class: 'restore-status', 'aria-live': 'polite' });
      body.append(label, fileInput, status);
      api.setActions([{ label: t('common.cancel'), onClick: (a) => a.close() }]);

      fileInput.addEventListener('change', async () => {
        plan = null;
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        setHtml(status, html`<p class="hint">${t('backup.checking')}</p>`);
        const text = await file.text();
        const parsed = parseBackup(text);
        if (!parsed.ok) {
          setHtml(status, html`<div class="notice notice--danger" role="alert">${raw(icon('alert'))}<div><p class="notice-title">${t('backup.cantUse')}</p><p>${errorText(parsed)}</p></div></div>`);
          return;
        }
        const v = validateBackup(parsed.data);
        if (!v.ok) {
          const sample = v.errors.slice(0, 5).map((e) => `${tableLabel(e.table)} #${e.index + 1}${e.column ? ` · ${e.column}` : ''}`);
          setHtml(status, html`<div class="notice notice--danger" role="alert">${raw(icon('alert'))}<div>
            <p class="notice-title">${t('backup.cantUse')}</p>
            <p>${tCount('backup.invalidRows', v.errors.length)}</p>
            <ul class="restore-errors">${sample.map((s) => html`<li>${s}</li>`)}</ul>
          </div></div>`);
          return;
        }
        try {
          await probeCapabilities();
          plan = await prepareRestore(app().userId, v.tables);
        } catch (err) {
          setHtml(status, errorNotice(err.message));
          return;
        }
        const total = Object.values(plan.counts).reduce((s, n) => s + n, 0);
        const skippedTotal = Object.values(plan.skipped).reduce((s, n) => s + n, 0);
        setHtml(status, html`
          <p class="restore-file">${raw(icon('file'))} <span>${file.name}</span>${parsed.data.exportedAt ? html` <span class="muted">· ${String(parsed.data.exportedAt).slice(0, 10)}</span>` : ''}</p>
          <h3 class="settings3-subhead">${t('backup.willAdd')}</h3>
          ${total === 0 ? html`<p class="hint">${t('backup.nothingToAdd')}</p>` : html`<ul class="restore-counts">
            ${BACKUP_TABLES.filter((tb) => plan.counts[tb]).map((tb) => html`<li><span>${tableLabel(tb)}</span><strong>${plan.counts[tb]}</strong></li>`)}
          </ul>`}
          ${plan.conflicts.days || plan.conflicts.courses || plan.conflicts.semesters || plan.conflicts.existing || skippedTotal ? html`<div class="notice notice--warning">${raw(icon('info'))}<div>
            <p class="notice-title">${t('backup.conflictsTitle')}</p>
            <ul class="restore-notes">
              ${plan.conflicts.existing ? html`<li>${tCount('backup.conflictExisting', plan.conflicts.existing)}</li>` : ''}
              ${plan.conflicts.days ? html`<li>${tCount('backup.conflictDays', plan.conflicts.days)}</li>` : ''}
              ${plan.conflicts.courses ? html`<li>${tCount('backup.conflictCourses', plan.conflicts.courses)}</li>` : ''}
              ${plan.conflicts.semesters ? html`<li>${tCount('backup.conflictSemesters', plan.conflicts.semesters)}</li>` : ''}
              ${skippedTotal ? html`<li>${tCount('backup.skippedRows', skippedTotal)}</li>` : ''}
              ${plan.unavailable.length ? html`<li>${t('backup.unavailable').replace('{tables}', plan.unavailable.map(tableLabel).join(', '))}</li>` : ''}
            </ul>
          </div></div>` : ''}
          <p class="hint">${t('backup.copyNote')}</p>
        `);
        api.setActions([
          { label: t('common.cancel'), onClick: (a) => a.close() },
          ...(total > 0 ? [{ label: tCount('backup.confirmRestore', total), variant: 'primary', onClick: (a) => runRestore(a, status) }] : []),
        ]);
      });
    },
  });

  async function runRestore(api, status) {
    if (!plan) return;
    api.setBusy(true);
    setHtml(status, html`<p class="hint">${t('backup.restoring')}</p><div data-role="bar">${progressBar(0, { label: t('backup.restoring') })}</div>`);
    const bar = status.querySelector('[data-role="bar"]');
    const result = await executeRestore(plan, {
      onProgress: (done, total) => setHtml(bar, progressBar(total ? done / total : 1, { label: t('backup.restoring') })),
    });
    if (result.ok) {
      invalidate('');
      emitChange('restore');
      app().refreshPlanner();
      toast(tCount('backup.restored', result.inserted), { kind: 'success' });
      api.close(true);
      return;
    }
    api.setBusy(false);
    setHtml(status, html`<div class="notice notice--danger" role="alert">${raw(icon('alert'))}<div>
      <p class="notice-title">${t('backup.failedTitle')}</p>
      <p>${result.rolledBack ? t('backup.failedRolledBack') : t('backup.failedPartial')}</p>
      ${result.table ? html`<p class="muted">${tableLabel(result.table)}: ${result.error}</p>` : ''}
    </div></div>`);
    api.setActions([{ label: t('common.close'), onClick: (a) => a.close(true) }]);
  }
}

export function initSettingsV3() {
  const panels = {
    academics: document.getElementById('settingsPanel-academics'),
    workspace: document.getElementById('settingsPanel-workspace'),
    keyboard: document.getElementById('settingsPanel-keyboard'),
    about: document.getElementById('settingsPanel-about'),
  };
  const backupRoot = document.getElementById('settingsBackupV3');
  if (backupRoot) renderBackup(backupRoot);

  // Exam reminders: opt-in; they only fire once permission is granted in
  // the Notifications tab (this never prompts by itself).
  const examToggle = document.getElementById('examReminderToggle');
  if (examToggle) {
    examToggle.checked = examRemindersEnabled();
    examToggle.addEventListener('change', () => setExamRemindersEnabled(examToggle.checked));
  }
  startExamReminders({
    today: () => todayStr(),
    loadExams: async () => {
      await probeCapabilities();
      return has('exams') && app().userId ? listExams(app().userId) : [];
    },
    format: (stage, exam) => ({
      title: t('notifications.examReminderTitle'),
      body: t(`notifications.exam_${stage}`).replace('{name}', exam.name),
    }),
  });
  return {
    onTab(key) {
      if (key === 'academics' && panels.academics) renderAcademics(panels.academics);
      if (key === 'workspace' && panels.workspace) renderWorkspace(panels.workspace);
      if (key === 'keyboard' && panels.keyboard) renderKeyboard(panels.keyboard);
      if (key === 'about' && panels.about) renderAbout(panels.about);
    },
    rerenderBackup() {
      if (backupRoot) renderBackup(backupRoot);
    },
  };
}
