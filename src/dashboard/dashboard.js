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
  listSchedulesInRange,
  listScheduleItemsForScheduleIds,
  listStudySubjectsForScheduleIds,
  listUpcomingStudySubjects,
  setScheduleItemMissed,
  setScheduleItemPartialCompletion,
  getStudySubjectById,
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
import { buildMultiDayPreview, recomputeMultiDaySegments, acceptMultiDayPlan, buildCarryOverPreview, recomputeCarryOverSegments, acceptCarryOver } from './multiDayPlan.js';
import { computeRemainingMinutes, isFullyCompletedByMinutes, validateCompletedMinutesInput, canCarryOverBlock, canMarkMissed } from './carryOverModel.js';
import { computeDailySummary, computeSubjectProgress, formatDuration } from './summary.js';
import { validateCopyDestination } from './copySchedule.js';
import { buildSmartTasks, computeAvailableStudyMinutes, sortTasksForDisplay } from './smartPriority.js';
import { QUICK_TEMPLATES, getQuickTemplate, buildTemplatePreview, buildTemplatePrefsPatch } from './quickTemplates.js';
import { t, applyTranslations, getLanguage, getLocale, setLanguage } from '../shared/i18n.js';
import { initBoardSection } from '../board/board.js';
import { listBoards } from '../board/boardData.js';
import { initAnalyticsSection } from '../analytics/analytics.js';
import { initNotificationsSection } from '../notifications/notifications.js';
import { registerServiceWorker, initInstallPrompt, initOfflineIndicator } from '../shared/pwa.js';
import { initCalendarSection } from '../calendar/calendar.js';

// ---------------- PWA (Phase 11, applied immediately, before auth) ----------------
// Registering the service worker and watching online/offline doesn't need
// a session — same "before auth" timing as theme/language above. Nothing
// here touches Supabase or AI requests; see public/sw.js's fetch handler.
registerServiceWorker();

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

// ---------------- language (applied immediately, before auth, to avoid a flash) ----------------
// Purely presentational — sets textContent on [data-i18n] static labels only.
// Never touches user-created content, dynamic JS-rendered strings, ids, or classes.
applyTranslations();

// ---------------- offline indicator + install prompt (Phase 11) ----------------
// Also purely presentational, also doesn't need a session — an offline
// banner and an "Install App" button are useful even before login finishes.
const offlineBannerEl = document.getElementById('offlineBanner');
const offlineBannerTextEl = offlineBannerEl ? offlineBannerEl.querySelector('span') : null;
let backOnlineTimeout = null;
initOfflineIndicator({
  onOffline: () => {
    clearTimeout(backOnlineTimeout);
    if (offlineBannerEl) {
      offlineBannerEl.classList.remove('offline-banner-online');
      offlineBannerEl.hidden = false;
    }
    if (offlineBannerTextEl) {
      offlineBannerTextEl.dataset.i18n = 'notifications.offline';
      offlineBannerTextEl.textContent = t('notifications.offline');
    }
  },
  onOnline: () => {
    // Only flash "Back Online" if the banner was actually showing "Offline"
    // — this callback also fires once on page load, when there was never
    // anything to announce.
    if (!offlineBannerEl || offlineBannerEl.hidden) return;
    offlineBannerEl.classList.add('offline-banner-online');
    if (offlineBannerTextEl) {
      offlineBannerTextEl.dataset.i18n = 'notifications.backOnline';
      offlineBannerTextEl.textContent = t('notifications.backOnline');
    }
    backOnlineTimeout = setTimeout(() => {
      offlineBannerEl.hidden = true;
    }, 3000);
  },
});

const installAppBtn = document.getElementById('installAppBtn');
// Checkpoint F: the Settings page's own "Install App" row mirrors the same
// availability toggle as the sidebar's compact icon button — same
// installPrompt, same event, just a second place it's shown.
const settingsInstallAppBtn = document.getElementById('settingsInstallAppBtn');
const installPrompt = initInstallPrompt({
  onAvailable: () => {
    if (installAppBtn) installAppBtn.hidden = false;
    if (settingsInstallAppBtn) settingsInstallAppBtn.hidden = false;
  },
  onInstalled: () => {
    if (installAppBtn) installAppBtn.hidden = true;
    if (settingsInstallAppBtn) settingsInstallAppBtn.hidden = true;
    // Briefly reuse the same banner for a one-off confirmation — it's a
    // generic small status line, not exclusively about connectivity.
    if (offlineBannerEl) {
      clearTimeout(backOnlineTimeout);
      offlineBannerEl.classList.add('offline-banner-online');
      offlineBannerEl.hidden = false;
      if (offlineBannerTextEl) {
        offlineBannerTextEl.dataset.i18n = 'notifications.appInstalled';
        offlineBannerTextEl.textContent = t('notifications.appInstalled');
      }
      backOnlineTimeout = setTimeout(() => {
        offlineBannerEl.hidden = true;
      }, 3000);
    }
  },
});
if (installAppBtn) {
  installAppBtn.addEventListener('click', async () => {
    await installPrompt.prompt();
  });
}
if (settingsInstallAppBtn) {
  settingsInstallAppBtn.addEventListener('click', async () => {
    await installPrompt.prompt();
  });
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
    if (themeToggleLabel) themeToggleLabel.textContent = currentEffectiveTheme() === 'dark' ? t('theme.light') : t('theme.dark');
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

  // ---------------- language selector ----------------
  // Purely presentational — re-applies [data-i18n] static text app-wide and
  // refreshes the one dynamically-set translated label (theme toggle).
  // Does not touch scheduling, Supabase, or any other rendered content.
  const langSelect = document.getElementById('langSelect');
  if (langSelect) {
    langSelect.value = getLanguage();
    langSelect.addEventListener('change', () => {
      setLanguage(langSelect.value);
      applyTranslations();
      refreshThemeToggleLabel();
      // Home's greeting/labels are rendered via t(), not [data-i18n] alone
      // (the greeting also splices in the display name) — re-run its
      // render pass so a language switch updates it immediately too.
      if (analyticsSection && typeof analyticsSection.onShow === 'function') analyticsSection.onShow();
    });
  }

  // ---------------- alternate views (Board, Dashboard) ----------------
  // Board and the analytics Dashboard are full alternate views, not
  // anchors within the planner's continuous scroll — so "Planner"/
  // "History"/etc. and "Board"/"Dashboard" use two different nav-click
  // patterns that coexist: data-scroll-target (existing, untouched below)
  // smooth-scrolls within the always-mounted planner layout, while
  // data-view-target swaps which top-level section is visible. All Board
  // DOM/state lives in src/board/board.js, all Dashboard/analytics
  // DOM/state lives in src/analytics/analytics.js — this file only owns
  // the show/hide toggle between #plannerForm and whichever alternate view
  // is active.
  const altViewEls = [document.getElementById('boardView'), document.getElementById('analyticsView'), document.getElementById('settingsView')].filter(Boolean);
  function showPlannerView() {
    altViewEls.forEach((el) => {
      el.hidden = true;
    });
    plannerForm.style.display = '';
  }
  function showAltView(viewEl) {
    plannerForm.style.display = 'none';
    altViewEls.forEach((el) => {
      el.hidden = el !== viewEl;
    });
  }

  // Shared by Board's/Analytics' "go to Planner" bridges — switches back to
  // the planner view, marks the Planner nav item active, and scrolls to
  // the study-tasks card. One implementation, several callers, same as
  // every other cross-feature bridge in this file.
  //
  // Checkpoint E: an optional `taskId` additionally makes this the "Plan it"
  // action on Home's Recommended Next — since a recommendation is always
  // built from TODAY's study_subjects (see analyticsHostApi.getTodaySchedule
  // below), this loads today's date first if the Planner isn't already
  // showing it (reusing the exact existing loadScheduleForDate — no second
  // schedule fetch/render path), then scrolls to and briefly highlights
  // that specific row via the existing findStudyRow lookup. Never schedules
  // or edits anything itself.
  async function goToPlannerStudyList(taskId) {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    const plannerNavBtn = document.querySelector('.nav-item[data-scroll-target="plannerForm"]');
    if (plannerNavBtn) plannerNavBtn.classList.add('active');
    showPlannerView();

    if (taskId && forDateEl.value !== todayDateStr()) {
      await loadScheduleForDate(todayDateStr());
    }

    const targetRow = taskId ? findStudyRow(taskId) : null;
    if (targetRow) {
      targetRow.scrollIntoView({ behavior: 'smooth', block: 'start' });
      targetRow.classList.add('study-row-highlight');
      setTimeout(() => targetRow.classList.remove('study-row-highlight'), 1800);
      return;
    }
    if (studyList) studyList.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------------- Board -> existing study-task system (Phase 5) ----------------
  // board.js never imports data.js or touches the study_subjects table
  // itself — it only calls these host functions, which route through the
  // EXACT same insertStudySubject + addStudyRow code path a manually typed
  // study-task row already uses below. This is the only bridge between the
  // Board and the scheduler's data; nothing else about study-task
  // creation, the scheduler, or Generate/Regenerate changes.
  // addStudyRow/insertStudySubject/refreshHistoryList/schedule are declared
  // further down this function, but that's fine here: these closures are
  // only ever invoked later, after a user opens the Board's conversion
  // modal — well after every one of them has been assigned.
  const boardHostApi = {
    getActiveScheduleId: () => (schedule ? schedule.id : null),
    createStudyTaskFromBoard: async (fields) => {
      if (!schedule) throw new Error('No active schedule to attach the study task to.');
      const sortOrder = studyList.children.length;
      const created = await insertStudySubject(schedule.id, userId, fields, sortOrder);
      addStudyRow(created);
      refreshHistoryList();
      return created;
    },
    viewInPlanner: goToPlannerStudyList,
  };
  const boardSection = initBoardSection(userId, boardHostApi);

  // ---------------- Dashboard/Analytics -> existing Planner + Board (Phase 10) ----------------
  // analytics.js never imports data.js/boardData.js directly — it only
  // calls these host functions. Every number it shows is derived read-only
  // from the exact same tables (schedules/schedule_items/study_subjects/
  // boards) every other feature already reads; nothing here writes
  // anything.
  const analyticsHostApi = {
    getTodayDateStr: () => addDaysToDateStr(tomorrowDateStr(), -1),
    getDisplayName: () => displayName,
    getWeekData: async (startDate, endDate) => {
      const schedulesInRange = await listSchedulesInRange(userId, startDate, endDate);
      const scheduleIds = schedulesInRange.map((s) => s.id);
      const [items, subjects] = await Promise.all([listScheduleItemsForScheduleIds(scheduleIds), listStudySubjectsForScheduleIds(scheduleIds)]);
      return { schedules: schedulesInRange, items, subjects };
    },
    getUpcomingDeadlines: (fromDate) => listUpcomingStudySubjects(userId, fromDate),
    getBoardsSummary: () => listBoards(userId),
    // Today's real generated schedule (whichever date is actually "today"),
    // independent of whatever date the Planner itself currently has loaded
    // — reuses the exact same getScheduleForDateIfExists/listScheduleItems/
    // listStudySubjects data.js already exposes, never a new query shape.
    // Null when today has no schedule row yet (a brand-new account, or a
    // date never visited). `subjects` (Checkpoint E) is what Home's
    // Recommended Next scores via smartPriority.js's buildSmartTasks.
    getTodaySchedule: async () => {
      const todayStr = addDaysToDateStr(tomorrowDateStr(), -1);
      const todaySchedule = await getScheduleForDateIfExists(userId, todayStr);
      if (!todaySchedule) return null;
      const [items, subjects] = await Promise.all([listScheduleItems(todaySchedule.id), listStudySubjects(todaySchedule.id)]);
      return { schedule: todaySchedule, items, subjects };
    },
    viewInPlanner: goToPlannerStudyList,
    // Checkpoint E: "Plan it" on a Home recommendation — the exact same
    // bridge as viewInPlanner, just also given the specific task's id so it
    // can be scrolled to and highlighted (see goToPlannerStudyList above).
    planTask: goToPlannerStudyList,
  };
  const analyticsSection = initAnalyticsSection(userId, analyticsHostApi);

  // ---------------- Notifications -> existing schedule + due dates (Phase 11) ----------------
  // notifications.js never imports data.js directly — it only calls these
  // host functions. Study reminders read currentScheduleItems (already in
  // memory below, no extra fetch); deadline reminders reuse the exact same
  // listUpcomingStudySubjects the Phase 10 Dashboard already uses. Nothing
  // here changes the schedule or the scheduling algorithm — reminders are
  // read-only.
  const notificationsHostApi = {
    getTodayDateStr: () => addDaysToDateStr(tomorrowDateStr(), -1),
    getCurrentScheduleDate: () => (schedule ? schedule.for_date : null),
    getScheduleItemsForReminders: () => currentScheduleItems,
    getUpcomingSubjectsForReminders: () => listUpcomingStudySubjects(userId, addDaysToDateStr(tomorrowDateStr(), -1)),
  };
  initNotificationsSection(userId, notificationsHostApi);

  // ---------------- Calendar import/export -> existing schedule/classes (Phase 12) ----------------
  // calendar.js never imports data.js directly — it only calls these host
  // functions. Export reads schedule_items read-only (today's own
  // in-memory currentScheduleItems, or the exact same
  // listSchedulesInRange/listScheduleItemsForScheduleIds the Phase 10
  // Dashboard already uses for a date range). Import writes ONLY through
  // the EXISTING getOrCreateScheduleForDate + insertClass — imported
  // events become ordinary classes rows, not a second fixed-event system,
  // and go through the same functions any manually-typed class already
  // uses. The scheduling algorithm itself is never touched; imported
  // classes simply become part of what it already treats as a fixed
  // commitment on that date, exactly like any other class.
  const calendarHostApi = {
    getTodayExportData: () => ({
      dateStr: schedule ? schedule.for_date : addDaysToDateStr(tomorrowDateStr(), -1),
      items: currentScheduleItems.map((i) => ({ id: i.id, item_type: i.type, name: i.name, start_minutes: i.start, end_minutes: i.end })),
    }),
    getRangeExportData: async (startDate, endDate) => {
      const schedulesInRange = await listSchedulesInRange(userId, startDate, endDate);
      const scheduleIds = schedulesInRange.map((s) => s.id);
      const items = await listScheduleItemsForScheduleIds(scheduleIds);
      return schedulesInRange.map((s) => ({
        dateStr: s.for_date,
        items: items.filter((i) => i.schedule_id === s.id),
      }));
    },
    importClassesForDates: async (dateStr, fieldsList) => {
      const targetSchedule = await getOrCreateScheduleForDate(userId, dateStr);
      const isCurrentlyLoaded = Boolean(schedule) && schedule.id === targetSchedule.id;
      const baseSortOrder = isCurrentlyLoaded ? classList.children.length : 0;
      for (let i = 0; i < fieldsList.length; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const created = await insertClass(targetSchedule.id, userId, fieldsList[i], baseSortOrder + i);
        if (isCurrentlyLoaded) addClassRow(created);
      }
      refreshHistoryList();
    },
  };
  initCalendarSection(userId, calendarHostApi);

  // Extracted to plain functions (not just inline listeners) so Quick
  // Actions on the new Home page can trigger the EXACT same navigation —
  // including, for a view-target, actually awaiting the section's onShow()
  // before doing anything that depends on its DOM being ready — rather than
  // a second copy of this logic.
  function activatePlannerScroll(targetId) {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    const navBtn = document.querySelector(`.nav-item[data-scroll-target="${targetId}"]`);
    if (navBtn) navBtn.classList.add('active');
    showPlannerView();
    const target = document.getElementById(targetId);
    if (target) {
      // Checkpoint C: History/Preferences/Calendar can now live inside a
      // collapsed <details> — open whichever one contains the jump target
      // before scrolling, or the nav link would land on a hidden section.
      const collapsible = target.closest('details');
      if (collapsible && !collapsible.open) collapsible.open = true;
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
  document.querySelectorAll('.nav-item[data-scroll-target]').forEach((btn) => {
    btn.addEventListener('click', () => activatePlannerScroll(btn.dataset.scrollTarget));
  });

  // ---------------- Settings (Checkpoint F) ----------------
  // Every control here reuses EXISTING state/functions — theme
  // (applyTheme/currentEffectiveTheme/THEME_STORAGE_KEY, module-level
  // above, same as the sidebar's compact toggle), language (dispatches a
  // real 'change' on the existing #langSelect, so it's the exact same code
  // path, not a second one), and the Study Preferences/Calendar shortcuts
  // reuse activatePlannerScroll exactly like the sidebar's old "Settings"
  // nav item used to before it pointed here. No new persisted state.
  const settingsThemeButtons = {
    light: document.getElementById('settingsThemeLight'),
    dark: document.getElementById('settingsThemeDark'),
    system: document.getElementById('settingsThemeSystem'),
  };
  function currentThemeChoice() {
    let stored = null;
    try {
      stored = localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      // per-viewer convenience only — fine if it can't read
    }
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  }
  function syncSettingsThemeButtons() {
    const choice = currentThemeChoice();
    Object.entries(settingsThemeButtons).forEach(([key, btn]) => {
      if (btn) btn.classList.toggle('active', key === choice);
    });
  }
  Object.entries(settingsThemeButtons).forEach(([key, btn]) => {
    if (!btn) return;
    btn.addEventListener('click', () => {
      const next = key === 'system' ? null : key; // null clears the override — applyTheme then falls back to the OS preference
      applyTheme(next);
      try {
        if (next) localStorage.setItem(THEME_STORAGE_KEY, next);
        else localStorage.removeItem(THEME_STORAGE_KEY);
      } catch {
        // per-viewer convenience only — fine if it can't persist
      }
      refreshThemeToggleLabel();
      syncSettingsThemeButtons();
    });
  });

  const settingsLangSelect = document.getElementById('settingsLangSelect');
  if (settingsLangSelect) {
    settingsLangSelect.addEventListener('change', () => {
      if (langSelect) {
        // Reuses the sidebar select's own 'change' handler verbatim.
        langSelect.value = settingsLangSelect.value;
        langSelect.dispatchEvent(new Event('change'));
      }
    });
  }

  const settingsAccountNameEl = document.getElementById('settingsAccountName');
  if (settingsAccountNameEl) settingsAccountNameEl.textContent = displayName;

  function syncSettingsControls() {
    syncSettingsThemeButtons();
    if (settingsLangSelect) settingsLangSelect.value = getLanguage();
  }
  syncSettingsControls();

  function jumpFromSettingsToPlanner(targetId) {
    activatePlannerScroll(targetId);
    const plannerNavBtn = document.querySelector('.nav-item[data-scroll-target="plannerForm"]');
    if (plannerNavBtn) plannerNavBtn.classList.add('active');
  }
  const settingsOpenStudyPrefsBtn = document.getElementById('settingsOpenStudyPrefsBtn');
  if (settingsOpenStudyPrefsBtn) {
    settingsOpenStudyPrefsBtn.addEventListener('click', () => jumpFromSettingsToPlanner('studyPrefsForm'));
  }
  const settingsOpenCalendarBtn = document.getElementById('settingsOpenCalendarBtn');
  if (settingsOpenCalendarBtn) {
    settingsOpenCalendarBtn.addEventListener('click', () => jumpFromSettingsToPlanner('calendarExportCard'));
  }

  const settingsSection = { onShow: () => syncSettingsControls() };

  const altViewSections = {
    boardView: boardSection,
    analyticsView: analyticsSection,
    settingsView: settingsSection,
  };
  async function activateView(key) {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    const navBtn = document.querySelector(`.nav-item[data-view-target="${key}"]`);
    if (navBtn) navBtn.classList.add('active');
    showAltView(document.getElementById(key));
    const section = altViewSections[key];
    if (section && typeof section.onShow === 'function') await section.onShow();
  }
  document.querySelectorAll('.nav-item[data-view-target]').forEach((btn) => {
    btn.addEventListener('click', () => activateView(btn.dataset.viewTarget));
  });

  // ---------------- mobile sidebar toggle (Checkpoint B) ----------------
  // Purely presentational: a narrow-viewport off-canvas drawer, CSS-driven
  // via the .sidebar-open class. Touches no existing nav wiring above —
  // every nav-item keeps working exactly as it already does; this only
  // additionally closes the drawer after a selection on narrow screens.
  const sidebarToggleBtn = document.getElementById('sidebarToggleBtn');
  const sidebarScrim = document.getElementById('sidebarScrim');
  const sidebarEl = document.querySelector('.sidebar');
  function closeSidebar() {
    if (sidebarEl) sidebarEl.classList.remove('sidebar-open');
    if (sidebarScrim) sidebarScrim.hidden = true;
  }
  if (sidebarToggleBtn) {
    sidebarToggleBtn.addEventListener('click', () => {
      const isOpen = sidebarEl && sidebarEl.classList.contains('sidebar-open');
      if (isOpen) {
        closeSidebar();
      } else {
        if (sidebarEl) sidebarEl.classList.add('sidebar-open');
        if (sidebarScrim) sidebarScrim.hidden = false;
      }
    });
  }
  if (sidebarScrim) sidebarScrim.addEventListener('click', closeSidebar);
  document.querySelectorAll('.nav-item').forEach((btn) => btn.addEventListener('click', closeSidebar));

  // ---------------- Home Quick Actions (Checkpoint B) ----------------
  // Every action reuses an EXISTING control/handler — nothing here creates
  // a second "add study task"/"create board"/"import calendar" flow.
  const qaAddTaskBtn = document.getElementById('homeQaAddTask');
  if (qaAddTaskBtn) {
    qaAddTaskBtn.addEventListener('click', () => {
      activatePlannerScroll('plannerForm');
      document.getElementById('addStudyBtn').click(); // exact same handler a manual click already uses
      studyList.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  const qaOpenPlannerBtn = document.getElementById('homeQaOpenPlanner');
  if (qaOpenPlannerBtn) qaOpenPlannerBtn.addEventListener('click', () => activatePlannerScroll('plannerForm'));

  const qaNewBoardBtn = document.getElementById('homeQaNewBoard');
  if (qaNewBoardBtn) {
    qaNewBoardBtn.addEventListener('click', async () => {
      await activateView('boardView');
      // Whichever "create a board" trigger is currently visible — a
      // brand-new account shows boardCreateBtn (no-board empty state), an
      // existing account shows boardNewBtn (toolbar) — both already call
      // the Board's own real createNewBoard() flow; nothing new here.
      const newBtn = document.getElementById('boardNewBtn');
      const createBtn = document.getElementById('boardCreateBtn');
      const target = newBtn && newBtn.offsetParent ? newBtn : createBtn;
      if (target) target.click();
    });
  }
  const qaImportCalendarBtn = document.getElementById('homeQaImportCalendar');
  if (qaImportCalendarBtn) qaImportCalendarBtn.addEventListener('click', () => activatePlannerScroll('calendarImportCard'));

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
    saveStatus.classList.remove('hint-error');
    clearTimeout(flashSaved._t);
    flashSaved._t = setTimeout(() => { saveStatus.textContent = ''; }, 1200);
  }
  function flashError(msg) {
    saveStatus.textContent = msg;
    saveStatus.classList.add('hint-error');
  }

  // serializes saves per row so a fast second edit never races ahead of the
  // insert that assigns the row its database id (which would create a duplicate)
  function chainSave(target, fn) {
    const prev = target._savePromise || Promise.resolve();
    const next = prev.then(fn).catch((e) => {
      console.error(e);
      flashError(t('errors.couldNotSave'));
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
    return new Date(`${dateStr}T00:00:00`).toLocaleDateString(getLocale(), { month: 'short', day: 'numeric', year: 'numeric' });
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
  const todayBtn = document.getElementById('todayBtn');
  const todayDateStr = () => addDaysToDateStr(tomorrowDateStr(), -1);
  todayBtn.addEventListener('click', () => loadScheduleForDate(todayDateStr()));

  // Checkpoint C.1: toolbar "More ▾" menu — pure navigation shortcuts into
  // sections that already exist (Copy Day lives in "More tools", Multi-Day
  // Planning is the per-task "Plan Days" button on each Study Tasks row) —
  // no new logic, just a jump + auto-close.
  const plannerMoreMenu = document.querySelector('.planner-more-menu');
  document.getElementById('plannerJumpCopyDay').addEventListener('click', () => {
    plannerMoreMenu.open = false;
    activatePlannerScroll('copyToAnotherDayCard');
  });
  document.getElementById('plannerJumpMultiDay').addEventListener('click', () => {
    plannerMoreMenu.open = false;
    activatePlannerScroll('studyList');
  });
  // Any open <details>-based dropdown (the toolbar's More menu, or a study
  // block's ••• overflow menu) closes on an outside click — native <details>
  // has no such behavior on its own.
  document.addEventListener('click', (e) => {
    document.querySelectorAll('.planner-more-menu[open], .tl-overflow[open]').forEach((d) => {
      if (!d.contains(e.target)) d.open = false;
    });
  });

  // ---------------- Quick (Study) Planning Templates (Checkpoint E) ----------------
  // Deterministic presets for a few EXISTING Study Preferences fields (see
  // quickTemplates.js's allow-list) — applying one is exactly the same
  // updateSchedule(scheduleId, fields) call a manual preferences edit
  // already makes below in saveScheduleSettings/collectStudyPrefsFields.
  // Nothing here ever touches a study task's own priority/due date/minutes.
  const PREF_LABEL_KEYS = {
    preferred_study_period: 'prefs.preferredTime',
    session_cap_minutes: 'prefs.maxSession',
    switch_break_minutes: 'prefs.breakLength',
    min_block_minutes: 'prefs.minBlock',
    earliest_study_time: 'prefs.earliestTime',
    latest_study_time: 'prefs.latestTime',
  };
  const PERIOD_LABEL_KEYS = { none: 'prefs.periodNone', morning: 'prefs.periodMorning', afternoon: 'prefs.periodAfternoon', evening: 'prefs.periodEvening' };

  function currentSchedulePrefs() {
    return {
      preferred_study_period: preferredPeriodEl.value,
      session_cap_minutes: parseInt(sessionCapEl.value, 10) || null,
      switch_break_minutes: Number.isFinite(parseInt(breakMinutesEl.value, 10)) ? parseInt(breakMinutesEl.value, 10) : null,
      min_block_minutes: parseInt(minBlockEl.value, 10) || null,
      earliest_study_time: earliestStudyEl.value || null,
      latest_study_time: latestStudyEl.value || null,
    };
  }

  function formatPrefValue(field, value) {
    if (value === null || value === undefined || value === '') return t('quickTemplates.noPreferenceValue');
    if (field === 'preferred_study_period') return t(PERIOD_LABEL_KEYS[value] || PERIOD_LABEL_KEYS.none);
    if (field === 'earliest_study_time' || field === 'latest_study_time') return value;
    return `${value} ${t('quickTemplates.minutesSuffix')}`;
  }

  function renderTemplatePreviewText(template) {
    const preview = buildTemplatePreview(template, currentSchedulePrefs());
    if (preview.length === 0) return t('quickTemplates.noChanges');
    return preview.map((c) => `${t(PREF_LABEL_KEYS[c.field])}: ${formatPrefValue(c.field, c.from)} → ${formatPrefValue(c.field, c.to)}`).join('  ·  ');
  }

  let quickTemplatesModal = null;
  const quickTemplateCards = []; // { template, previewEl } — refreshed every time the modal opens

  function refreshQuickTemplatePreviews() {
    quickTemplateCards.forEach(({ template, previewEl }) => {
      previewEl.textContent = renderTemplatePreviewText(template);
    });
  }

  function closeQuickTemplatesModal() {
    if (quickTemplatesModal) quickTemplatesModal.overlay.hidden = true;
  }

  async function applyQuickTemplate(template, btn) {
    if (!schedule) return;
    const patch = buildTemplatePrefsPatch(template);
    btn.disabled = true;
    try {
      const updated = await updateSchedule(schedule.id, patch);
      schedule = updated;
      if ('preferred_study_period' in patch) preferredPeriodEl.value = patch.preferred_study_period;
      if ('session_cap_minutes' in patch) sessionCapEl.value = patch.session_cap_minutes;
      if ('switch_break_minutes' in patch) breakMinutesEl.value = patch.switch_break_minutes;
      if ('min_block_minutes' in patch) minBlockEl.value = patch.min_block_minutes;
      if ('earliest_study_time' in patch) earliestStudyEl.value = toHHMM(patch.earliest_study_time) || '';
      if ('latest_study_time' in patch) latestStudyEl.value = toHHMM(patch.latest_study_time) || '';
      updateDayLengthHint();
      closeQuickTemplatesModal();
      flashSaved();
    } catch (err) {
      console.error('Could not apply quick template:', err);
      flashError('Could not apply that template — check your connection.');
    } finally {
      btn.disabled = false;
    }
  }

  function buildQuickTemplatesModal() {
    const overlay = document.createElement('div');
    overlay.className = 'qt-modal-overlay';
    overlay.hidden = true;

    const modal = document.createElement('div');
    modal.className = 'qt-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const heading = document.createElement('h3');
    heading.className = 'qt-modal-title';
    heading.textContent = t('quickTemplates.modalTitle');

    const subtitle = document.createElement('p');
    subtitle.className = 'hint qt-modal-subtitle';
    subtitle.textContent = t('quickTemplates.modalSubtitle');

    const list = document.createElement('div');
    list.className = 'qt-list';

    QUICK_TEMPLATES.forEach((template) => {
      const card = document.createElement('div');
      card.className = 'qt-card';

      const nameEl = document.createElement('div');
      nameEl.className = 'qt-card-title';
      nameEl.textContent = t(template.nameKey);

      const descEl = document.createElement('p');
      descEl.className = 'hint qt-card-desc';
      descEl.textContent = t(template.descriptionKey);

      const focusList = document.createElement('ul');
      focusList.className = 'qt-card-focus';
      template.focusKeys.forEach((key) => {
        const li = document.createElement('li');
        li.textContent = t(key);
        focusList.appendChild(li);
      });

      const previewEl = document.createElement('p');
      previewEl.className = 'qt-card-preview';

      const applyBtn = document.createElement('button');
      applyBtn.type = 'button';
      applyBtn.className = 'btn-secondary qt-card-apply';
      applyBtn.textContent = t('quickTemplates.apply');
      applyBtn.addEventListener('click', () => applyQuickTemplate(template, applyBtn));

      card.appendChild(nameEl);
      card.appendChild(descEl);
      card.appendChild(focusList);
      card.appendChild(previewEl);
      card.appendChild(applyBtn);
      list.appendChild(card);

      quickTemplateCards.push({ template, previewEl });
    });

    const actions = document.createElement('div');
    actions.className = 'board-modal-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = t('board.cancel');
    cancelBtn.addEventListener('click', closeQuickTemplatesModal);
    actions.appendChild(cancelBtn);

    modal.appendChild(heading);
    modal.appendChild(subtitle);
    modal.appendChild(list);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeQuickTemplatesModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.hidden) closeQuickTemplatesModal();
    });

    return { overlay };
  }

  function openQuickTemplatesModal() {
    if (!quickTemplatesModal) quickTemplatesModal = buildQuickTemplatesModal();
    refreshQuickTemplatePreviews();
    quickTemplatesModal.overlay.hidden = false;
  }

  const plannerOpenTemplatesBtn = document.getElementById('plannerOpenTemplatesBtn');
  if (plannerOpenTemplatesBtn) {
    plannerOpenTemplatesBtn.addEventListener('click', () => {
      plannerMoreMenu.open = false;
      openQuickTemplatesModal();
    });
  }

  // Checkpoint C: human-readable heading in the new Planner header — purely
  // derived from `schedule.for_date` each time a date loads, never its own
  // stored value.
  const plannerDateHeading = document.getElementById('plannerDateHeading');
  const plannerDateSub = document.getElementById('plannerDateSub');
  function updatePlannerHeader() {
    if (!schedule) return;
    // Checkpoint C.1: format with the app's own selected language (getLocale()),
    // not the browser/OS locale — Intl handles weekday/month/day ordering
    // correctly per-locale on its own (e.g. zh-CN puts the weekday last).
    plannerDateHeading.textContent = new Date(`${schedule.for_date}T00:00:00`).toLocaleDateString(getLocale(), {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const classCount = classList.children.length;
    const studyCount = studyList.children.length;
    plannerDateSub.textContent = t('planner.dayIncludes')
      .replace('{classes}', classCount)
      .replace('{subjects}', studyCount);
  }

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
      updatePlannerHeader();
      chainSave(el, async () => {
        if (el.dataset.id) {
          await deleteClass(el.dataset.id);
          refreshHistoryList();
        }
      });
    });
    classList.appendChild(el);
    updatePlannerHeader();
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
    if (row.origin_subject_id) el.dataset.originId = row.origin_subject_id;
    const priority = row.priority || 'medium';
    const isChunk = Boolean(row.origin_subject_id);
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
        ${row.id && !isChunk ? `<button type="button" class="edit-btn plan-days-btn">${escapeAttr(t('multiday.planDaysButton'))}</button>` : ''}
      </div>
      ${isChunk ? `<p class="hint multiday-chunk-hint">${escapeAttr(t('multiday.chunkHint'))}</p>` : ''}
      <input type="text" class="study-notes" aria-label="Notes" placeholder="Notes (optional)" value="${escapeAttr(row.notes || '')}">
      <div class="multiday-panel-slot"></div>
    `;
    el.querySelector('.remove-btn').addEventListener('click', () => {
      if (planningRowId === el.dataset.id) closeMultiDayPanel();
      el.remove();
      updatePlannerHeader();
      chainSave(el, async () => {
        if (el.dataset.id) {
          await deleteStudySubject(el.dataset.id);
          refreshHistoryList();
        }
      });
    });
    studyList.appendChild(el);
    updatePlannerHeader();
    return el;
  }

  // ---------------- Smart Multi-Day Planning (Phase 13) ----------------
  // Decides how many of a study task's minutes belong on WHICH date; the
  // existing generateSchedule() above is untouched and still decides WHERE
  // a date's minutes fit inside that day once the user generates it. At
  // most one row's preview panel is open at a time — same single-panel
  // pattern as editingItemId for the schedule timeline above.
  let planningRowId = null;
  let planningPreview = null;
  let planningLoading = false;
  let planningError = '';

  function closeMultiDayPanel() {
    planningRowId = null;
    planningPreview = null;
    planningLoading = false;
    planningError = '';
  }

  function findStudyRow(id) {
    return Array.from(studyList.children).find((r) => r.dataset.id === id);
  }

  function readSubjectRowData(row) {
    return {
      id: row.dataset.id,
      origin_subject_id: row.dataset.originId || null,
      name: row.querySelector('.study-name').value.trim(),
      priority: row.querySelector('.study-priority').value,
      due_date: row.querySelector('.study-due').value || null,
      notes: row.querySelector('.study-notes').value.trim(),
      minutes_requested: parseInt(row.querySelector('.study-minutes').value, 10) || 0,
    };
  }

  // ---------------- Smart task sorting (Checkpoint E) ----------------
  // Presentation-only reordering of the Study Tasks DOM rows — never
  // touches sort_order or any other stored field, and moving an existing
  // row (appendChild on a node already in the document just relocates it)
  // never loses in-progress typing/focus the way rebuilding the list would.
  const taskSortSelect = document.getElementById('taskSortSelect');

  // A row that isn't complete enough to score (blank/new, or missing a
  // name/minutes) is modeled as "nothing to recommend" — sortTasksForDisplay
  // already knows to push a completed/nothing-left task to the end, so an
  // in-progress blank row naturally settles there too, without a special case.
  function buildRowTask(row) {
    const d = readSubjectRowData(row);
    const dueDate = d.due_date;
    const minutesRequested = d.minutes_requested;
    if (!d.name || !minutesRequested || minutesRequested <= 0) {
      return {
        id: d.id || null,
        name: d.name,
        priority: d.priority,
        dueDate,
        minutesRequested: minutesRequested || 0,
        scheduledMinutes: 0,
        remainingMinutes: 0,
        carriedOverMinutes: 0,
        missed: false,
        completed: true,
        hasSchedule: false,
      };
    }
    const [enriched] = buildSmartTasks([{ id: d.id || null, name: d.name, priority: d.priority, dueDate, minutesRequested }], currentScheduleItems);
    return enriched;
  }

  function applyStudySortOrder() {
    if (!taskSortSelect || !studyList) return;
    const rows = Array.from(studyList.children);
    if (rows.length < 2) return;
    const availableMinutesToday = computeAvailableStudyMinutes(currentScheduleItems);
    const context = { todayDateStr: schedule ? schedule.for_date : null, availableMinutesToday };
    const tasks = rows.map((row) => ({ ...buildRowTask(row), _row: row }));
    const ordered = sortTasksForDisplay(tasks, taskSortSelect.value, context);
    ordered.forEach((task) => studyList.appendChild(task._row));
  }

  if (taskSortSelect) taskSortSelect.addEventListener('change', applyStudySortOrder);

  function renderMultiDayPanel(row) {
    const slot = row.querySelector('.multiday-panel-slot');
    if (row.dataset.id !== planningRowId) {
      slot.innerHTML = '';
      return;
    }
    if (planningLoading || !planningPreview) {
      slot.innerHTML = `<div class="edit-panel multiday-panel"><p class="hint">${escapeAttr(t('multiday.loading'))}</p></div>`;
      return;
    }

    const preview = planningPreview;
    const keepMinutes = preview.keepMinutes;
    const totalMinutes = preview.totalMinutes;
    const { segments, unscheduledMinutes } = recomputeMultiDaySegments(preview, keepMinutes, totalMinutes);

    const frozenHtml =
      preview.frozen.length > 0
        ? `<p class="hint">${escapeAttr(t('multiday.frozenNote'))} ${escapeAttr(
            preview.frozen.map((f) => `${formatDateLabel(f.date)} (${f.minutes}m)`).join(', ')
          )}</p>`
        : '';

    const segmentsHtml =
      segments.length > 0
        ? segments
            .map(
              (s) => `
              <div class="multiday-seg-row">
                <span class="md-seg-date">${escapeAttr(formatDateLabel(s.date))}</span>
                <input type="number" class="md-seg-minutes" min="0" step="5" data-date="${escapeAttr(s.date)}" value="${s.minutes}">
              </div>`
            )
            .join('')
        : `<p class="hint">${escapeAttr(t('multiday.noSegments'))}</p>`;

    const warningHtml =
      unscheduledMinutes > 0
        ? `<div class="edit-error">${escapeAttr(t('multiday.unscheduledWarning'))} ${unscheduledMinutes} min</div>`
        : '';
    const errorHtml = planningError ? `<div class="edit-error">${escapeAttr(planningError)}</div>` : '';

    slot.innerHTML = `
      <div class="edit-panel multiday-panel">
        <div class="multiday-range-row">
          <label>${escapeAttr(t('multiday.startDate'))}
            <input type="date" class="md-start-date" value="${escapeAttr(preview.startDate)}">
          </label>
          <label>${escapeAttr(t('multiday.endDate'))}
            <input type="date" class="md-end-date" value="${escapeAttr(preview.endDate)}">
          </label>
        </div>
        <div class="multiday-range-row">
          <label>${escapeAttr(t('multiday.keepOnDate'))} (${escapeAttr(formatDateLabel(preview.rootDate))})
            <input type="number" class="md-keep-minutes" min="1" step="5" value="${keepMinutes}">
          </label>
          <label>${escapeAttr(t('multiday.planTotal'))}
            <input type="number" class="md-total-minutes" min="0" step="5" value="${totalMinutes}">
          </label>
        </div>
        <button type="button" class="edit-btn md-recompute-btn">${escapeAttr(t('multiday.recompute'))}</button>
        ${frozenHtml}
        <div class="multiday-segments-title hint">${escapeAttr(t('multiday.segmentsTitle'))}</div>
        <div class="multiday-segments">${segmentsHtml}</div>
        ${warningHtml}
        ${errorHtml}
        <div class="edit-actions">
          <button type="button" class="edit-save-btn md-accept-btn">${escapeAttr(t('multiday.accept'))}</button>
          <button type="button" class="md-cancel-btn">${escapeAttr(t('multiday.cancel'))}</button>
        </div>
      </div>
    `;
  }

  async function openMultiDayPanel(row) {
    if (!row.dataset.id) return;
    planningRowId = row.dataset.id;
    planningPreview = null;
    planningLoading = true;
    planningError = '';
    renderMultiDayPanel(row);

    const subjectRowData = readSubjectRowData(row);
    const startDate = addDaysToDateStr(schedule.for_date, 1);
    const endDate = subjectRowData.due_date && subjectRowData.due_date > startDate ? subjectRowData.due_date : addDaysToDateStr(startDate, 13);
    await loadMultiDayPreview(row, subjectRowData, startDate, endDate);
  }

  async function loadMultiDayPreview(row, subjectRowData, startDate, endDate) {
    const token = activeToken;
    try {
      const raw = await buildMultiDayPreview(userId, subjectRowData, startDate, endDate);
      if (token !== activeToken || row.dataset.id !== planningRowId) return; // navigated away or panel closed
      planningPreview = { ...raw, startDate, endDate, keepMinutes: raw.rootCurrentMinutes, totalMinutes: raw.planTotalMinutes };
      planningLoading = false;
      planningError = '';
    } catch (e) {
      console.error(e);
      if (token !== activeToken || row.dataset.id !== planningRowId) return;
      planningLoading = false;
      planningError = t('errors.couldNotLoadMultiDayPreview');
    }
    renderMultiDayPanel(row);
  }

  studyList.addEventListener('click', async (e) => {
    const planBtn = e.target.closest('.plan-days-btn');
    if (planBtn) {
      const row = planBtn.closest('.entry-row');
      if (planningRowId === row.dataset.id) {
        closeMultiDayPanel();
        renderMultiDayPanel(row);
        return;
      }
      if (planningRowId) {
        const previousRow = findStudyRow(planningRowId);
        if (previousRow) previousRow.querySelector('.multiday-panel-slot').innerHTML = '';
      }
      await openMultiDayPanel(row);
      return;
    }

    const cancelBtn = e.target.closest('.md-cancel-btn');
    if (cancelBtn) {
      const row = cancelBtn.closest('.entry-row');
      closeMultiDayPanel();
      renderMultiDayPanel(row);
      return;
    }

    const recomputeBtn = e.target.closest('.md-recompute-btn');
    if (recomputeBtn) {
      const row = recomputeBtn.closest('.entry-row');
      const panel = recomputeBtn.closest('.multiday-panel');
      const startDate = panel.querySelector('.md-start-date').value;
      const endDate = panel.querySelector('.md-end-date').value;
      if (!startDate || !endDate || endDate < startDate) {
        planningError = 'Choose a valid start and end date.';
        renderMultiDayPanel(row);
        return;
      }
      const keepMinutes = parseInt(panel.querySelector('.md-keep-minutes').value, 10) || 0;
      const totalMinutes = parseInt(panel.querySelector('.md-total-minutes').value, 10) || 0;
      const subjectRowData = readSubjectRowData(row);
      planningLoading = true;
      planningError = '';
      renderMultiDayPanel(row);
      await loadMultiDayPreview(row, subjectRowData, startDate, endDate);
      if (planningPreview) {
        planningPreview.keepMinutes = keepMinutes;
        planningPreview.totalMinutes = totalMinutes;
        renderMultiDayPanel(row);
      }
      return;
    }

    const acceptBtn = e.target.closest('.md-accept-btn');
    if (acceptBtn) {
      const row = acceptBtn.closest('.entry-row');
      const panel = acceptBtn.closest('.multiday-panel');
      const keepMinutes = parseInt(panel.querySelector('.md-keep-minutes').value, 10);
      if (!Number.isFinite(keepMinutes) || keepMinutes <= 0) {
        planningError = `${t('multiday.keepOnDate')} must be at least 1 minute.`;
        renderMultiDayPanel(row);
        return;
      }
      const segments = Array.from(panel.querySelectorAll('.md-seg-minutes'))
        .map((input) => ({ date: input.dataset.date, minutes: parseInt(input.value, 10) || 0 }))
        .filter((s) => s.minutes > 0);

      const token = activeToken;
      acceptBtn.disabled = true;
      try {
        await acceptMultiDayPlan(userId, planningPreview, keepMinutes, segments);
        if (token !== activeToken) return; // navigated away while saving
        closeMultiDayPanel();

        const scheduleId = schedule.id;
        const reloadedSubjects = await listStudySubjects(scheduleId);
        if (token !== activeToken || !schedule || schedule.id !== scheduleId) return;
        studyList.innerHTML = '';
        reloadedSubjects.forEach((s) => addStudyRow(s));
        applyStudySortOrder();
        refreshHistoryList();
        flashSaved();
      } catch (err) {
        console.error(err);
        planningError = t('errors.couldNotSaveMultiDayPlan');
        acceptBtn.disabled = false;
        renderMultiDayPanel(row);
      }
      return;
    }
  });

  studyList.addEventListener('change', (e) => {
    // purely visual: keeps the priority select's color-coded badge in sync —
    // does not affect what gets saved below
    if (e.target.classList.contains('study-priority')) {
      e.target.dataset.priority = e.target.value;
    }
    const row = e.target.closest('.entry-row');
    if (!row) return;
    // Re-rank immediately on a field that actually affects order (priority/
    // due date/minutes), reading straight from the DOM rather than waiting
    // on the async save below — name/notes edits never move a row.
    if (e.target.matches('.study-priority, .study-due, .study-minutes')) applyStudySortOrder();
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

  // ---------------- Missed Task + Auto Carry Over (Phase 14) ----------------
  // Two more single-panel-at-a-time states, same pattern as editingItemId —
  // opening any one of the three (manual edit / partial completion /
  // carry-over preview) closes the other two via closeSecondaryPanels(),
  // since a block only ever shows one inline panel at once.
  let partialPanelItemId = null;
  let carryOverPanelItemId = null;
  let carryOverPreview = null;
  let carryOverLoading = false;
  let carryOverError = '';

  function closeSecondaryPanels() {
    editingItemId = null;
    partialPanelItemId = null;
    carryOverPanelItemId = null;
    carryOverPreview = null;
    carryOverLoading = false;
    carryOverError = '';
  }

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
    // Checkpoint C.1: locale-aware formatting (getLocale(), not the
    // browser/OS default) and one consistent "Due <date>" shape instead of
    // the old today/tomorrow/yesterday special-casing.
    const dateText = due.toLocaleDateString(getLocale(), { month: 'short', day: 'numeric' });
    const label = `${t('planner.dueLabel')} ${dateText}`;
    return diffDays < 0 ? `${label} ${t('planner.overdueSuffix')}` : label;
  }

  // Phase 14: the inline Carry Over / Re-plan Remaining preview panel for
  // whichever study block currently has one open (carryOverPanelItemId).
  // Mirrors the shape of Phase 13's multiday-panel in addStudyRow's
  // renderMultiDayPanel — same reused segment-editing UI, just fed by
  // buildCarryOverPreview/recomputeCarryOverSegments instead of
  // buildMultiDayPreview/recomputeMultiDaySegments.
  function buildCarryOverPanelHtml(itemId) {
    if (carryOverLoading || !carryOverPreview) {
      return `<div class="edit-panel carryover-panel"><p class="hint">${escapeAttr(t('multiday.loading'))}</p></div>`;
    }
    const preview = carryOverPreview;
    const { segments, unscheduledMinutes } = recomputeCarryOverSegments(preview);

    const segmentsHtml =
      segments.length > 0
        ? segments
            .map(
              (s) => `
              <div class="multiday-seg-row">
                <span class="md-seg-date">${escapeAttr(formatDateLabel(s.date))}</span>
                <input type="number" class="co-seg-minutes" min="0" step="5" data-date="${escapeAttr(s.date)}" value="${s.minutes}">
              </div>`
            )
            .join('')
        : `<p class="hint">${escapeAttr(t('multiday.noSegments'))}</p>`;

    const warningHtml =
      unscheduledMinutes > 0
        ? `<div class="edit-error"><strong>${escapeAttr(t('carryOver.couldNotReschedule'))}:</strong> ${unscheduledMinutes} ${escapeAttr(t('carryOver.unscheduledSuffix'))}</div>`
        : '';
    const errorHtml = carryOverError ? `<div class="edit-error">${escapeAttr(carryOverError)}</div>` : '';

    return `
      <div class="edit-panel carryover-panel">
        <p class="hint">${escapeAttr(t('carryOver.remainingMinutesLabel'))}: ${preview.remainingMinutes} min</p>
        <div class="multiday-range-row">
          <label>${escapeAttr(t('multiday.startDate'))}
            <input type="date" class="co-start-date" value="${escapeAttr(preview.startDate)}">
          </label>
          <label>${escapeAttr(t('multiday.endDate'))}
            <input type="date" class="co-end-date" value="${escapeAttr(preview.endDate)}">
          </label>
        </div>
        <label class="co-extend-label">
          <input type="checkbox" class="co-extend-checkbox" ${preview.ignoreDueDate ? 'checked' : ''}>
          ${escapeAttr(t('carryOver.extendPastDue'))}
        </label>
        <button type="button" class="co-action-btn co-recompute-btn" data-id="${itemId}">${escapeAttr(t('multiday.recompute'))}</button>
        <div class="multiday-segments-title hint">${escapeAttr(t('multiday.segmentsTitle'))}</div>
        <div class="multiday-segments">${segmentsHtml}</div>
        ${warningHtml}
        ${errorHtml}
        <div class="edit-actions">
          <button type="button" class="co-primary-btn co-accept-btn" data-id="${itemId}">${escapeAttr(t('carryOver.replanRemaining'))}</button>
          <button type="button" class="co-cancel-btn" data-id="${itemId}">${escapeAttr(t('multiday.cancel'))}</button>
        </div>
      </div>
    `;
  }

  async function openCarryOverPanel(item) {
    closeSecondaryPanels();
    carryOverPanelItemId = item.id;
    carryOverLoading = true;
    renderScheduleEvents(currentScheduleItems, buildSubjectsInput());

    let subjectRow;
    try {
      subjectRow = await getStudySubjectById(item.sourceSubjectId);
    } catch (err) {
      console.error(err);
      if (carryOverPanelItemId !== item.id) return;
      carryOverLoading = false;
      carryOverError = t('errors.couldNotLoadTask');
      renderScheduleEvents(currentScheduleItems, buildSubjectsInput());
      return;
    }
    if (carryOverPanelItemId !== item.id) return; // panel closed while this was loading
    if (!subjectRow) {
      carryOverLoading = false;
      carryOverError = 'This task no longer exists.';
      renderScheduleEvents(currentScheduleItems, buildSubjectsInput());
      return;
    }

    const remaining = computeRemainingMinutes({
      start: item.start,
      end: item.end,
      completed: item.completed,
      completedMinutes: item.completedMinutes,
      carriedOverMinutes: item.carriedOverMinutes,
    });
    const startDate = addDaysToDateStr(schedule.for_date, 1);
    const endDate = subjectRow.due_date && subjectRow.due_date > startDate ? subjectRow.due_date : addDaysToDateStr(startDate, 13);
    await loadCarryOverPreview(item, subjectRow, remaining, startDate, endDate, false);
  }

  async function loadCarryOverPreview(item, subjectRow, remainingMinutes, startDate, endDate, ignoreDueDate) {
    const token = activeToken;
    try {
      const raw = await buildCarryOverPreview(userId, item, subjectRow, remainingMinutes, startDate, endDate, { ignoreDueDate });
      if (token !== activeToken || carryOverPanelItemId !== item.id) return; // navigated away or panel closed
      carryOverPreview = { ...raw, startDate, endDate };
      carryOverLoading = false;
      carryOverError = '';
    } catch (e) {
      console.error(e);
      if (token !== activeToken || carryOverPanelItemId !== item.id) return;
      carryOverLoading = false;
      carryOverError = t('errors.couldNotLoadCarryOverPreview');
    }
    renderScheduleEvents(currentScheduleItems, buildSubjectsInput());
  }

  function renderScheduleEvents(events, subjectsForLookup) {
    if (!events || events.length === 0) {
      output.innerHTML = `
        <div class="planner-empty-state">
          <span class="planner-empty-glyph" aria-hidden="true">🗓️</span>
          <p class="planner-empty-title">${escapeAttr(t('planner.emptyScheduleTitle'))}</p>
          <p class="hint">${escapeAttr(t('planner.emptyScheduleBody'))}</p>
        </div>
      `;
      renderNextUp([]);
      applyStudySortOrder();
      return;
    }
    const subjectByName = new Map((subjectsForLookup || []).map((s) => [s.name, s]));
    const html = events
      .map((e) => {
        const dur = e.end - e.start;
        const durText = dur >= 60 ? `${Math.floor(dur / 60)}h ${dur % 60 ? (dur % 60) + 'm' : ''}`.trim() : `${dur} min`;
        const metaParts = [`${formatClock(e.start)} – ${formatClock(e.end)}`, durText];

        let priorityBadge = '';
        let missedBadge = '';
        let lockControl = '';
        let doneControl = '';
        let editControl = '';
        let partialControl = '';
        let missedControl = '';
        let carryOverControl = '';
        let nameHtml = escapeAttr(e.name);
        if (e.type === 'study') {
          const subj = subjectByName.get(e.name);
          if (subj?.priority) {
            priorityBadge = `<span class="tl-badge tl-badge-${subj.priority}">${subj.priority.toUpperCase()}</span>`;
          }
          const dueText = formatDueDate(subj?.dueDate);
          if (dueText) metaParts.push(dueText);

          if (e.completed) nameHtml = `✓ ${nameHtml}`;
          if (e.missed) missedBadge = `<span class="tl-badge tl-badge-missed">${escapeAttr(t('carryOver.missedBadge'))}</span>`;

          // Phase 14: partial-completion + carried-over audit trail, shown
          // right alongside the existing time/duration/due-date meta line —
          // never replacing it.
          const duration = e.end - e.start;
          if (e.completedMinutes > 0 && !e.completed) {
            metaParts.push(`${t('carryOver.completedMinutesLabel')}: ${e.completedMinutes}/${duration} min`);
          }
          if (e.carriedOverMinutes > 0) {
            metaParts.push(`${t('carryOver.carriedOverNote')} ${e.carriedOverMinutes} min`);
          }

          if (e.id) {
            lockControl = `<button type="button" class="lock-btn" data-id="${e.id}" data-locked="${e.locked ? '1' : '0'}">${escapeAttr(e.locked ? t('schedule.locked') : t('schedule.lockAction'))}</button>`;
            doneControl = `<button type="button" class="done-btn" data-id="${e.id}" data-completed="${e.completed ? '1' : '0'}">${escapeAttr(e.completed ? t('schedule.undo') : t('schedule.markDone'))}</button>`;
            // editing a locked block is blocked in favor of unlocking it first — see
            // the Phase 9 note on validateManualStudyEdit for why
            if (e.id === editingItemId) {
              editControl = `
                <div class="edit-panel">
                  <label>${escapeAttr(t('schedule.startTimeLabel'))}</label>
                  <input type="time" class="edit-start-input" value="${minutesToInputTime(e.start)}">
                  <div class="edit-actions">
                    <button type="button" class="edit-save-btn" data-id="${e.id}">${escapeAttr(t('carryOver.save'))}</button>
                    <button type="button" class="edit-cancel-btn" data-id="${e.id}">${escapeAttr(t('multiday.cancel'))}</button>
                  </div>
                  <div class="edit-error"></div>
                </div>
              `;
            } else if (!e.locked) {
              editControl = `<button type="button" class="edit-btn" data-id="${e.id}">${escapeAttr(t('schedule.edit'))}</button>`;
            }

            // Phase 14: Partial Completion / Missed / Carry Over — same rule
            // as Edit above, a LOCKED block is never touched by any of these
            // without an explicit unlock first (see carryOverModel.js's
            // canCarryOverBlock/canMarkMissed).
            if (!e.locked) {
              if (e.id === partialPanelItemId) {
                partialControl = `
                  <div class="edit-panel partial-panel">
                    <label>${escapeAttr(t('carryOver.completedMinutesLabel'))} (0–${duration})</label>
                    <input type="number" class="partial-minutes-input" min="0" max="${duration}" step="5" value="${e.completedMinutes || 0}">
                    <div class="edit-actions">
                      <button type="button" class="co-primary-btn partial-save-btn" data-id="${e.id}">${escapeAttr(t('carryOver.save'))}</button>
                      <button type="button" class="partial-cancel-btn" data-id="${e.id}">${escapeAttr(t('multiday.cancel'))}</button>
                    </div>
                    <div class="edit-error"></div>
                  </div>
                `;
              } else {
                partialControl = `<button type="button" class="co-action-btn partial-btn" data-id="${e.id}">${escapeAttr(t('carryOver.partialCompletion'))}</button>`;
              }

              if (e.missed) {
                missedControl = `<button type="button" class="co-action-btn unmark-missed-btn" data-id="${e.id}">${escapeAttr(t('carryOver.unmarkMissed'))}</button>`;
              } else if (canMarkMissed(e)) {
                missedControl = `<button type="button" class="co-action-btn mark-missed-btn" data-id="${e.id}">${escapeAttr(t('carryOver.markAsMissed'))}</button>`;
              }

              if (canCarryOverBlock(e)) {
                carryOverControl = `<button type="button" class="co-action-btn carry-over-btn" data-id="${e.id}">${escapeAttr(t('carryOver.carryOver'))}</button>`;
              }

              if (e.id === carryOverPanelItemId) {
                carryOverControl += buildCarryOverPanelHtml(e.id);
              }
            }
          }
        }

        const actionsHtml =
          lockControl || doneControl || editControl || partialControl || missedControl || carryOverControl
            ? `<div class="tl-actions">${lockControl}${doneControl}${editControl}${partialControl}${missedControl}${carryOverControl}</div>`
            : '';

        return `
          <div class="tl-row tl-${e.type}${e.locked ? ' tl-locked' : ''}${e.completed ? ' tl-completed' : ''}">
            <div class="tl-time">${formatClock(e.start)}</div>
            <div class="tl-rail"><span class="tl-dot"></span></div>
            <div class="tl-card">
              <div class="tl-card-top">
                <span class="tl-name">${nameHtml}</span>
                ${priorityBadge}
                ${missedBadge}
              </div>
              <div class="tl-meta">${escapeAttr(metaParts.join(' · '))}</div>
              ${actionsHtml}
            </div>
          </div>
        `;
      })
      .join('');
    output.innerHTML = `<div class="timeline">${html}</div>`;
    renderNextUp(events);
    // Checkpoint E: whatever just changed the schedule (generate, lock,
    // done, edit, partial completion, missed, carry-over) may have changed
    // remaining minutes / missed status — re-rank if the Study Tasks list
    // is currently sorted by anything schedule-dependent.
    applyStudySortOrder();
  }

  // ---------------- Next Up (Checkpoint C) ----------------
  // Purely derived from whatever is currently rendered in the timeline plus
  // the real clock — nothing here is stored; it's recomputed on every
  // renderScheduleEvents() call and only ever shown while viewing today.
  const nextUpCard = document.getElementById('nextUpCard');
  const nextUpBody = document.getElementById('nextUpBody');

  function currentClockMinutes() {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  }

  function renderNextUp(events) {
    if (!schedule || schedule.for_date !== todayDateStr() || !events || events.length === 0) {
      nextUpCard.hidden = true;
      nextUpBody.innerHTML = '';
      return;
    }
    const nowMinutes = currentClockMinutes();
    const sorted = [...events].sort((a, b) => a.start - b.start);
    const current = sorted.find((e) => nowMinutes >= e.start && nowMinutes < e.end && e.type !== 'free');
    const next = !current ? sorted.find((e) => e.start > nowMinutes && e.type !== 'free') : null;
    const block = current || next;

    if (!block) {
      nextUpCard.hidden = false;
      nextUpBody.innerHTML = `<p class="nextup-empty">${escapeAttr(t('planner.nextUpEmpty'))}</p>`;
      return;
    }

    nextUpCard.hidden = false;
    const label = current ? t('planner.nextUpNowLabel') : t('planner.nextUpNextLabel');
    nextUpBody.innerHTML = `
      <div class="nextup-row">
        <span class="nextup-dot${current ? ' is-live' : ''}"></span>
        <div class="nextup-info">
          <div class="nextup-name">${escapeAttr(block.name)}</div>
          <div class="nextup-meta">${escapeAttr(label)} · ${formatClock(block.start)} – ${formatClock(block.end)}</div>
        </div>
      </div>
    `;
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
        flashError(t('errors.couldNotUpdateLock'));
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
        flashError(t('errors.couldNotUpdateCompletion'));
        doneBtn.disabled = false;
      }
      return;
    }

    const editBtn = e.target.closest('.edit-btn');
    if (editBtn) {
      closeSecondaryPanels();
      editingItemId = editBtn.dataset.id;
      renderScheduleEvents(currentScheduleItems, buildSubjectsInput());
      return;
    }

    const cancelBtn = e.target.closest('.edit-cancel-btn');
    if (cancelBtn) {
      closeSecondaryPanels();
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
        errorEl.textContent = t('errors.invalidTime');
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
        errorEl.textContent = t('errors.couldNotSave');
        saveBtn.disabled = false;
      }
      return;
    }

    // ---------------- Phase 14: Partial Completion ----------------
    const partialBtn = e.target.closest('.partial-btn');
    if (partialBtn) {
      closeSecondaryPanels();
      partialPanelItemId = partialBtn.dataset.id;
      renderScheduleEvents(currentScheduleItems, buildSubjectsInput());
      return;
    }

    const partialCancelBtn = e.target.closest('.partial-cancel-btn');
    if (partialCancelBtn) {
      closeSecondaryPanels();
      renderScheduleEvents(currentScheduleItems, buildSubjectsInput());
      return;
    }

    const partialSaveBtn = e.target.closest('.partial-save-btn');
    if (partialSaveBtn) {
      const id = partialSaveBtn.dataset.id;
      const panel = partialSaveBtn.closest('.partial-panel');
      const input = panel.querySelector('.partial-minutes-input');
      const errorEl = panel.querySelector('.edit-error');
      const item = currentScheduleItems.find((i) => i.id === id);
      if (!item) return;

      const duration = item.end - item.start;
      const validated = validateCompletedMinutesInput(input.value, duration);
      if (!validated.ok) {
        errorEl.textContent = validated.error;
        return;
      }
      const completed = isFullyCompletedByMinutes(validated.value, duration);

      const token = activeToken;
      partialSaveBtn.disabled = true;
      try {
        await setScheduleItemPartialCompletion(id, validated.value, completed);
        if (token !== activeToken) return; // navigated away before this resolved
        item.completedMinutes = validated.value;
        item.completed = completed;
        closeSecondaryPanels();
        renderScheduleEvents(currentScheduleItems, buildSubjectsInput());
        renderDailySummaryFromCurrent();
        refreshHistoryList();
        flashSaved();
      } catch (err) {
        console.error(err);
        errorEl.textContent = t('errors.couldNotSave');
        partialSaveBtn.disabled = false;
      }
      return;
    }

    // ---------------- Phase 14: Missed ----------------
    const markMissedBtn = e.target.closest('.mark-missed-btn');
    if (markMissedBtn) {
      const id = markMissedBtn.dataset.id;
      const item = currentScheduleItems.find((i) => i.id === id);
      if (!item) return;
      const token = activeToken;
      markMissedBtn.disabled = true;
      try {
        await setScheduleItemMissed(id, true);
        if (token !== activeToken) return;
        item.missed = true;
        flashSaved();
        // "Missed -> Preview new plan -> Confirm": marking a block missed
        // immediately offers the same Carry Over preview — nothing is
        // actually moved until the student explicitly accepts it there.
        await openCarryOverPanel(item);
      } catch (err) {
        console.error(err);
        flashError('Could not mark this block missed — check your connection.');
        markMissedBtn.disabled = false;
      }
      return;
    }

    const unmarkMissedBtn = e.target.closest('.unmark-missed-btn');
    if (unmarkMissedBtn) {
      const id = unmarkMissedBtn.dataset.id;
      const item = currentScheduleItems.find((i) => i.id === id);
      if (!item) return;
      const token = activeToken;
      unmarkMissedBtn.disabled = true;
      try {
        await setScheduleItemMissed(id, false);
        if (token !== activeToken) return;
        item.missed = false;
        renderScheduleEvents(currentScheduleItems, buildSubjectsInput());
        flashSaved();
      } catch (err) {
        console.error(err);
        flashError(t('errors.couldNotUpdateBlock'));
        unmarkMissedBtn.disabled = false;
      }
      return;
    }

    // ---------------- Phase 14: Carry Over / Re-plan Remaining ----------------
    const carryOverBtn = e.target.closest('.carry-over-btn');
    if (carryOverBtn) {
      const id = carryOverBtn.dataset.id;
      const item = currentScheduleItems.find((i) => i.id === id);
      if (!item) return;
      await openCarryOverPanel(item);
      return;
    }

    const coCancelBtn = e.target.closest('.co-cancel-btn');
    if (coCancelBtn) {
      closeSecondaryPanels();
      renderScheduleEvents(currentScheduleItems, buildSubjectsInput());
      return;
    }

    const coRecomputeBtn = e.target.closest('.co-recompute-btn');
    if (coRecomputeBtn) {
      const id = coRecomputeBtn.dataset.id;
      const item = currentScheduleItems.find((i) => i.id === id);
      const panel = coRecomputeBtn.closest('.carryover-panel');
      if (!item || !panel) return;

      const startDate = panel.querySelector('.co-start-date').value;
      const endDate = panel.querySelector('.co-end-date').value;
      const ignoreDueDate = panel.querySelector('.co-extend-checkbox').checked;
      if (!startDate || !endDate || endDate < startDate) {
        carryOverError = 'Choose a valid start and end date.';
        renderScheduleEvents(currentScheduleItems, buildSubjectsInput());
        return;
      }

      carryOverLoading = true;
      carryOverError = '';
      renderScheduleEvents(currentScheduleItems, buildSubjectsInput());

      try {
        const subjectRow = await getStudySubjectById(item.sourceSubjectId);
        if (carryOverPanelItemId !== item.id) return; // panel closed while this was loading
        if (!subjectRow) {
          carryOverLoading = false;
          carryOverError = 'This task no longer exists.';
          renderScheduleEvents(currentScheduleItems, buildSubjectsInput());
          return;
        }
        const remaining = computeRemainingMinutes({
          start: item.start,
          end: item.end,
          completed: item.completed,
          completedMinutes: item.completedMinutes,
          carriedOverMinutes: item.carriedOverMinutes,
        });
        await loadCarryOverPreview(item, subjectRow, remaining, startDate, endDate, ignoreDueDate);
      } catch (err) {
        console.error(err);
        if (carryOverPanelItemId !== item.id) return;
        carryOverLoading = false;
        carryOverError = t('errors.couldNotLoadCarryOverPreview');
        renderScheduleEvents(currentScheduleItems, buildSubjectsInput());
      }
      return;
    }

    const coAcceptBtn = e.target.closest('.co-accept-btn');
    if (coAcceptBtn) {
      const id = coAcceptBtn.dataset.id;
      const item = currentScheduleItems.find((i) => i.id === id);
      const panel = coAcceptBtn.closest('.carryover-panel');
      if (!item || !panel || !carryOverPreview) return;

      const segments = Array.from(panel.querySelectorAll('.co-seg-minutes'))
        .map((input) => ({ date: input.dataset.date, minutes: parseInt(input.value, 10) || 0 }))
        .filter((s) => s.minutes > 0);

      const token = activeToken;
      coAcceptBtn.disabled = true;
      try {
        const result = await acceptCarryOver(userId, carryOverPreview, segments);
        if (token !== activeToken) return; // navigated away while saving
        item.carriedOverMinutes = (item.carriedOverMinutes || 0) + result.carriedTotal;
        closeSecondaryPanels();
        renderScheduleEvents(currentScheduleItems, buildSubjectsInput());
        refreshHistoryList();
        flashSaved();
      } catch (err) {
        console.error(err);
        carryOverError = t('errors.couldNotSaveCarryOverPlan');
        coAcceptBtn.disabled = false;
        renderScheduleEvents(currentScheduleItems, buildSubjectsInput());
      }
      return;
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
        <div class="row"><span>${escapeAttr(t('shortfall.requestedLabel'))}</span><span class="value">${progress.requestedTotal} min</span></div>
        <div class="row"><span>${escapeAttr(t('shortfall.scheduledLabel'))}</span><span class="value">${progress.scheduledTotal} min</span></div>
        <div class="row"><span>${escapeAttr(t('shortfall.unscheduledLabel'))}</span><span class="value">${progress.unscheduledTotal} min</span></div>
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
      [t('summary.classes'), summary.classMinutes],
      [t('summary.study'), summary.studyMinutes],
      [t('summary.meals'), summary.mealMinutes],
      [t('summary.breaks'), summary.breakMinutes],
      [t('summary.freeTime'), summary.freeMinutes],
      [t('summary.awakeTime'), summary.awakeMinutes],
    ];
    let html = rows
      .map(([label, mins]) => `<div class="summary-row"><span class="label">${escapeAttr(label)}</span><span class="value">${formatDuration(mins)}</span></div>`)
      .join('');
    if (summary.sleepMinutes !== null) {
      html += `<div class="summary-row"><span class="label">${escapeAttr(t('summary.sleep'))}</span><span class="value">${formatDuration(summary.sleepMinutes)}</span></div>`;
    }
    if (progress) {
      const total = progress.subjects.length;
      html += `<div class="summary-progress">${escapeAttr(t('summary.studyProgress'))} <strong>${progress.completedCount} / ${total}</strong> ${escapeAttr(t('summary.tasksCompletedSuffix'))}`;
      if (total > 0) html += ` <span class="summary-percent">${escapeAttr(t('summary.completionPercentSuffix').replace('{percent}', progress.completionPercent))}</span>`;
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

  // Checkpoint C.1: Generate and Regenerate are now mutually exclusive — a
  // schedule that already exists shows Regenerate as the single primary
  // action instead of two full-width buttons stacked at once.
  function updateRegenerateVisibility() {
    const hasSchedule = currentScheduleItems.length > 0;
    regenerateBtn.hidden = !hasSchedule;
    generateBtn.hidden = hasSchedule;
  }

  async function runGeneration(lockedBlocks) {
    const scheduleId = schedule.id;
    const token = activeToken;
    closeSecondaryPanels(); // the whole timeline is about to be replaced

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
          completedMinutes: r.completed_minutes,
          missed: r.missed,
          carriedOverMinutes: r.carried_over_minutes,
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

  const generateBtn = document.getElementById('generateBtn');
  // Checkpoint C: a visible "Generating…" state on whichever button was
  // clicked instead of a silent wait — runGeneration's own error handling
  // (showScheduleError/flashError) is untouched, this only brackets it.
  async function handleGenerateClick(btn) {
    const originalText = btn.textContent;
    generateBtn.disabled = true;
    regenerateBtn.disabled = true;
    btn.textContent = t('actions.generating');
    try {
      await runGeneration(lockedBlocksFromCurrent());
    } finally {
      generateBtn.disabled = false;
      regenerateBtn.disabled = false;
      btn.textContent = originalText;
    }
  }
  generateBtn.addEventListener('click', () => handleGenerateClick(generateBtn));
  regenerateBtn.addEventListener('click', () => handleGenerateClick(regenerateBtn));

  // ---------------- history ----------------
  const historyListEl = document.getElementById('historyList');

  function renderHistoryList(history, activeDate) {
    if (!history || history.length === 0) {
      historyListEl.innerHTML = `<div class="placeholder">${escapeAttr(t('history.noSavedDates'))}</div>`;
      return;
    }
    historyListEl.innerHTML = history
      .map((h) => {
        const dateLabel = formatDateLabel(h.forDate);
        const bits = [t('history.classCount').replace('{count}', h.classCount), t('history.subjectCount').replace('{count}', h.subjectCount)];
        if (h.studyBlockCount > 0) bits.push(t('history.completionPercent').replace('{percent}', h.completionPercent));
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
    closeSecondaryPanels();
    closeMultiDayPanel();
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
      if (token === activeToken) loadError.textContent = t('errors.couldNotLoadDate');
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
    updatePlannerHeader();

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
            completedMinutes: i.completed_minutes,
            missed: i.missed,
            carriedOverMinutes: i.carried_over_minutes,
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

  // Home (analyticsView) is the default landing view now, matching the
  // "active" nav-item already marked in dashboard.html — the Planner's own
  // data is still loaded above regardless, so switching to it is instant.
  showAltView(document.getElementById('analyticsView'));
  if (analyticsSection && typeof analyticsSection.onShow === 'function') analyticsSection.onShow();
}
