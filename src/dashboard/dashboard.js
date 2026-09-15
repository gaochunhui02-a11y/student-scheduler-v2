import { supabase } from '../lib/supabaseClient.js';
import { requireAuth } from '../shared/session.js';
import {
  getOrCreateCurrentSchedule,
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
  replaceScheduleItems,
} from './data.js';
import { generateSchedule, formatClock, timeToMinutes, minutesToClock } from './scheduler.js';

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

  let schedule;
  try {
    schedule = await getOrCreateCurrentSchedule(userId);
  } catch (e) {
    console.error(e);
    loadError.textContent = 'Could not load your saved data. Please refresh the page to try again.';
    return;
  }

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

  // ---------------- day settings ----------------
  const forDateEl = document.getElementById('forDate');
  const wakeTimeEl = document.getElementById('wakeTime');
  const sleepTimeEl = document.getElementById('sleepTime');
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

  forDateEl.value = schedule.for_date;
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
  updateDayLengthHint();

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
    chainSave(scheduleSaveTarget, async () => {
      schedule = await updateSchedule(schedule.id, {
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
      flashSaved();
    });
  }
  daySettingsForm.addEventListener('change', saveScheduleSettings);
  studyPrefsForm.addEventListener('change', saveScheduleSettings);

  // ---------------- classes ----------------
  const classList = document.getElementById('classList');

  function addClassRow(row = {}) {
    const el = document.createElement('div');
    el.className = 'entry-row';
    if (row.id) el.dataset.id = row.id;
    el.innerHTML = `
      <div class="field">
        <label>Subject</label>
        <input type="text" class="class-name" placeholder="e.g. Math" value="${escapeAttr(row.name || '')}">
      </div>
      <div class="field">
        <label>Start</label>
        <input type="time" class="class-start" value="${toHHMM(row.start_time)}">
      </div>
      <div class="field">
        <label>End</label>
        <input type="time" class="class-end" value="${toHHMM(row.end_time)}">
      </div>
      <button class="remove-btn" type="button" title="Remove">✕</button>
    `;
    el.querySelector('.remove-btn').addEventListener('click', () => {
      el.remove();
      chainSave(el, async () => {
        if (el.dataset.id) await deleteClass(el.dataset.id);
      });
    });
    classList.appendChild(el);
    return el;
  }

  classList.addEventListener('change', (e) => {
    const row = e.target.closest('.entry-row');
    if (!row) return;
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
        const created = await insertClass(schedule.id, userId, fields, sortOrder);
        row.dataset.id = created.id;
      }
      flashSaved();
    });
  });

  document.getElementById('addClassBtn').addEventListener('click', () => addClassRow());

  const existingClasses = await listClasses(schedule.id).catch((e) => {
    console.error(e);
    return [];
  });
  existingClasses.forEach((c) => addClassRow(c));

  // ---------------- study subjects ----------------
  const studyList = document.getElementById('studyList');

  function addStudyRow(row = {}) {
    const el = document.createElement('div');
    el.className = 'entry-row study';
    if (row.id) el.dataset.id = row.id;
    const priority = row.priority || 'medium';
    el.innerHTML = `
      <div class="field">
        <label>Subject</label>
        <input type="text" class="study-name" placeholder="e.g. Biology" value="${escapeAttr(row.name || '')}">
      </div>
      <div class="field">
        <label>Minutes</label>
        <input type="number" class="study-minutes" min="5" step="5" value="${row.minutes_requested || ''}">
      </div>
      <div class="field">
        <label>Priority</label>
        <select class="study-priority">
          <option value="low" ${priority === 'low' ? 'selected' : ''}>Low</option>
          <option value="medium" ${priority === 'medium' ? 'selected' : ''}>Medium</option>
          <option value="high" ${priority === 'high' ? 'selected' : ''}>High</option>
        </select>
      </div>
      <div class="field">
        <label>Due date</label>
        <input type="date" class="study-due" value="${row.due_date || ''}">
      </div>
      <div class="field wide">
        <label>Notes (optional)</label>
        <input type="text" class="study-notes" placeholder="optional" value="${escapeAttr(row.notes || '')}">
      </div>
      <button class="remove-btn" type="button" title="Remove">✕</button>
    `;
    el.querySelector('.remove-btn').addEventListener('click', () => {
      el.remove();
      chainSave(el, async () => {
        if (el.dataset.id) await deleteStudySubject(el.dataset.id);
      });
    });
    studyList.appendChild(el);
    return el;
  }

  studyList.addEventListener('change', (e) => {
    const row = e.target.closest('.entry-row');
    if (!row) return;
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
        const created = await insertStudySubject(schedule.id, userId, fields, sortOrder);
        row.dataset.id = created.id;
      }
      flashSaved();
    });
  });

  document.getElementById('addStudyBtn').addEventListener('click', () => addStudyRow());

  const existingSubjects = await listStudySubjects(schedule.id).catch((e) => {
    console.error(e);
    return [];
  });
  existingSubjects.forEach((s) => addStudyRow(s));

  // ---------------- generate + render the schedule ----------------
  const output = document.getElementById('output');
  const notesEl = document.getElementById('notes');

  function renderScheduleEvents(events) {
    if (!events || events.length === 0) {
      output.innerHTML = '<div class="placeholder">Nothing to show yet.</div>';
      return;
    }
    const html = events
      .map((e) => {
        const dur = e.end - e.start;
        const durText = dur >= 60 ? `${Math.floor(dur / 60)}h ${dur % 60 ? (dur % 60) + 'm' : ''}`.trim() : `${dur} min`;
        return `
          <div class="block ${e.type}">
            <div class="time">${formatClock(e.start)} – ${formatClock(e.end)}</div>
            <div class="info">${escapeAttr(e.name)} <span class="dur">(${durText})</span></div>
          </div>
        `;
      })
      .join('');
    output.innerHTML = `<div class="timeline">${html}</div>`;
  }

  function renderNotes(notes) {
    notesEl.innerHTML = (notes || []).map((n) => `<div class="note">${escapeAttr(n)}</div>`).join('');
  }

  function showScheduleError(msg) {
    output.innerHTML = `<div class="error">${escapeAttr(msg)}</div>`;
    notesEl.innerHTML = '';
  }

  document.getElementById('generateBtn').addEventListener('click', async () => {
    const classesInput = Array.from(classList.children).map((row) => ({
      name: row.querySelector('.class-name').value.trim(),
      start: row.querySelector('.class-start').value,
      end: row.querySelector('.class-end').value,
    }));

    const subjectsInput = Array.from(studyList.children).map((row) => ({
      name: row.querySelector('.study-name').value.trim(),
      minutes: parseInt(row.querySelector('.study-minutes').value, 10),
    }));

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
      },
    });

    if (result.error) {
      showScheduleError(result.error);
      return;
    }

    renderScheduleEvents(result.events);
    renderNotes(result.notes);

    try {
      await replaceScheduleItems(schedule.id, userId, result.events);
      flashSaved();
    } catch (e) {
      console.error(e);
      flashError('Schedule generated, but could not be saved — check your connection.');
    }
  });

  // show the most recently generated schedule, if one exists, instead of the empty placeholder
  try {
    const savedItems = await listScheduleItems(schedule.id);
    if (savedItems.length > 0) {
      renderScheduleEvents(
        savedItems.map((i) => ({ type: i.item_type, name: i.name, start: i.start_minutes, end: i.end_minutes }))
      );
    }
  } catch (e) {
    console.error('Could not load saved schedule:', e);
  }

  plannerForm.style.display = '';
}
