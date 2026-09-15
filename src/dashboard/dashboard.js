import { supabase } from '../lib/supabaseClient.js';
import { requireAuth } from '../shared/session.js';
import {
  getMostRecentScheduleDate,
  getOrCreateScheduleForDate,
  getScheduleForDateIfExists,
  scheduleHasPlanningData,
  copyScheduleToDate,
  listScheduleHistory,
  tomorrowDateStr,
  addDaysToDateStr,
  updateSchedule,
  listClasses,
  insertClass,
  updateClass,
  deleteClass,
  listStudySubjects,
  insertStudySubject,
  updateStudySubject,
  deleteStudySubject,
  listScheduleItems,
  saveGeneratedSchedule,
  setScheduleItemLocked,
  setScheduleItemCompleted,
  updateScheduleItemTime,
} from './data.js';
import {
  generateSchedule,
  resolveDayBounds,
  resolveStudyWindow,
  resolveClockTimeInDay,
  validateManualStudyEdit,
  formatClock,
  timeToMinutes,
  minutesToClock,
} from './scheduler.js';
import { computeDailySummary, computeSubjectProgress, formatDuration } from './summary.js';
import { validateCopyDestination } from './copySchedule.js';

// ---------------- theme (applied immediately, before auth, to avoid a flash) ----------------
// Purely presentational — adds/removes a data-theme attribute on <html> and
// remembers the choice in localStorage. Touches no existing element/id and
// has no effect on any scheduling, Supabase, or auth logic.
const THEME_STORAGE_KEY = 'student-scheduler-theme';

function applyTheme(theme) {
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.setAttribute('data-theme', theme);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

function currentEffectiveTheme() {
  const explicit = document.documentElement.getAttribute('data-theme');
  if (explicit) return explicit;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

try {
  applyTheme(localStorage.getItem(THEME_STORAGE_KEY));
} catch {
  // localStorage unavailable (e.g. a strict privacy mode) — fall back to the OS preference
}

const session = await requireAuth();
if (session) {
  init(session).catch((e) => {
    console.error(e);
    document.getElementById('loadError').textContent =
      'Something went wrong loading your data. Please refresh the page to try again.';
  });
}

async function init(session) {
  const userId = session.user.id;
  const loadError = document.getElementById('loadError');
  const plannerForm = document.getElementById('plannerForm');
  const nameEl = document.getElementById('userName');
  const saveStatus = document.getElementById('saveStatus');

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await supabase.auth.signOut();
    window.location.href = 'login.html';
  });

  const { data: profile } = await supabase.from('profiles').select('name').eq('id', userId).single();
  nameEl.textContent = `Hi, ${profile?.name || session.user.email}`;

  // ---------------- sidebar: name/avatar mirror, theme toggle, nav scroll ----------------
  // All purely presentational additions — none of this reads/writes anything
  // beyond the DOM, and none of it replaces or renames an existing element.
  const displayName = profile?.name || session.user.email;
  const sidebarNameEl = document.getElementById('userNameSidebar');
  if (sidebarNameEl) sidebarNameEl.textContent = displayName;
  const avatarEl = document.getElementById('userAvatar');
  if (avatarEl) avatarEl.textContent = displayName.trim().charAt(0).toUpperCase() || '·';

  const themeToggleBtn = document.getElementById('themeToggle');
  const themeToggleLabel = document.getElementById('themeToggleLabel');
  function refreshThemeToggleLabel() {
    if (themeToggleLabel) themeToggleLabel.textContent = currentEffectiveTheme() === 'dark' ? 'Light mode' : 'Dark mode';
  }
  refreshThemeToggleLabel();
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      const next = currentEffectiveTheme() === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try {
        localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // per-viewer convenience only — fine if it can't persist
      }
      refreshThemeToggleLabel();
    });
  }

  document.querySelectorAll('.nav-item[data-scroll-target]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const target = document.getElementById(btn.dataset.scrollTarget);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  // The currently active date's schedule row. Reassigned by loadScheduleForDate()
  // whenever the user navigates to a different date. Every async operation that
  // writes to a specific schedule/row captures the id it needs SYNCHRONOUSLY,
  // before any `await`, rather than reading `schedule.id` after the fact — so a
  // date switch that happens while a save is in flight can never misattribute
  // that save to the wrong date.
  let schedule = null;

  // Bumped every time a new date starts loading; async loads/saves compare
  // their captured token against this after each await and bail out if it no
  // longer matches, so a stale in-flight response from a date the user has
  // since navigated away from can never overwrite what's currently on screen.
  let activeToken = 0;

  function flashSaved() {
    saveStatus.textContent = 'Saved';
    saveStatus.className = 'hint';
    clearTimeout(flashSaved._t);
    flashSaved._t = setTimeout(() => { saveStatus.textContent = ''; }, 1200);
  }
  function flashError(msg) {
    saveStatus.textContent = msg;
    saveStatus.className = 'hint';
  }

  // serializes saves per row so a fast second edit never races ahead of the
  // insert that assigns the row its database id (which would create a duplicate)
  function chainSave(target, fn) {
    const prev = target._savePromise || Promise.resolve();
    const next = prev.then(fn).catch((e) => {
      console.error(e);
      flashError('Could not save — check your connection.');
    });
    target._savePromise = next;
    return next;
  }

  function toHHMM(t) {
    return t ? t.slice(0, 5) : '';
  }
  function escapeAttr(str) {
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }
  function formatDateLabel(dateStr) {
    return new Date(`${dateStr}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // ---------------- day settings ----------------
  const forDateEl = document.getElementById('forDate');
  const wakeTimeEl = document.getElementById('wakeTime');
  const sleepTimeEl = document.getElementById('sleepTime');
  const prevDayBtn = document.getElementById('prevDayBtn');
  const nextDayBtn = document.getElementById('nextDayBtn');
  const meal = {
    breakfast: { on: document.getElementById('mealBreakfastOn'), time: document.getElementById('mealBreakfastTime') },
    lunch: { on: document.getElementById('mealLunchOn'), time: document.getElementById('mealLunchTime') },
    dinner: { on: document.getElementById('mealDinnerOn'), time: document.getElementById('mealDinnerTime') },
  };
  const preferredPeriodEl = document.getElementById('preferredStudyPeriod');
  const sessionCapEl = document.getElementById('sessionCapMinutes');
  const breakMinutesEl = document.getElementById('breakMinutes');
  const minBlockEl = document.getElementById('minBlockMinutes');
  const earliestStudyEl = document.getElementById('earliestStudyTime');
  const latestStudyEl = document.getElementById('latestStudyTime');

  function updateDayLengthHint() {
    const hintEl = document.getElementById('dayLengthHint');
    const wake = timeToMinutes(wakeTimeEl.value);
    let sleep = timeToMinutes(sleepTimeEl.value);
    if (wake === null || sleep === null) {
      hintEl.textContent = '';
      hintEl.className = 'hint';
      return;
    }
    const overnight = sleep <= wake;
    if (overnight) sleep += 1440;
    const total = sleep - wake;
    const h = Math.floor(total / 60);
    const m = total % 60;
    const durText = `${h}h${m ? ' ' + m + 'm' : ''}`;
    const untilText = overnight ? `${minutesToClock(sleep)} (next day)` : minutesToClock(sleep);
    hintEl.textContent = `Your day: ${minutesToClock(wake)} → ${untilText} (${durText} total)${total < 60 ? ' — too short, add more time' : ''}`;
    hintEl.className = 'hint day-length';
  }

  const daySettingsForm = document.getElementById('daySettingsForm');
  const studyPrefsForm = document.getElementById('studyPrefsForm');
  // shared save target so an edit in either section is serialized with the other,
  // since both write to the same `schedules` row
  const scheduleSaveTarget = {};

  // study-preference number fields have no fallback value, so a save is skipped
  // (not sent as 0/NaN) until all three are filled in
  function collectStudyPrefsFields() {
    const sessionCap = parseInt(sessionCapEl.value, 10);
    const breakMinutes = parseInt(breakMinutesEl.value, 10);
    const minBlock = parseInt(minBlockEl.value, 10);
    if (!sessionCap || !minBlock || !Number.isFinite(breakMinutes) || breakMinutes < 0) return null;
    return {
      preferred_study_period: preferredPeriodEl.value,
      session_cap_minutes: sessionCap,
      switch_break_minutes: breakMinutes,
      min_block_minutes: minBlock,
      earliest_study_time: earliestStudyEl.value || null,
      latest_study_time: latestStudyEl.value || null,
    };
  }

  function saveScheduleSettings() {
    updateDayLengthHint();
    const scheduleId = schedule.id; // capture now — see note on `schedule` above
    chainSave(scheduleSaveTarget, async () => {
      const updated = await updateSchedule(scheduleId, {
        for_date: forDateEl.value,
        wake_time: wakeTimeEl.value,
        sleep_time: sleepTimeEl.value,
        breakfast_on: meal.breakfast.on.checked,
        breakfast_time: meal.breakfast.time.value,
        lunch_on: meal.lunch.on.checked,
        lunch_time: meal.lunch.time.value,
        dinner_on: meal.dinner.on.checked,
        dinner_time: meal.dinner.time.value,
        ...(collectStudyPrefsFields() || {}),
      });
      // only adopt the result if we're still looking at that same date —
      // otherwise this would clobber whatever loadScheduleForDate put there
      if (schedule && schedule.id === scheduleId) schedule = updated;
      flashSaved();
    });
  }
  daySettingsForm.addEventListener('change', saveScheduleSettings);
  studyPrefsForm.addEventListener('change', saveScheduleSettings);

  // forDate is a navigation control, not a "rename this schedule" field — it
  // gets its own listener (stopping propagation so daySettingsForm's delegated
  // change handler above doesn't ALSO treat it as a settings edit) that loads
  // (or creates) the schedule for whatever date was picked.
  forDateEl.addEventListener('change', (e) => {
    e.stopPropagation();
    if (!forDateEl.value) return;
    loadScheduleForDate(forDateEl.value);
  });
  prevDayBtn.addEventListener('click', () => {
    if (!schedule) return;
    loadScheduleForDate(addDaysToDateStr(schedule.for_date, -1));
  });
  nextDayBtn.addEventListener('click', () => {
    if (!schedule) return;
    loadScheduleForDate(addDaysToDateStr(schedule.for_date, 1));
  });

  // ---------------- classes ----------------
  const classList = document.getElementById('classList');

  function addClassRow(row = {}) {
    const el = document.createElement('div');
    el.className = 'entry-row';
    if (row.id) el.dataset.id = row.id;
    el.innerHTML = `
      <input type="text" class="class-name" aria-label="Class name" placeholder="e.g. Math" value="${escapeAttr(row.name || '')}">
      <div class="cls-time-group">
        <input type="time" class="class-start" aria-label="Start time" value="${toHHMM(row.start_time)}">
        <span class="cls-time-sep">–</span>
        <input type="time" class="class-end" aria-label="End time" value="${toHHMM(row.end_time)}">
      </div>
      <button class="remove-btn" type="button" title="Remove">✕</button>
    `;
    el.querySelector('.remove-btn').addEventListener('click', () => {
      el.remove();
      chainSave(el, async () => {
        if (el.dataset.id) {
          await deleteClass(el.dataset.id);
          refreshHistoryList();
        }
      });
    });
    classList.appendChild(el);
    return el;
  }

  classList.addEventListener('change', (e) => {
    const row = e.target.closest('.entry-row');
    if (!row) return;
    const scheduleId = schedule.id;
    chainSave(row, async () => {
      const fields = {
        name: row.querySelector('.class-name').value.trim(),
        start_time: row.querySelector('.class-start').value,
        end_time: row.querySelector('.class-end').value,
      };
      if (!fields.name || !fields.start_time || !fields.end_time) return; // wait until the row is complete

      if (row.dataset.id) {
        await updateClass(row.dataset.id, fields);
      } else {
        const sortOrder = Array.from(classList.children).indexOf(row);
        const created = await insertClass(scheduleId, userId, fields, sortOrder);
        row.dataset.id = created.id;
        refreshHistoryList();
      }
      flashSaved();
    });
  });

  document.getElementById('addClassBtn').addEventListener('click', () => addClassRow());

  // ---------------- study subjects ----------------
  const studyList = document.getElementById('studyList');

  function addStudyRow(row = {}) {
    const el = document.createElement('div');
    el.className = 'entry-row study';
    if (row.id) el.dataset.id = row.id;
    const priority = row.priority || 'medium';
    el.innerHTML = `
      <div class="task-row-top">
        <input type="text" class="study-name" aria-label="Study task name" placeholder="e.g. Biology" value="${escapeAttr(row.name || '')}">
        <select class="study-priority" aria-label="Priority" data-priority="${priority}">
          <option value="low" ${priority === 'low' ? 'selected' : ''}>Low</option>
          <option value="medium" ${priority === 'medium' ? 'selected' : ''}>Medium</option>
          <option value="high" ${priority === 'high' ? 'selected' : ''}>High</option>
        </select>
        <button class="remove-btn" type="button" title="Remove">✕</button>
      </div>
      <div class="task-row-meta">
        <label class="task-mini-field">
          <span>Minutes</span>
          <input type="number" class="study-minutes" min="5" step="5" value="${row.minutes_requested || ''}">
        </label>
        <label class="task-mini-field">
          <span>Due</span>
          <input type="date" class="study-due" value="${row.due_date || ''}">
        </label>
      </div>
      <input type="text" class="study-notes" aria-label="Notes" placeholder="Notes (optional)" value="${escapeAttr(row.notes || '')}">
    `;
    el.querySelector('.remove-btn').addEventListener('click', () => {
      el.remove();
      chainSave(el, async () => {
        if (el.dataset.id) {
          await deleteStudySubject(el.dataset.id);
          refreshHistoryList();
        }
      });
    });
    studyList.appendChild(el);
    return el;
  }

  studyList.addEventListener('change', (e) => {
    // purely visual: keeps the priority select's color-coded badge in sync —
    // does not affect what gets saved below
    if (e.target.classList.contains('study-priority')) {
      e.target.dataset.priority = e.target.value;
    }
    const row = e.target.closest('.entry-row');
    if (!row) return;
    const scheduleId = schedule.id;
    chainSave(row, async () => {
      const name = row.querySelector('.study-name').value.trim();
      const minutes = parseInt(row.querySelector('.study-minutes').value, 10);
      if (!name || !minutes || minutes <= 0) return; // wait until the row is complete

      const priority = row.querySelector('.study-priority').value;
      const dueDate = row.querySelector('.study-due').value;
      const notes = row.querySelector('.study-notes').value.trim();

      const fields = {
        name,
        minutes_requested: minutes,
        priority,
        due_date: dueDate || null,
        notes,
      };
      if (row.dataset.id) {
        await updateStudySubject(row.dataset.id, fields);
      } else {
        const sortOrder = Array.from(studyList.children).indexOf(row);
        const created = await insertStudySubject(scheduleId, userId, fields, sortOrder);
        row.dataset.id = created.id;
        refreshHistoryList();
      }
      flashSaved();
    });
  });

  document.getElementById('addStudyBtn').addEventListener('click', () => addStudyRow());

  // ---------------- generate + render the schedule ----------------
  const output = document.getElementById('output');
  const notesEl = document.getElementById('notes');
  const regenerateBtn = document.getElementById('regenerateBtn');

  // in-memory mirror of the schedule_items rows currently in the database, so
  // lock/unlock has an id to act on and Regenerate knows which study blocks
  // are locked. Populated on load and after every successful save.
  let currentScheduleItems = [];

  // id of the study block currently showing its inline edit panel, if any —
  // at most one open at a time, closed whenever the timeline re-renders for
  // an unrelated reason (lock/done toggle, regenerate, date switch).
  let editingItemId = null;

  function minutesToInputTime(mins) {
    const m = ((mins % 1440) + 1440) % 1440;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  function buildSubjectsInput() {
    return Array.from(studyList.children).map((row) => ({
      id: row.dataset.id || null,
      name: row.querySelector('.study-name').value.trim(),
      minutes: parseInt(row.querySelector('.study-minutes').value, 10),
      priority: row.querySelector('.study-priority').value,
      dueDate: row.querySelector('.study-due').value || null,
    }));
  }

  function formatDueDate(dueDateStr) {
    if (!dueDateStr) return null;
    const due = new Date(`${dueDateStr}T00:00:00`);
    const base = new Date(`${forDateEl.value || dueDateStr}T00:00:00`);
    const diffDays = Math.round((due - base) / 86400000);
    if (diffDays === 0) return 'Due today';
    if (diffDays === 1) return 'Due tomorrow';
    if (diffDays === -1) return 'Due yesterday (overdue)';
    if (diffDays < -1) return `Due ${due.toLocaleDateString()} (overdue)`;
    return `Due ${due.toLocaleDateString()}`;
  }

  function renderScheduleEvents(events, subjectsForLookup) {
    if (!events || events.length === 0) {
      output.innerHTML = '<div class="placeholder">Nothing to show yet.</div>';
      return;
    }
    const subjectByName = new Map((subjectsForLookup || []).map((s) => [s.name, s]));
    const html = events
      .map((e) => {
        const dur = e.end - e.start;
        const durText = dur >= 60 ? `${Math.floor(dur / 60)}h ${dur % 60 ? (dur % 60) + 'm' : ''}`.trim() : `${dur} min`;
        const metaParts = [`${formatClock(e.start)} – ${formatClock(e.end)}`, durText];

        let priorityBadge = '';
        let lockControl = '';
        let doneControl = '';
        let editControl = '';
        let nameHtml = escapeAttr(e.name);
        if (e.type === 'study') {
          const subj = subjectByName.get(e.name);
          if (subj?.priority) {
            priorityBadge = `<span class="tl-badge tl-badge-${subj.priority}">${subj.priority.toUpperCase()}</span>`;
          }
          const dueText = formatDueDate(subj?.dueDate);
          if (dueText) metaParts.push(dueText);

          if (e.completed) nameHtml = `✓ ${nameHtml}`;

          if (e.id) {
            lockControl = `<button type="button" class="lock-btn" data-id="${e.id}" data-locked="${e.locked ? '1' : '0'}">${e.locked ? '🔒 Locked' : '🔓 Lock'}</button>`;
            doneControl = `<button type="button" class="done-btn" data-id="${e.id}" data-completed="${e.completed ? '1' : '0'}">${e.completed ? 'Undo' : 'Mark Done'}</button>`;
            // editing a locked block is blocked in favor of unlocking it first — see
            // the Phase 9 note on validateManualStudyEdit for why
            if (e.id === editingItemId) {
              editControl = `
                <div class="edit-panel">
                  <label>Start time</label>
                  <input type="time" class="edit-start-input" value="${minutesToInputTime(e.start)}">
                  <div class="edit-actions">
                    <button type="button" class="edit-save-btn" data-id="${e.id}">Save</button>
                    <button type="button" class="edit-cancel-btn" data-id="${e.id}">Cancel</button>
                  </div>
                  <div class="edit-error"></div>
                </div>
              `;
            } else if (!e.locked) {
              editControl = `<button type="button" class="edit-btn" data-id="${e.id}">Edit</button>`;
            }
          }
        }

        const actionsHtml = lockControl || doneControl || editControl ? `<div class="tl-actions">${lockControl}${doneControl}${editControl}</div>` : '';

        return `
          <div class="tl-row tl-${e.type}${e.locked ? ' tl-locked' : ''}${e.completed ? ' tl-completed' : ''}">
            <div class="tl-time">${formatClock(e.start)}</div>
            <div class="tl-rail"><span class="tl-dot"></span></div>
            <div class="tl-card">
              <div class="tl-card-top">
                <span class="tl-name">${nameHtml}</span>
                ${priorityBadge}
              </div>
              <div class="tl-meta">${escapeAttr(metaParts.join(' · '))}</div>
              ${actionsHtml}
            </div>
          </div>
        `;
      })
      .join('');
    output.innerHTML = `<div class="timeline">${html}</div>`;
  }

  output.addEventListener('click', async (e) => {
    const lockBtn = e.target.closest('.lock-btn');
    if (lockBtn) {
      const id = lockBtn.dataset.id;
      const newLocked = lockBtn.dataset.locked !== '1';
      const token = activeToken;
      lockBtn.disabled = true;
      try {
        await setScheduleItemLocked(id, newLocked);
        if (token !== activeToken) return; // navigated away before this resolved
        const item = currentScheduleItems.find((i) => i.id === id);
        if (item) item.locked = newLocked;
        renderScheduleEvents(currentScheduleItems, buildSubjectsInput());
        renderDailySummaryFromCurrent();
        flashSaved();
      } catch (err) {
        console.error(err);
        flashError('Could not update lock state — check your connection.');
        lockBtn.disabled = false;
      }
      return;
    }

    const doneBtn = e.target.closest('.done-btn');
    if (doneBtn) {
      const id = doneBtn.dataset.id;
      const newCompleted = doneBtn.dataset.completed !== '1';
      const token = activeToken;
      doneBtn.disabled = true;
      try {
        await setScheduleItemCompleted(id, newCompleted);
        if (token !== activeToken) return;
        const item = currentScheduleItems.find((i) => i.id === id);
        if (item) item.completed = newCompleted;
        renderScheduleEvents(currentScheduleItems, buildSubjectsInput());
        renderDailySummaryFromCurrent();
        refreshHistoryList();
        flashSaved();
      } catch (err) {
        console.error(err);
        flashError('Could not update completion state — check your connection.');
        doneBtn.disabled = false;
      }
      return;
    }

    const editBtn = e.target.closest('.edit-btn');
    if (editBtn) {
      editingItemId = editBtn.dataset.id;
      renderScheduleEvents(currentScheduleItems, buildSubjectsInput());
      return;
    }

    const cancelBtn = e.target.closest('.edit-cancel-btn');
    if (cancelBtn) {
      editingItemId = null;
      renderScheduleEvents(currentScheduleItems, buildSubjectsInput());
      return;
    }

    const saveBtn = e.target.closest('.edit-save-btn');
    if (saveBtn) {
      const id = saveBtn.dataset.id;
      const panel = saveBtn.closest('.edit-panel');
      const input = panel.querySelector('.edit-start-input');
      const errorEl = panel.querySelector('.edit-error');
      const item = currentScheduleItems.find((i) => i.id === id);
      if (!item) return;

      const bounds = resolveDayBounds(wakeTimeEl.value, sleepTimeEl.value);
      if (bounds.error) {
        errorEl.textContent = bounds.error;
        return;
      }
      const newStart = resolveClockTimeInDay(input.value, bounds.dayStart, bounds.dayEnd);
      if (newStart === null) {
        errorEl.textContent = 'Please enter a valid time.';
        return;
      }

      const { studyWindowStart, studyWindowEnd } = resolveStudyWindow(
        toHHMM(schedule.earliest_study_time) || null,
        toHHMM(schedule.latest_study_time) || null,
        bounds.dayStart,
        bounds.dayEnd
      );
      const fixedEvents = currentScheduleItems.filter((i) => i.type === 'class' || i.type === 'meal');
      const otherStudyBlocks = currentScheduleItems.filter((i) => i.type === 'study' && i.id !== id);

      const result = validateManualStudyEdit({
        newStart,
        duration: item.end - item.start,
        dayStart: bounds.dayStart,
        dayEnd: bounds.dayEnd,
        studyWindowStart,
        studyWindowEnd,
        fixedEvents,
        otherStudyBlocks,
      });

      if (!result.ok) {
        errorEl.textContent = result.error;
        return;
      }

      const token = activeToken;
      saveBtn.disabled = true;
      try {
        await updateScheduleItemTime(id, result.start, result.end);
        if (token !== activeToken) return; // navigated away before this resolved
        item.start = result.start;
        item.end = result.end;
        editingItemId = null;
        currentScheduleItems.sort((a, b) => a.start - b.start);
        renderScheduleEvents(currentScheduleItems, buildSubjectsInput());
        renderDailySummaryFromCurrent();
        flashSaved();
      } catch (err) {
        console.error(err);
        errorEl.textContent = 'Could not save — check your connection.';
        saveBtn.disabled = false;
      }
    }
  });

  function renderNotes(notes) {
    notesEl.innerHTML = (notes || []).map((n) => `<div class="note">${escapeAttr(n)}</div>`).join('');
  }

  function showScheduleError(msg) {
    output.innerHTML = `<div class="error">${escapeAttr(msg)}</div>`;
    notesEl.innerHTML = '';
  }

  const lockConflictEl = document.getElementById('lockConflictWarning');
  const lockConflictBody = document.getElementById('lockConflictBody');

  function renderLockConflicts(conflicts) {
    if (!conflicts || conflicts.length === 0) {
      lockConflictEl.hidden = true;
      lockConflictBody.innerHTML = '';
      return;
    }
    lockConflictBody.innerHTML = conflicts.map((c) => `<div class="item plain">${escapeAttr(c)}</div>`).join('');
    lockConflictEl.hidden = false;
  }

  // ---------------- daily summary + insufficient-time warning ----------------
  const shortfallWarningEl = document.getElementById('shortfallWarning');
  const shortfallWarningBody = document.getElementById('shortfallWarningBody');
  const dailySummaryCard = document.getElementById('dailySummaryCard');
  const dailySummaryBody = document.getElementById('dailySummaryBody');

  function renderShortfallWarning(progress) {
    if (!progress || progress.unscheduledTotal <= 0) {
      shortfallWarningEl.hidden = true;
      shortfallWarningBody.innerHTML = '';
      return;
    }
    const affected = progress.subjects.filter((s) => s.unscheduled > 0);
    const list = affected
      .map((s) => `<div class="item"><span>${escapeAttr(s.name)}</span><span class="value">${s.scheduled} / ${s.requested} min</span></div>`)
      .join('');
    shortfallWarningBody.innerHTML = `
      <div class="warning-totals">
        <div class="row"><span>Requested study time</span><span class="value">${progress.requestedTotal} min</span></div>
        <div class="row"><span>Scheduled study time</span><span class="value">${progress.scheduledTotal} min</span></div>
        <div class="row"><span>Unscheduled</span><span class="value">${progress.unscheduledTotal} min</span></div>
      </div>
      <div class="warning-list">${list}</div>
    `;
    shortfallWarningEl.hidden = false;
  }

  function renderDailySummary(summary, progress) {
    if (!summary) {
      dailySummaryCard.hidden = true;
      return;
    }
    const rows = [
      ['Classes', summary.classMinutes],
      ['Study', summary.studyMinutes],
      ['Meals', summary.mealMinutes],
      ['Breaks', summary.breakMinutes],
      ['Free time', summary.freeMinutes],
      ['Awake time', summary.awakeMinutes],
    ];
    let html = rows
      .map(([label, mins]) => `<div class="summary-row"><span class="label">${label}</span><span class="value">${formatDuration(mins)}</span></div>`)
      .join('');
    if (summary.sleepMinutes !== null) {
      html += `<div class="summary-row"><span class="label">Sleep</span><span class="value">${formatDuration(summary.sleepMinutes)}</span></div>`;
    }
    if (progress) {
      const total = progress.subjects.length;
      html += `<div class="summary-progress">Study Progress: <strong>${progress.completedCount} / ${total}</strong> tasks completed`;
      if (total > 0) html += ` <span class="summary-percent">(${progress.completionPercent}% complete)</span>`;
      html += `</div>`;
    }
    dailySummaryBody.innerHTML = html;
    dailySummaryCard.hidden = false;
  }

  // Recomputes and re-renders the daily summary + shortfall warning from
  // whatever is currently in `currentScheduleItems` — used after a lock or
  // completion toggle, where the timeline itself doesn't change but the
  // progress numbers do.
  function renderDailySummaryFromCurrent() {
    const bounds = resolveDayBounds(wakeTimeEl.value, sleepTimeEl.value);
    if (bounds.error) return;
    const progress = computeSubjectProgress(currentScheduleItems, buildSubjectsInput());
    renderDailySummary(computeDailySummary(currentScheduleItems, bounds.dayStart, bounds.dayEnd), progress);
    renderShortfallWarning(progress);
  }

  function updateRegenerateVisibility() {
    regenerateBtn.hidden = currentScheduleItems.length === 0;
  }

  async function runGeneration(lockedBlocks) {
    const scheduleId = schedule.id;
    const token = activeToken;
    editingItemId = null; // the whole timeline is about to be replaced

    const classesInput = Array.from(classList.children).map((row) => ({
      name: row.querySelector('.class-name').value.trim(),
      start: row.querySelector('.class-start').value,
      end: row.querySelector('.class-end').value,
    }));

    const subjectsInput = buildSubjectsInput();

    const mealsInput = [
      { name: 'Breakfast', duration: 30, on: meal.breakfast.on.checked, time: meal.breakfast.time.value },
      { name: 'Lunch', duration: 45, on: meal.lunch.on.checked, time: meal.lunch.time.value },
      { name: 'Dinner', duration: 45, on: meal.dinner.on.checked, time: meal.dinner.time.value },
    ];

    const result = generateSchedule({
      wakeTime: wakeTimeEl.value,
      sleepTime: sleepTimeEl.value,
      classes: classesInput,
      meals: mealsInput,
      subjects: subjectsInput,
      prefs: {
        sessionCap: schedule.session_cap_minutes,
        staminaBreak: schedule.stamina_break_minutes,
        switchBreak: schedule.switch_break_minutes,
        minNewBlock: schedule.min_block_minutes,
        preferredPeriod: schedule.preferred_study_period,
        earliestStudyTime: toHHMM(schedule.earliest_study_time) || null,
        latestStudyTime: toHHMM(schedule.latest_study_time) || null,
      },
      lockedBlocks,
    });

    if (result.error) {
      showScheduleError(result.error);
      renderDailySummary(null);
      renderShortfallWarning(null);
      renderLockConflicts(null);
      return;
    }

    if (result.lockConflicts && result.lockConflicts.length > 0) {
      // don't touch the saved schedule or currentScheduleItems — leave things exactly
      // as they were and tell the user what needs to be unlocked/adjusted first
      renderLockConflicts(result.lockConflicts);
      return;
    }
    renderLockConflicts(null);

    renderScheduleEvents(result.events, subjectsInput);
    renderNotes(result.notes);

    const progress = computeSubjectProgress(result.events, subjectsInput);
    renderDailySummary(computeDailySummary(result.events, result.dayStart, result.dayEnd), progress);
    renderShortfallWarning(progress);

    try {
      const savedRows = await saveGeneratedSchedule(scheduleId, userId, result.events);
      if (token !== activeToken) return; // navigated to a different date while this was saving

      // locked rows were left untouched in the database (same ids) — merge them
      // back in alongside the freshly (re)inserted unlocked rows
      const lockedRows = currentScheduleItems.filter((i) => i.type === 'study' && i.locked);
      currentScheduleItems = [
        ...lockedRows,
        ...savedRows.map((r) => ({
          id: r.id,
          type: r.item_type,
          name: r.name,
          start: r.start_minutes,
          end: r.end_minutes,
          locked: r.locked,
          completed: r.completed,
          sourceSubjectId: r.source_subject_id,
        })),
      ].sort((a, b) => a.start - b.start);
      renderScheduleEvents(currentScheduleItems, subjectsInput);
      updateRegenerateVisibility();
      flashSaved();
      refreshHistoryList();
    } catch (e) {
      console.error(e);
      flashError('Schedule generated, but could not be saved — check your connection.');
    }
  }

  // Both buttons feed the currently-locked blocks in (never something to
  // ignore) — on a first run currentScheduleItems is empty so this is just a
  // plain generate; Generate clicked again later behaves the same as
  // Regenerate rather than risking a stale locked row nothing accounts for.
  function lockedBlocksFromCurrent() {
    return currentScheduleItems
      .filter((i) => i.type === 'study' && i.locked)
      .map((i) => ({ name: i.name, start: i.start, end: i.end, sourceSubjectId: i.sourceSubjectId }));
  }

  document.getElementById('generateBtn').addEventListener('click', () => runGeneration(lockedBlocksFromCurrent()));
  regenerateBtn.addEventListener('click', () => runGeneration(lockedBlocksFromCurrent()));

  // ---------------- history ----------------
  const historyListEl = document.getElementById('historyList');

  function renderHistoryList(history, activeDate) {
    if (!history || history.length === 0) {
      historyListEl.innerHTML = '<div class="placeholder">No saved dates yet.</div>';
      return;
    }
    historyListEl.innerHTML = history
      .map((h) => {
        const dateLabel = formatDateLabel(h.forDate);
        const bits = [`${h.classCount} class${h.classCount === 1 ? '' : 'es'}`, `${h.subjectCount} subject${h.subjectCount === 1 ? '' : 's'}`];
        if (h.studyBlockCount > 0) bits.push(`${h.completionPercent}% complete`);
        return `
          <div class="history-item${h.forDate === activeDate ? ' active' : ''}" data-date="${h.forDate}" tabindex="0" role="button">
            <div class="history-main">
              <span class="history-date">${escapeAttr(dateLabel)}</span>
              <span class="history-stats">${escapeAttr(bits.join(' · '))}</span>
            </div>
            <span class="history-arrow" aria-hidden="true">→</span>
          </div>
        `;
      })
      .join('');
  }

  async function refreshHistoryList() {
    try {
      const history = await listScheduleHistory(userId);
      // only dates the user actually put something into — an empty row from
      // just browsing through with Prev/Next isn't a "saved schedule" worth listing
      const visible = history.filter((h) => h.classCount > 0 || h.subjectCount > 0 || h.studyBlockCount > 0);
      renderHistoryList(visible, schedule ? schedule.for_date : null);
    } catch (e) {
      console.error('Could not load history:', e);
    }
  }

  historyListEl.addEventListener('click', (e) => {
    const item = e.target.closest('.history-item');
    if (!item) return;
    loadScheduleForDate(item.dataset.date);
  });
  // keyboard access for the same rows (they're focusable divs with role="button")
  historyListEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const item = e.target.closest('.history-item');
    if (!item) return;
    e.preventDefault();
    loadScheduleForDate(item.dataset.date);
  });

  // ---------------- copy to another day ----------------
  const copySourceDateLabel = document.getElementById('copySourceDateLabel');
  const copyDestDateEl = document.getElementById('copyDestDate');
  const copyStatusEl = document.getElementById('copyStatus');

  document.getElementById('copyConfirmBtn').addEventListener('click', async () => {
    const destDate = copyDestDateEl.value;
    copyStatusEl.textContent = '';

    const validationError = validateCopyDestination(schedule.for_date, destDate);
    if (validationError) {
      copyStatusEl.textContent = validationError;
      return;
    }

    const sourceScheduleId = schedule.id;
    const sourceDateLabel = formatDateLabel(schedule.for_date);
    const destLabel = formatDateLabel(destDate);

    try {
      const existingDest = await getScheduleForDateIfExists(userId, destDate);
      if (existingDest) {
        const hasData = await scheduleHasPlanningData(existingDest.id);
        if (hasData) {
          const proceed = window.confirm(
            `${destLabel} already has planning data. Copying will replace its classes, study subjects, meals, and preferences. Continue?`
          );
          if (!proceed) {
            copyStatusEl.textContent = 'Copy canceled.';
            return;
          }
        }
      }

      await copyScheduleToDate(userId, sourceScheduleId, destDate);
      refreshHistoryList();

      const openIt = window.confirm(`Copied successfully. Open ${destLabel}?`);
      if (openIt) {
        copyDestDateEl.value = '';
        loadScheduleForDate(destDate);
      } else {
        copyStatusEl.textContent = `Copied ${sourceDateLabel} to ${destLabel}.`;
      }
    } catch (e) {
      console.error(e);
      copyStatusEl.textContent = 'Could not copy — check your connection.';
    }
  });

  // ---------------- loading a date (initial load, Prev/Next, date picker, history) ----------------
  async function loadScheduleForDate(dateStr) {
    const token = ++activeToken;

    // clear everything immediately so nothing from the previous date lingers
    // on screen (or could be mistaken for the new date's data) while loading
    classList.innerHTML = '';
    studyList.innerHTML = '';
    currentScheduleItems = [];
    editingItemId = null;
    output.innerHTML = '<div class="placeholder">Loading…</div>';
    renderNotes([]);
    renderLockConflicts(null);
    renderDailySummary(null);
    renderShortfallWarning(null);
    regenerateBtn.hidden = true;
    loadError.textContent = '';
    copyStatusEl.textContent = '';

    let loaded;
    try {
      loaded = await getOrCreateScheduleForDate(userId, dateStr);
    } catch (e) {
      console.error(e);
      if (token === activeToken) loadError.textContent = 'Could not load that date. Please try again.';
      return;
    }
    if (token !== activeToken) return; // a newer navigation started before this finished

    schedule = loaded;
    forDateEl.value = schedule.for_date;
    copySourceDateLabel.textContent = formatDateLabel(schedule.for_date);
    wakeTimeEl.value = toHHMM(schedule.wake_time);
    sleepTimeEl.value = toHHMM(schedule.sleep_time);
    meal.breakfast.on.checked = schedule.breakfast_on;
    meal.breakfast.time.value = toHHMM(schedule.breakfast_time);
    meal.lunch.on.checked = schedule.lunch_on;
    meal.lunch.time.value = toHHMM(schedule.lunch_time);
    meal.dinner.on.checked = schedule.dinner_on;
    meal.dinner.time.value = toHHMM(schedule.dinner_time);
    preferredPeriodEl.value = schedule.preferred_study_period || 'none';
    sessionCapEl.value = schedule.session_cap_minutes;
    breakMinutesEl.value = schedule.switch_break_minutes;
    minBlockEl.value = schedule.min_block_minutes;
    earliestStudyEl.value = toHHMM(schedule.earliest_study_time);
    latestStudyEl.value = toHHMM(schedule.latest_study_time);
    updateDayLengthHint();

    try {
      const [loadedClasses, loadedSubjects] = await Promise.all([listClasses(schedule.id), listStudySubjects(schedule.id)]);
      if (token !== activeToken) return;
      loadedClasses.forEach((c) => addClassRow(c));
      loadedSubjects.forEach((s) => addStudyRow(s));
    } catch (e) {
      console.error(e);
    }

    try {
      const savedItems = await listScheduleItems(schedule.id);
      if (token !== activeToken) return;
      if (savedItems.length > 0) {
        currentScheduleItems = savedItems
          .map((i) => ({
            id: i.id,
            type: i.item_type,
            name: i.name,
            start: i.start_minutes,
            end: i.end_minutes,
            locked: i.locked,
            completed: i.completed,
            sourceSubjectId: i.source_subject_id,
          }))
          .sort((a, b) => a.start - b.start);
        renderScheduleEvents(currentScheduleItems, buildSubjectsInput());
      } else {
        renderScheduleEvents([]);
      }
      updateRegenerateVisibility();
      renderDailySummaryFromCurrent();
    } catch (e) {
      console.error('Could not load saved schedule:', e);
    }

    refreshHistoryList();
  }

  let initialDate;
  try {
    initialDate = await getMostRecentScheduleDate(userId);
  } catch (e) {
    console.error(e);
  }
  if (!initialDate) initialDate = tomorrowDateStr();

  await loadScheduleForDate(initialDate);

  plannerForm.style.display = '';
}
