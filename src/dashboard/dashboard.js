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
  listClassSeries,
  createClassSeries,
  updateClassSeries,
  deleteClassSeries,
  listClassSeriesExceptions,
  upsertClassSeriesException,
  deleteClassSeriesException,
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
  listScheduleItemsForSourceSubjectIds,
  fetchAllUserDataForExport,
  userHasAnyPlanningData,
  getOnboardingCompletedAt,
  markOnboardingCompleted,
  listStudySubjectsForScheduleIds,
  listClassesForScheduleIds,
  listUpcomingStudySubjects,
  listStudySubjectsDueInRange,
  setScheduleItemMissed,
  setScheduleItemPartialCompletion,
  getStudySubjectById,
  listSubtasksForSubjectIds,
  insertSubtask,
  updateSubtask,
  deleteSubtask,
} from './data.js';
import {
  generateSchedule,
  resolveDayBounds,
  resolveStudyWindow,
  resolveClockTimeInDay,
  validateManualStudyEdit,
  formatClock,
  timeToMinutes,
  setNextDayLabel,
  setClockLocale,
} from './scheduler.js';
import { buildMultiDayPreview, recomputeMultiDaySegments, acceptMultiDayPlan, buildCarryOverPreview, recomputeCarryOverSegments, acceptCarryOver } from './multiDayPlan.js';
import { computeRemainingMinutes, isFullyCompletedByMinutes, validateCompletedMinutesInput, canCarryOverBlock, canMarkMissed } from './carryOverModel.js';
import {
  createFocusSession,
  isPaused,
  getRemainingMs,
  isTimeUp,
  pauseSession,
  resumeSession,
  formatCountdown,
  buildFocusCompletionWrite,
  computeTodaySessionProgress,
  serializeSession,
  parseStoredSession,
  canStartFocus,
} from './focusMode.js';
import { computeDailySummary, computeSubjectProgress, formatDuration } from './summary.js';
import { filterHistory, collectHistorySubjects, countActiveHistoryFilters } from './history.js';
import { validateCopyDestination } from './copySchedule.js';
import { buildSmartTasks, computeAvailableStudyMinutes, sortTasksForDisplay } from './smartPriority.js';
import { QUICK_TEMPLATES, getQuickTemplate, buildTemplatePreview, buildTemplatePrefsPatch } from './quickTemplates.js';
import { isValidSubtaskTitle, buildSubtaskFields, nextSubtaskSortOrder, computeSubtaskProgress } from './subtasksModel.js';
import { PRESET_TASK_TAGS, normalizeTagList, toggleTag, addCustomTag } from './tagsModel.js';
import {
  normalizeDaysOfWeek,
  isValidTimeRange,
  buildSeriesFields,
  validateSeriesFields,
  buildEffectiveClassesForDate,
  buildSkipExceptionFields,
  buildModifyExceptionFields,
} from './recurringClasses.js';
import { filterTasks, listDistinctSubjectNames, listDistinctTags } from './taskFilters.js';
import { t, tCount, tMessage, applyTranslations, getLanguage, getLocale, setLanguage } from '../shared/i18n.js';
import { initBoardSection } from '../board/board.js';
import { listBoards } from '../board/boardData.js';
import { initAnalyticsSection } from '../analytics/analytics.js';
import { initWeekSection } from '../week/week.js';
import { initNotificationsSection } from '../notifications/notifications.js';
import { registerServiceWorker, initInstallPrompt, initOfflineIndicator } from '../shared/pwa.js';
import { initCalendarSection } from '../calendar/calendar.js';
import { initAgendaSection } from '../calendar/agenda.js';
import { initCommandPalette } from '../shared/commandPaletteView.js';
import { isPaletteShortcut } from '../shared/commandPalette.js';
import { EXPORT_TABLES, buildExportPayload, buildExportFilename, totalExportedRows } from '../shared/dataExport.js';
import { initOnboarding } from './onboarding.js';
import { deriveBlockStatus, deriveTaskStatus, statusBadgeHtml, statusLabelKey } from '../shared/statusModel.js';
import { displayBlockName, mealLabel } from '../shared/blockLabels.js';
import { scrollBehavior } from '../shared/motion.js';
import { validateBlockDuration, nudgeClock, NUDGE_MINUTES } from './manualEditModel.js';
import { detectScheduleConflicts, classesToMinutes } from './conflictModel.js';
import { shouldShowOnboarding } from './onboardingModel.js';
import { IS_DEMO } from '../lib/supabaseClient.js';
import { exitDemoMode } from '../demo/demoMode.js';
import { probeCapabilities } from '../shared/capabilities.js';
import { setAppContext } from '../app/context.js';
import { parseHash, pushRoute, onRouteChange } from '../app/router.js';
import { initV3Sections } from '../app/v3Sections.js';
import { toast } from '../ui/toast.js';
import { invalidate as invalidateCache } from '../app/store.js';

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
    if (IS_DEMO) {
      exitDemoMode();
      window.location.href = 'login.html';
      return;
    }
    await supabase.auth.signOut();
    window.location.href = 'login.html';
  });

  // ---------------- Demo Mode banner (V3-T) ----------------
  if (IS_DEMO) {
    document.body.classList.add('is-demo');
    const demoBanner = document.getElementById('demoBanner');
    if (demoBanner) demoBanner.hidden = false;
    document.getElementById('demoExitBtn')?.addEventListener('click', () => {
      exitDemoMode();
      window.location.href = 'login.html';
    });
    document.getElementById('demoResetBtn')?.addEventListener('click', () => {
      if (supabase.__demo) supabase.__demo.reset();
      try { sessionStorage.setItem('student-scheduler-demo-reset', '1'); } catch { /* ignore */ }
      window.location.reload();
    });
    document.getElementById('demoSignupLink')?.addEventListener('click', () => exitDemoMode());
    try {
      if (sessionStorage.getItem('student-scheduler-demo-reset') === '1') {
        sessionStorage.removeItem('student-scheduler-demo-reset');
        setTimeout(() => toast(t('demo.resetDone'), { kind: 'success' }), 600);
      }
    } catch { /* ignore */ }
  }

  // Which V3 tables/columns exist yet (migrations 0010+ are applied by hand).
  await probeCapabilities();

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
      setNextDayLabel(t('scheduler.nextDay'));
      setClockLocale(getLocale());
      refreshThemeToggleLabel();
      // Home's greeting/labels are rendered via t(), not [data-i18n] alone
      // (the greeting also splices in the display name) — re-run its
      // render pass so a language switch updates it immediately too.
      if (analyticsSection && typeof analyticsSection.onShow === 'function') {
        const onInsights = !document.getElementById('insightsView')?.hidden;
        if (onInsights) analyticsSection.onShowInsights();
        else analyticsSection.onShow();
      }
      // V3 pages render their text through t() — repaint the visible one.
      if (typeof rerenderCurrentView === 'function') rerenderCurrentView();
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
  const altViewEls = [
    document.getElementById('boardView'),
    document.getElementById('weekView'),
    document.getElementById('calendarView'),
    document.getElementById('analyticsView'),
    document.getElementById('insightsView'),
    document.getElementById('settingsView'),
    // V3 pages
    document.getElementById('historyView'),
    document.getElementById('coursesView'),
    document.getElementById('tasksView'),
    document.getElementById('gradesView'),
    document.getElementById('examsView'),
    document.getElementById('semesterView'),
  ].filter(Boolean);

  // V3: the mobile bottom bar mirrors the sidebar's active item, and the
  // active item carries aria-current for screen readers.
  let currentViewKey = 'analyticsView';
  function syncNavState() {
    const active = document.querySelector('.sidebar .nav-item.active');
    const target = active ? active.dataset.viewTarget || active.dataset.scrollTarget : null;
    document.querySelectorAll('.nav-item').forEach((b) => {
      if (b.classList.contains('active')) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    document.querySelectorAll('.bottom-nav-item').forEach((b) => {
      const key = b.dataset.viewTarget || b.dataset.scrollTarget;
      b.classList.toggle('active', Boolean(target) && key === target);
    });
  }
  function showPlannerView() {
    altViewEls.forEach((el) => {
      el.hidden = true;
    });
    plannerForm.style.display = '';
    currentViewKey = 'plannerForm';
    syncNavState();
    pushRoute('plannerForm');
  }
  function showAltView(viewEl, param = null) {
    plannerForm.style.display = 'none';
    altViewEls.forEach((el) => {
      el.hidden = el !== viewEl;
    });
    if (viewEl) {
      currentViewKey = viewEl.id;
      pushRoute(viewEl.id, param);
    }
    syncNavState();
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
      targetRow.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
      targetRow.classList.add('study-row-highlight');
      setTimeout(() => targetRow.classList.remove('study-row-highlight'), 1800);
      return;
    }
    if (studyList) studyList.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
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
  // V2-G: the blocks behind linked Board nodes, each tagged with whether it
  // falls on today, so the Board derives In Progress exactly like the
  // Planner. Read-only: two selects, no writes.
  async function loadLinkedScheduleItems(subjectIds) {
    const [items, todaySchedule] = await Promise.all([
      listScheduleItemsForSourceSubjectIds(subjectIds),
      getScheduleForDateIfExists(userId, addDaysToDateStr(tomorrowDateStr(), -1)),
    ]);
    return items.map((i) => ({ ...i, isToday: Boolean(todaySchedule) && i.schedule_id === todaySchedule.id }));
  }

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
    // V2-D: read-only. Lets the Board show each linked node's Planner
    // status; nothing on this path writes to either side.
    getLinkedScheduleItems: (subjectIds) => loadLinkedScheduleItems(subjectIds),
  };
  const boardSection = initBoardSection(userId, boardHostApi);

  // ---------------- Dashboard/Analytics -> existing Planner + Board (Phase 10) ----------------
  // analytics.js never imports data.js/boardData.js directly — it only
  // calls these host functions. Every number it shows is derived read-only
  // from the exact same tables (schedules/schedule_items/study_subjects/
  // boards) every other feature already reads; nothing here writes
  // anything.
  // Shared by Week View and Home's workload card (V2-E) — one fetch shape
  // for "everything planned in a date range", never two.
  // Also returns the user's recurring class series + exceptions (V2-E) so
  // every week-shaped view can project recurring occurrences. Those two
  // reads degrade to [] on failure (e.g. migration 0006 not applied yet)
  // rather than taking the whole view down with them.
  async function getWeekRangeData(startDate, endDate) {
    const schedulesInRange = await listSchedulesInRange(userId, startDate, endDate);
    const scheduleIds = schedulesInRange.map((s) => s.id);
    const softList = (promise, label) => promise.catch((err) => {
      console.error(`Could not load ${label}:`, err);
      return [];
    });
    const [classes, items, dueSubjects, seriesList, exceptions] = await Promise.all([
      listClassesForScheduleIds(scheduleIds),
      listScheduleItemsForScheduleIds(scheduleIds),
      listStudySubjectsDueInRange(userId, startDate, endDate),
      softList(listClassSeries(userId), 'recurring classes'),
      softList(listClassSeriesExceptions(userId), 'recurring class exceptions'),
    ]);
    return { schedules: schedulesInRange, classes, items, dueSubjects, seriesList, exceptions };
  }

  const analyticsHostApi = {
    getTodayDateStr: () => addDaysToDateStr(tomorrowDateStr(), -1),
    getWeekRangeData,
    // V2-E Insights: tasks due in [startDate, endDate] plus the study blocks
    // placed for them (by source_subject_id, wherever they were scheduled),
    // so overdue work can be measured with real remaining minutes. Read-only.
    getDueTasksWithBlocks: async (startDate, endDate) => {
      const subjects = await listStudySubjectsDueInRange(userId, startDate, endDate);
      const items = await listScheduleItemsForSourceSubjectIds(subjects.map((s) => s.id));
      return { subjects, items };
    },
    openInsights: () => activateView('insightsView'),
    openDateInPlanner: (dateStr) => openPlannerForDate(dateStr),
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

  // ---------------- Week View -> existing Planner data (V2-A) ----------------
  // week.js never imports data.js directly — it only calls these host
  // functions. Entirely read-only: every number it shows comes from the
  // exact same schedules/classes/schedule_items/study_subjects rows the
  // Planner/Analytics already read, via the exact same
  // listSchedulesInRange/listClassesForScheduleIds/
  // listScheduleItemsForScheduleIds helpers Analytics' getWeekData already
  // uses above, plus the new bounded listStudySubjectsDueInRange for
  // deadlines. The only "write-shaped" action is openDateInPlanner, which
  // is really just a navigation shortcut into the EXACT same
  // loadScheduleForDate the date picker/Prev/Next buttons already call —
  // never a second schedule loader.
  function openPlannerForDate(dateStr) {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    const plannerNavBtn = document.querySelector('.nav-item[data-scroll-target="plannerForm"]');
    if (plannerNavBtn) plannerNavBtn.classList.add('active');
    showPlannerView();
    loadScheduleForDate(dateStr);
  }
  const weekHostApi = {
    getTodayDateStr: () => addDaysToDateStr(tomorrowDateStr(), -1),
    getWeekRangeData,
    openDateInPlanner: openPlannerForDate,
  };
  const weekSection = initWeekSection(userId, weekHostApi);
  // V2-E: the Calendar page's agenda needs exactly what Week View needs
  // (today, the week-range fetch, open-a-date), so it shares that bridge.
  const agendaSection = initAgendaSection(userId, weekHostApi);

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
        // V2-E: tagged 'imported' so the Calendar page can show/filter
        // external events separately from hand-typed classes.
        const created = await insertClass(targetSchedule.id, userId, { ...fieldsList[i], source: 'imported' }, baseSortOrder + i);
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
      target.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
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

  // V2-E: Import/Export moved from the Planner onto the Calendar page.
  async function openCalendarCard(cardId) {
    await activateView('calendarView');
    const card = document.getElementById(cardId);
    if (card) card.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  }

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
    settingsOpenCalendarBtn.addEventListener('click', () => openCalendarCard('calendarExportCard'));
  }

  // ---------------- Settings tabs, Planner summary, Data export (V2-F) ----------------
  // One panel visible at a time (progressive disclosure, not one long page).
  // Arrow keys move between tabs per the WAI-ARIA tabs pattern.
  const settingsTabButtons = Array.from(document.querySelectorAll('.settings-tab'));
  function selectSettingsTab(key, { focus = false } = {}) {
    settingsTabButtons.forEach((tab) => {
      const on = tab.dataset.settingsTab === key;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
      const panel = document.getElementById(`settingsPanel-${tab.dataset.settingsTab}`);
      if (panel) panel.hidden = !on;
    });
    if (key === 'planner') renderSettingsPrefsSummary();
  }
  settingsTabButtons.forEach((tab, index) => {
    tab.addEventListener('click', () => selectSettingsTab(tab.dataset.settingsTab));
    tab.addEventListener('keydown', (e) => {
      const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        const target = settingsTabButtons[e.key === 'Home' ? 0 : settingsTabButtons.length - 1];
        selectSettingsTab(target.dataset.settingsTab, { focus: true });
        return;
      }
      if (!delta) return;
      e.preventDefault();
      const next = settingsTabButtons[(index + delta + settingsTabButtons.length) % settingsTabButtons.length];
      selectSettingsTab(next.dataset.settingsTab, { focus: true });
    });
  });

  // Read-only summary of the Planner's current day preferences — the same
  // fields and formatting Planning presets already preview, never a second
  // set of "global defaults" that wouldn't actually be used.
  const settingsPrefsSummaryEl = document.getElementById('settingsPrefsSummary');
  function renderSettingsPrefsSummary() {
    if (!settingsPrefsSummaryEl) return;
    const prefs = currentSchedulePrefs();
    settingsPrefsSummaryEl.innerHTML = '';
    ['preferred_study_period', 'session_cap_minutes', 'switch_break_minutes', 'min_block_minutes', 'max_daily_study_minutes'].forEach((field) => {
      const dt = document.createElement('dt');
      dt.textContent = t(PREF_LABEL_KEYS[field]);
      const dd = document.createElement('dd');
      dd.textContent = formatPrefValue(field, prefs[field]);
      settingsPrefsSummaryEl.appendChild(dt);
      settingsPrefsSummaryEl.appendChild(dd);
    });
    if (schedule) {
      const dt = document.createElement('dt');
      dt.textContent = t('settings.prefsForDate');
      const dd = document.createElement('dd');
      dd.textContent = formatDateLabel(schedule.for_date);
      settingsPrefsSummaryEl.prepend(dd);
      settingsPrefsSummaryEl.prepend(dt);
    }
  }
  const settingsOpenTemplatesBtn = document.getElementById('settingsOpenTemplatesBtn');
  if (settingsOpenTemplatesBtn) {
    settingsOpenTemplatesBtn.addEventListener('click', () => {
      jumpFromSettingsToPlanner('plannerForm');
      openQuickTemplatesModal();
    });
  }

  const settingsExportBtn = document.getElementById('settingsExportDataBtn');
  const settingsExportStatusEl = document.getElementById('settingsExportStatus');
  if (settingsExportBtn) {
    settingsExportBtn.addEventListener('click', async () => {
      settingsExportBtn.disabled = true;
      if (settingsExportStatusEl) {
        settingsExportStatusEl.hidden = false;
        settingsExportStatusEl.classList.remove('hint-error');
        settingsExportStatusEl.textContent = t('settings.exportPreparing');
      }
      try {
        const { tables, errors } = await fetchAllUserDataForExport(userId, EXPORT_TABLES);
        const payload = buildExportPayload({ tables, errors, exportedAt: new Date().toISOString() });
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = buildExportFilename(addDaysToDateStr(tomorrowDateStr(), -1));
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        if (settingsExportStatusEl) {
          let msg = tCount('settings.exportDone', totalExportedRows(payload));
          if (payload.skipped.length > 0) msg += ` ${t('settings.exportSkipped').replace('{tables}', payload.skipped.map((x) => x.table).join(', '))}`;
          settingsExportStatusEl.textContent = msg;
        }
      } catch (err) {
        console.error('Could not export data:', err);
        if (settingsExportStatusEl) {
          settingsExportStatusEl.classList.add('hint-error');
          settingsExportStatusEl.textContent = t('settings.exportFailed');
        }
      } finally {
        settingsExportBtn.disabled = false;
      }
    });
  }

  const settingsSection = { onShow: () => syncSettingsControls() };

  const v3Sections = initV3Sections();
  const altViewSections = {
    boardView: boardSection,
    weekView: weekSection,
    calendarView: agendaSection,
    analyticsView: analyticsSection,
    insightsView: analyticsSection ? { onShow: () => analyticsSection.onShowInsights() } : null,
    settingsView: settingsSection,
    historyView: { onShow: () => refreshHistoryList() },
    ...v3Sections,
  };
  async function activateView(key, param = null) {
    if (key === 'plannerForm') {
      activatePlannerScroll('plannerForm');
      return;
    }
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    const navBtn = document.querySelector(`.nav-item[data-view-target="${key}"]`);
    if (navBtn) navBtn.classList.add('active');
    const viewEl = document.getElementById(key);
    if (!viewEl) return;
    const switching = viewEl.hidden;
    showAltView(viewEl, param);
    if (switching) window.scrollTo(0, 0);
    const section = altViewSections[key];
    if (section && typeof section.onShow === 'function') await section.onShow(param);
  }
  document.querySelectorAll('.nav-item[data-view-target], .bottom-nav-item[data-view-target]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activateView(btn.dataset.viewTarget);
      document.getElementById('mainContent')?.focus({ preventScroll: true });
    });
  });
  document.querySelectorAll('.bottom-nav-item[data-scroll-target]').forEach((btn) => {
    btn.addEventListener('click', () => activatePlannerScroll(btn.dataset.scrollTarget));
  });

  // Browser Back/Forward between pages (V3 hash routes).
  onRouteChange((route) => activateView(route.view, route.param));

  // Re-render whichever page is showing (used after a language switch).
  function rerenderCurrentView() {
    if (currentViewKey === 'plannerForm') return;
    const section = altViewSections[currentViewKey];
    const route = parseHash(location.hash);
    if (section && typeof section.onShow === 'function') section.onShow(route && route.view === currentViewKey ? route.param : null);
  }

  setAppContext({
    userId,
    displayName,
    isDemo: IS_DEMO,
    navigate: (view, param = null) => activateView(view, param),
    openCourse: (courseId) => activateView('coursesView', courseId),
    openPlannerForDate: (dateStr) => openPlannerForDate(dateStr),
    plannerDate: () => (schedule ? schedule.for_date : null),
    refreshPlanner: () => {
      if (schedule) loadScheduleForDate(schedule.for_date);
    },
    openQuickAdd: () => commandPalette.open('create'),
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
  document.getElementById('bottomNavMore')?.addEventListener('click', () => {
    if (sidebarEl) sidebarEl.classList.add('sidebar-open');
    if (sidebarScrim) sidebarScrim.hidden = false;
    sidebarEl?.querySelector('.nav-item')?.focus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sidebarEl && sidebarEl.classList.contains('sidebar-open')) closeSidebar();
  });
  document.querySelectorAll('.nav-item').forEach((btn) => btn.addEventListener('click', closeSidebar));

  // ---------------- Home Quick Actions (Checkpoint B) ----------------
  // Every action reuses an EXISTING control/handler — nothing here creates
  // a second "add study task"/"create board"/"import calendar" flow.
  const qaAddTaskBtn = document.getElementById('homeQaAddTask');
  if (qaAddTaskBtn) {
    qaAddTaskBtn.addEventListener('click', () => {
      activatePlannerScroll('plannerForm');
      document.getElementById('addStudyBtn').click(); // exact same handler a manual click already uses
      studyList.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
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
  if (qaImportCalendarBtn) qaImportCalendarBtn.addEventListener('click', () => openCalendarCard('calendarImportCard'));

  // ---------------- Command palette (Ctrl/Cmd+K) + Quick Add (V2-F) ----------------
  // Every command's run() calls an EXISTING handler — the same button
  // clicks/view switches the rest of the app already uses — so neither the
  // palette nor Quick Add is a second way of creating anything.
  function quickAddStudyTask() {
    activatePlannerScroll('plannerForm');
    document.getElementById('addStudyBtn').click();
    studyList.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  }
  function quickAddClass() {
    activatePlannerScroll('plannerForm');
    document.getElementById('addClassBtn').click();
    const classListEl = document.getElementById('classList');
    if (classListEl) classListEl.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
  }
  function quickAddRecurringClass() {
    activatePlannerScroll('recurringClassesCard');
    const btn = document.getElementById('addRecurringSeriesBtn');
    if (btn) btn.click();
  }
  async function quickNewBoard() {
    if (qaNewBoardBtn) qaNewBoardBtn.click();
  }
  async function quickAddBoardNode() {
    await activateView('boardView');
    const addNodeBtn = document.getElementById('boardAddNodeBtn');
    // No board yet -> the Board's own "create a board" flow comes first.
    if (addNodeBtn && addNodeBtn.offsetParent) addNodeBtn.click();
    else if (qaNewBoardBtn) qaNewBoardBtn.click();
  }
  function focusTaskSearch() {
    activatePlannerScroll('studyList');
    const searchInput = document.getElementById('taskSearchInput');
    if (searchInput) {
      const details = searchInput.closest('details');
      if (details) details.open = true;
      searchInput.focus({ preventScroll: true });
    }
  }
  // Reveals a task row on the date already open in the Planner (no date
  // change, unlike goToPlannerStudyList's "plan today's task" behavior).
  function revealStudyRow(taskId) {
    activatePlannerScroll('studyList');
    const row = findStudyRow(taskId);
    if (!row) return;
    row.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
    row.classList.add('study-row-highlight');
    setTimeout(() => row.classList.remove('study-row-highlight'), 1800);
  }

  function buildPaletteCommands(mode) {
    const create = [
      { id: 'add-task', group: 'create', title: t('palette.addTask'), keywords: ['study', 'subject', 'new task'], run: quickAddStudyTask },
      { id: 'add-class', group: 'create', title: t('palette.addClass'), keywords: ['lecture', 'course'], run: quickAddClass },
      { id: 'add-recurring', group: 'create', title: t('palette.addRecurringClass'), keywords: ['repeat', 'weekly', 'class'], run: quickAddRecurringClass },
      { id: 'new-board', group: 'create', title: t('palette.newBoard'), keywords: ['project'], run: quickNewBoard },
      { id: 'add-node', group: 'create', title: t('palette.addBoardNode'), keywords: ['board', 'card', 'node'], run: quickAddBoardNode },
    ];
    if (mode === 'create') return create;

    const go = (id, titleKey, run, keywords = []) => ({ id, group: 'navigate', title: t(titleKey), keywords, run });
    const navigate = [
      go('search-tasks', 'palette.searchTasks', focusTaskSearch, ['find', 'filter']),
      go('open-home', 'palette.openHome', () => activateView('analyticsView'), ['dashboard']),
      go('open-planner', 'palette.openPlanner', () => activatePlannerScroll('plannerForm'), ['today', 'schedule', 'plan']),
      go('open-week', 'palette.openWeek', () => activateView('weekView'), ['week view']),
      go('open-board', 'palette.openBoard', () => activateView('boardView'), ['boards', 'projects']),
      go('open-calendar', 'palette.openCalendar', () => activateView('calendarView'), ['agenda', 'events']),
      go('import-calendar', 'palette.importCalendar', () => openCalendarCard('calendarImportCard'), ['ics', 'google']),
      go('open-history', 'palette.openHistory', () => activateView('historyView'), ['past']),
      go('open-insights', 'palette.openInsights', () => activateView('insightsView'), ['analytics', 'stats']),
      go('open-settings', 'palette.openSettings', () => activateView('settingsView'), ['preferences', 'theme', 'notifications']),
    ];

    // The date open in the Planner's own tasks, searchable by name.
    const dateHint = schedule ? formatDateLabel(schedule.for_date) : '';
    const tasks = buildSubjectsInput()
      .filter((s) => s.id && s.name)
      .map((s) => ({ id: `task-${s.id}`, group: 'tasks', title: s.name, hint: dateHint, run: () => revealStudyRow(s.id) }));

    return [...create, ...navigate, ...tasks];
  }

  const commandPalette = initCommandPalette({ getCommands: buildPaletteCommands, t });
  const paletteShortcutHintEl = document.getElementById('paletteShortcutHint');
  if (paletteShortcutHintEl && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '')) {
    paletteShortcutHintEl.textContent = '⌘K';
  }
  document.addEventListener('keydown', (e) => {
    if (!isPaletteShortcut(e)) return;
    e.preventDefault();
    if (commandPalette.isOpen()) commandPalette.close();
    else commandPalette.open('all');
  });
  document.querySelectorAll('[data-open-palette]').forEach((btn) => {
    btn.addEventListener('click', () => {
      closeSidebar();
      commandPalette.open(btn.dataset.openPalette === 'create' ? 'create' : 'all');
    });
  });
  document.querySelectorAll('[data-open-quickadd]').forEach((btn) => {
    btn.addEventListener('click', () => {
      closeSidebar();
      appContextQuickAdd();
    });
  });
  function appContextQuickAdd() {
    // Replaced by the V3 Quick Add sheet once it is registered (V3-R).
    commandPalette.open('create');
  }

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
    // V3 views cache task/schedule reads; any Planner write makes them stale.
    invalidateCache('tasks');
    invalidateCache('schedules');
    invalidateCache('series');
    saveStatus.textContent = t('common.saved');
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

  // "45 min" / "45 分钟" / "45 分" (V2-G translation audit).
  function minText(n) {
    return `${n} ${t('units.min')}`;
  }

  async function loadSubtasksSoft(subjectIds) {
    try {
      return await listSubtasksForSubjectIds(subjectIds);
    } catch (err) {
      console.error('Could not load subtasks:', err);
      return [];
    }
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
  const maxDailyStudyEl = document.getElementById('maxDailyStudyMinutes');

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
    // formatClock adds the translated "(next day)" for times past midnight.
    hintEl.textContent = t('planner.dayLengthHint')
      .replace('{start}', formatClock(wake))
      .replace('{end}', formatClock(sleep))
      .replace('{total}', durText) + (total < 60 ? t('planner.dayTooShortSuffix') : '');
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
    // Optional (V2-B) — unlike the three fields above, a blank value here is
    // a valid, meaningful choice ("no daily limit"), not an incomplete row,
    // so it never blocks the rest of this save.
    const maxDailyStudyRaw = maxDailyStudyEl ? parseInt(maxDailyStudyEl.value, 10) : NaN;
    return {
      preferred_study_period: preferredPeriodEl.value,
      session_cap_minutes: sessionCap,
      switch_break_minutes: breakMinutes,
      min_block_minutes: minBlock,
      earliest_study_time: earliestStudyEl.value || null,
      latest_study_time: latestStudyEl.value || null,
      max_daily_study_minutes: Number.isFinite(maxDailyStudyRaw) && maxDailyStudyRaw > 0 ? maxDailyStudyRaw : null,
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
  daySettingsForm.addEventListener('change', () => refreshConflictPanel());
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
    max_daily_study_minutes: 'prefs.maxDailyStudy',
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
      max_daily_study_minutes: maxDailyStudyEl ? parseInt(maxDailyStudyEl.value, 10) || null : null,
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
      if ('max_daily_study_minutes' in patch && maxDailyStudyEl) maxDailyStudyEl.value = patch.max_daily_study_minutes || '';
      updateDayLengthHint();
      closeQuickTemplatesModal();
      flashSaved();
    } catch (err) {
      console.error('Could not apply quick template:', err);
      flashError(t('errors.couldNotApplyTemplate'));
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
      <input type="text" class="class-name" data-i18n-aria-label="classes.nameLabel" aria-label="${escapeAttr(t('classes.nameLabel'))}" data-i18n-placeholder="classes.namePlaceholder" placeholder="${escapeAttr(t('classes.namePlaceholder'))}" value="${escapeAttr(row.name || '')}">
      <div class="cls-time-group">
        <input type="time" class="class-start" data-i18n-aria-label="classes.startLabel" aria-label="${escapeAttr(t('classes.startLabel'))}" value="${toHHMM(row.start_time)}">
        <span class="cls-time-sep">–</span>
        <input type="time" class="class-end" data-i18n-aria-label="classes.endLabel" aria-label="${escapeAttr(t('classes.endLabel'))}" value="${toHHMM(row.end_time)}">
      </div>
      <button class="remove-btn" type="button" data-i18n-title="common.remove" title="${escapeAttr(t('common.remove'))}" data-i18n-aria-label="common.remove" aria-label="${escapeAttr(t('common.remove'))}"><span aria-hidden="true">✕</span></button>
    `;
    el.querySelector('.remove-btn').addEventListener('click', () => {
      el.remove();
      updatePlannerHeader();
      refreshConflictPanel();
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

  classList.addEventListener('change', () => refreshConflictPanel());
  classList.addEventListener('change', (e) => {
    const row = e.target.closest('.entry-row');
    if (!row) return;
    // A recurring occurrence's name/start/end inputs are readonly (never
    // user-editable directly — "Edit just today" below is the only path
    // that changes one), so this should never actually fire for one. The
    // guard exists anyway so a recurring row can never be mistaken for an
    // ad-hoc class and INSERTed as a duplicate `classes` row.
    if (row.classList.contains('recurring-class-row')) return;
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

  // ---------------- Recurring Classes (V2-B) ----------------
  // class_series/class_series_exceptions are user-scoped, not tied to any
  // one schedule_id (a series spans many dates) — loaded once here and
  // kept as in-memory arrays, mutated directly after each CRUD success
  // (push/splice/replace), same convention src/board/board.js already uses
  // for its own nodes/edges arrays. buildEffectiveClassesForDate (pure,
  // from recurringClasses.js) is the ONLY thing that decides which
  // recurring occurrences show up on a given date — it never writes
  // anything, so merely viewing/reloading a date can never create a
  // duplicate `classes` row. The only writes here are: a class_series row
  // (create/edit/delete the whole recurrence) or a
  // class_series_exceptions row (skip/edit exactly one occurrence).
  let classSeriesList = [];
  let classSeriesExceptions = [];
  let seriesFormEditingId = null; // null = closed, 'new' = creating, or an existing series id = editing it

  const DAY_PICKER_ORDER = [
    { value: 1, key: 'recurring.dayMon' },
    { value: 2, key: 'recurring.dayTue' },
    { value: 3, key: 'recurring.dayWed' },
    { value: 4, key: 'recurring.dayThu' },
    { value: 5, key: 'recurring.dayFri' },
    { value: 6, key: 'recurring.daySat' },
    { value: 0, key: 'recurring.daySun' },
  ];

  async function loadRecurringClassesData() {
    try {
      [classSeriesList, classSeriesExceptions] = await Promise.all([listClassSeries(userId), listClassSeriesExceptions(userId)]);
    } catch (e) {
      console.error(e);
      classSeriesList = [];
      classSeriesExceptions = [];
    }
    renderRecurringSeriesList();
  }

  function formatSeriesSummary(series) {
    const days = normalizeDaysOfWeek(series.days_of_week);
    const dayLabels = DAY_PICKER_ORDER.filter((d) => days.includes(d.value)).map((d) => t(d.key));
    const timeLabel = `${formatClock(timeToMinutes(series.start_time))} – ${formatClock(timeToMinutes(series.end_time))}`;
    const dateLabel = `${formatDateLabel(series.start_date)} – ${formatDateLabel(series.end_date)}`;
    return `${dayLabels.join(', ')} · ${timeLabel} · ${dateLabel}`;
  }

  const recurringSeriesListEl = document.getElementById('recurringSeriesList');
  const recurringStatusEl = document.getElementById('recurringStatus');

  function setRecurringStatus(text) {
    if (!recurringStatusEl) return;
    recurringStatusEl.textContent = text || '';
    recurringStatusEl.hidden = !text;
  }

  function renderRecurringSeriesList() {
    if (!recurringSeriesListEl) return;
    if (classSeriesList.length === 0) {
      recurringSeriesListEl.innerHTML = `<p class="hint">${escapeAttr(t('recurring.emptyState'))}</p>`;
      return;
    }
    recurringSeriesListEl.innerHTML = classSeriesList
      .map(
        (series) => `
        <div class="recurring-series-row" data-series-id="${escapeAttr(series.id)}">
          <div class="recurring-series-info">
            <span class="recurring-series-name">${escapeAttr(series.name)}</span>
            <span class="recurring-series-meta">${escapeAttr(formatSeriesSummary(series))}</span>
          </div>
          <div class="recurring-series-actions">
            <button type="button" class="edit-btn recurring-series-edit-btn">${escapeAttr(t('recurring.editButton'))}</button>
            <button type="button" class="edit-btn recurring-series-delete-btn">${escapeAttr(t('recurring.deleteButton'))}</button>
          </div>
        </div>`
      )
      .join('');
  }

  if (recurringSeriesListEl) {
    recurringSeriesListEl.addEventListener('click', (e) => {
      const row = e.target.closest('.recurring-series-row');
      if (!row) return;
      const series = classSeriesList.find((s) => s.id === row.dataset.seriesId);
      if (!series) return;
      if (e.target.closest('.recurring-series-edit-btn')) openSeriesForm(series);
      else if (e.target.closest('.recurring-series-delete-btn')) handleDeleteSeries(series);
    });
  }

  function renderSeriesForm() {
    const slot = document.getElementById('recurringSeriesFormSlot');
    if (!slot) return;
    if (!seriesFormEditingId) {
      slot.innerHTML = '';
      return;
    }
    const editing = seriesFormEditingId !== 'new' ? classSeriesList.find((s) => s.id === seriesFormEditingId) : null;
    const defaults = editing || { name: '', days_of_week: [], start_time: '', end_time: '', start_date: forDateEl.value || todayDateStr(), end_date: '' };
    const selectedDays = normalizeDaysOfWeek(defaults.days_of_week);
    const daysHtml = DAY_PICKER_ORDER.map(
      (d) =>
        `<button type="button" class="recurring-day-btn${selectedDays.includes(d.value) ? ' active' : ''}" data-day="${d.value}">${escapeAttr(t(d.key))}</button>`
    ).join('');

    slot.innerHTML = `
      <div class="edit-panel recurring-series-form">
        <p class="hint task-section-label">${escapeAttr(editing ? t('recurring.editTitle') : t('recurring.newTitle'))}</p>
        <div class="recurring-series-form-row">
          <label>${escapeAttr(t('recurring.nameLabel'))}
            <input type="text" class="recurring-name-input" value="${escapeAttr(defaults.name)}">
          </label>
        </div>
        <p class="hint task-section-label">${escapeAttr(t('recurring.daysLabel'))}</p>
        <div class="recurring-day-picker">${daysHtml}</div>
        <div class="recurring-series-form-row">
          <label>${escapeAttr(t('recurring.startTimeLabel'))}
            <input type="time" class="recurring-start-time-input" value="${toHHMM(defaults.start_time)}">
          </label>
          <label>${escapeAttr(t('recurring.endTimeLabel'))}
            <input type="time" class="recurring-end-time-input" value="${toHHMM(defaults.end_time)}">
          </label>
        </div>
        <div class="recurring-series-form-row">
          <label>${escapeAttr(t('recurring.startDateLabel'))}
            <input type="date" class="recurring-start-date-input" value="${escapeAttr(defaults.start_date || '')}">
          </label>
          <label>${escapeAttr(t('recurring.endDateLabel'))}
            <input type="date" class="recurring-end-date-input" value="${escapeAttr(defaults.end_date || '')}">
          </label>
        </div>
        <div class="edit-error" id="recurringSeriesFormError"></div>
        <div class="edit-actions">
          <button type="button" class="edit-save-btn" id="recurringSeriesSaveBtn">${escapeAttr(t('recurring.saveButton'))}</button>
          <button type="button" id="recurringSeriesCancelBtn">${escapeAttr(t('recurring.cancelButton'))}</button>
        </div>
      </div>
    `;

    slot.querySelectorAll('.recurring-day-btn').forEach((btn) => {
      btn.addEventListener('click', () => btn.classList.toggle('active'));
    });
    document.getElementById('recurringSeriesCancelBtn').addEventListener('click', closeSeriesForm);
    document.getElementById('recurringSeriesSaveBtn').addEventListener('click', handleSaveSeries);
  }

  function openSeriesForm(series) {
    seriesFormEditingId = series ? series.id : 'new';
    if (recurringClassesCardEl) recurringClassesCardEl.open = true;
    renderSeriesForm();
  }
  function closeSeriesForm() {
    seriesFormEditingId = null;
    renderSeriesForm();
  }

  async function handleSaveSeries() {
    const slot = document.getElementById('recurringSeriesFormSlot');
    const errorEl = document.getElementById('recurringSeriesFormError');
    const saveBtn = document.getElementById('recurringSeriesSaveBtn');
    const selectedDays = Array.from(slot.querySelectorAll('.recurring-day-btn.active')).map((b) => parseInt(b.dataset.day, 10));
    const fields = buildSeriesFields({
      name: slot.querySelector('.recurring-name-input').value,
      daysOfWeek: selectedDays,
      startTime: slot.querySelector('.recurring-start-time-input').value,
      endTime: slot.querySelector('.recurring-end-time-input').value,
      startDate: slot.querySelector('.recurring-start-date-input').value,
      endDate: slot.querySelector('.recurring-end-date-input').value,
    });
    const seriesValidation = validateSeriesFields(fields);
    if (!seriesValidation.valid) {
      errorEl.textContent = tMessage(seriesValidation);
      return;
    }
    errorEl.textContent = '';
    saveBtn.disabled = true;
    try {
      if (seriesFormEditingId && seriesFormEditingId !== 'new') {
        const updated = await updateClassSeries(seriesFormEditingId, fields);
        const idx = classSeriesList.findIndex((s) => s.id === seriesFormEditingId);
        if (idx !== -1) classSeriesList[idx] = updated;
      } else {
        const created = await createClassSeries(userId, fields);
        classSeriesList.push(created);
      }
      closeSeriesForm();
      renderRecurringSeriesList();
      await refreshClassListForCurrentDate();
    } catch (e) {
      console.error(e);
      errorEl.textContent = t('recurring.saveError');
      saveBtn.disabled = false;
    }
  }

  async function handleDeleteSeries(series) {
    if (!window.confirm(t('recurring.deleteConfirm'))) return;
    setRecurringStatus('');
    try {
      await deleteClassSeries(series.id);
      classSeriesList = classSeriesList.filter((s) => s.id !== series.id);
      classSeriesExceptions = classSeriesExceptions.filter((e) => e.series_id !== series.id);
      renderRecurringSeriesList();
      await refreshClassListForCurrentDate();
    } catch (e) {
      console.error(e);
      setRecurringStatus(t('recurring.deleteError'));
    }
  }

  // Rebuilds the Classes list for whichever date is currently loaded,
  // re-reading this date's ad-hoc `classes` rows fresh and re-merging them
  // with the (already in-memory, just-changed) recurring series —
  // the exact same buildEffectiveClassesForDate projection
  // loadScheduleForDate uses on a normal date switch, called again here so
  // a series/exception change is reflected immediately without requiring
  // the student to leave and revisit the date.
  function renderClassListRows(adHocClasses) {
    const effective = buildEffectiveClassesForDate({
      adHocClasses,
      seriesList: classSeriesList,
      exceptions: classSeriesExceptions,
      dateStr: schedule.for_date,
    });
    effective.forEach((entry) => {
      if (entry.source === 'recurring') addRecurringClassRow(entry);
      else addClassRow(entry);
    });
  }

  async function refreshClassListForCurrentDate() {
    if (!schedule) return;
    let adHocClasses;
    try {
      adHocClasses = await listClasses(schedule.id);
    } catch (e) {
      console.error(e);
      return;
    }
    classList.innerHTML = '';
    renderClassListRows(adHocClasses);
  }

  // A recurring occurrence's row: readonly name/start/end (editing means
  // either "just today" — a class_series_exceptions row — or "the whole
  // recurrence," which lives in the Recurring Classes card above, never an
  // ad-hoc `classes` row). `.planner-more-menu`/`.planner-more-dropdown`/
  // `.planner-more-item` are the exact same classes the Planner's own
  // toolbar "More ▾" menu already uses — reused as-is rather than a second
  // dropdown implementation.
  function addRecurringClassRow(occurrence) {
    const el = document.createElement('div');
    el.className = 'entry-row recurring-class-row';
    el.dataset.seriesId = occurrence.seriesId;
    const badgeKey = occurrence.isModified ? 'recurring.editedBadge' : 'recurring.badge';
    const badgeClass = occurrence.isModified ? ' recurring-badge-modified' : '';
    el.innerHTML = `
      <input type="text" class="class-name" readonly data-i18n-aria-label="classes.nameLabel" aria-label="${escapeAttr(t('classes.nameLabel'))}" value="${escapeAttr(occurrence.name)}">
      <div class="cls-time-group">
        <input type="time" class="class-start" readonly data-i18n-aria-label="classes.startLabel" aria-label="${escapeAttr(t('classes.startLabel'))}" value="${toHHMM(occurrence.start_time)}">
        <span class="cls-time-sep">–</span>
        <input type="time" class="class-end" readonly data-i18n-aria-label="classes.endLabel" aria-label="${escapeAttr(t('classes.endLabel'))}" value="${toHHMM(occurrence.end_time)}">
      </div>
      <span class="recurring-badge${badgeClass}">${escapeAttr(t(badgeKey))}</span>
      <details class="planner-more-menu recurring-row-menu">
        <summary class="planner-more-btn" title="${escapeAttr(t('recurring.moreActions'))}" aria-label="${escapeAttr(t('recurring.moreActions'))}" data-i18n-title="recurring.moreActions" data-i18n-aria-label="recurring.moreActions">⋯</summary>
        <div class="planner-more-dropdown">
          <button type="button" class="planner-more-item recurring-edit-today-btn">${escapeAttr(t('recurring.editToday'))}</button>
          <button type="button" class="planner-more-item recurring-skip-today-btn">${escapeAttr(t('recurring.skipToday'))}</button>
          ${occurrence.isModified ? `<button type="button" class="planner-more-item recurring-revert-today-btn">${escapeAttr(t('recurring.revertToday'))}</button>` : ''}
        </div>
      </details>
      <div class="recurring-edit-today-panel-slot"></div>
    `;

    const menu = el.querySelector('.recurring-row-menu');
    el.querySelector('.recurring-edit-today-btn').addEventListener('click', () => {
      menu.open = false;
      openEditTodayPanel(el, occurrence);
    });
    el.querySelector('.recurring-skip-today-btn').addEventListener('click', () => {
      menu.open = false;
      handleSkipToday(occurrence);
    });
    const revertBtn = el.querySelector('.recurring-revert-today-btn');
    if (revertBtn) {
      revertBtn.addEventListener('click', () => {
        menu.open = false;
        handleRevertToday(occurrence);
      });
    }

    classList.appendChild(el);
    updatePlannerHeader();
    return el;
  }

  function openEditTodayPanel(row, occurrence) {
    const slot = row.querySelector('.recurring-edit-today-panel-slot');
    slot.innerHTML = `
      <div class="edit-panel">
        <label>${escapeAttr(t('recurring.nameLabel'))}
          <input type="text" class="edit-today-name-input" value="${escapeAttr(occurrence.name)}">
        </label>
        <div class="row-2" style="margin-top:6px;">
          <label>${escapeAttr(t('recurring.startTimeLabel'))}
            <input type="time" class="edit-today-start-input" value="${toHHMM(occurrence.start_time)}">
          </label>
          <label>${escapeAttr(t('recurring.endTimeLabel'))}
            <input type="time" class="edit-today-end-input" value="${toHHMM(occurrence.end_time)}">
          </label>
        </div>
        <div class="edit-error edit-today-error"></div>
        <div class="edit-actions">
          <button type="button" class="edit-save-btn edit-today-save-btn">${escapeAttr(t('recurring.saveButton'))}</button>
          <button type="button" class="edit-today-cancel-btn">${escapeAttr(t('recurring.cancelButton'))}</button>
        </div>
      </div>
    `;
    slot.querySelector('.edit-today-cancel-btn').addEventListener('click', () => {
      slot.innerHTML = '';
    });
    slot.querySelector('.edit-today-save-btn').addEventListener('click', async () => {
      const series = classSeriesList.find((s) => s.id === occurrence.seriesId);
      const errorEl = slot.querySelector('.edit-today-error');
      if (!series) return;
      const name = slot.querySelector('.edit-today-name-input').value.trim();
      const startTime = slot.querySelector('.edit-today-start-input').value;
      const endTime = slot.querySelector('.edit-today-end-input').value;
      if (!name || !isValidTimeRange(startTime, endTime)) {
        errorEl.textContent = t('recurring.invalidSeries');
        return;
      }
      errorEl.textContent = '';
      const fields = buildModifyExceptionFields(series, schedule.for_date, { name, startTime, endTime });
      try {
        const saved = await upsertClassSeriesException(userId, fields);
        const idx = classSeriesExceptions.findIndex((e) => e.series_id === series.id && e.exception_date === schedule.for_date);
        if (idx !== -1) classSeriesExceptions[idx] = saved;
        else classSeriesExceptions.push(saved);
        await refreshClassListForCurrentDate();
      } catch (e) {
        console.error(e);
        errorEl.textContent = t('recurring.saveError');
      }
    });
  }

  async function handleSkipToday(occurrence) {
    const fields = buildSkipExceptionFields(occurrence.seriesId, schedule.for_date);
    try {
      const saved = await upsertClassSeriesException(userId, fields);
      const idx = classSeriesExceptions.findIndex((e) => e.series_id === occurrence.seriesId && e.exception_date === schedule.for_date);
      if (idx !== -1) classSeriesExceptions[idx] = saved;
      else classSeriesExceptions.push(saved);
      await refreshClassListForCurrentDate();
    } catch (e) {
      console.error(e);
    }
  }

  async function handleRevertToday(occurrence) {
    const existing = classSeriesExceptions.find((e) => e.series_id === occurrence.seriesId && e.exception_date === schedule.for_date);
    if (!existing) return;
    try {
      await deleteClassSeriesException(existing.id);
      classSeriesExceptions = classSeriesExceptions.filter((e) => e.id !== existing.id);
      await refreshClassListForCurrentDate();
    } catch (e) {
      console.error(e);
    }
  }

  const recurringClassesCardEl = document.getElementById('recurringClassesCard');
  const manageRecurringBtn = document.getElementById('manageRecurringBtn');
  if (manageRecurringBtn && recurringClassesCardEl) {
    manageRecurringBtn.addEventListener('click', () => {
      recurringClassesCardEl.open = true;
      openSeriesForm(null);
      recurringClassesCardEl.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
    });
  }
  const addRecurringSeriesBtn = document.getElementById('addRecurringSeriesBtn');
  if (addRecurringSeriesBtn) addRecurringSeriesBtn.addEventListener('click', () => openSeriesForm(null));

  // ---------------- study subjects ----------------
  const studyList = document.getElementById('studyList');

  // ---------------- Tags + Subtasks (V2-A) ----------------
  // tags live on the row's own dataset (same convention as dataset.id /
  // dataset.originId) so they ride along with the row exactly like every
  // other field read by readSubjectRowData/buildSubjectsInput; subtasks are
  // kept as a plain array attached directly to the row element (el._subtasks),
  // the same "attach plain data onto the thing that already represents it"
  // convention applyStudySortOrder below already uses (task._row).

  const PRESET_TAG_LABEL_KEYS = {
    Exam: 'study.tagExam',
    Homework: 'study.tagHomework',
    Reading: 'study.tagReading',
    Project: 'study.tagProject',
    Review: 'study.tagReview',
  };
  function tagDisplayLabel(tag) {
    const key = PRESET_TAG_LABEL_KEYS[tag];
    return key ? t(key) : tag;
  }

  function readRowTags(el) {
    try {
      return normalizeTagList(JSON.parse(el.dataset.tags || '[]'));
    } catch {
      return [];
    }
  }
  function writeRowTags(el, tags) {
    el.dataset.tags = JSON.stringify(normalizeTagList(tags));
  }

  function renderTagsChips(el) {
    const container = el.querySelector('.task-tags-chips');
    if (!container) return;
    const tags = readRowTags(el);
    const allChipValues = Array.from(new Set([...PRESET_TASK_TAGS, ...tags]));
    container.innerHTML = allChipValues
      .map((tagValue) => {
        const active = tags.includes(tagValue);
        return `<button type="button" class="task-tag-chip${active ? ' active' : ''}" data-tag="${escapeAttr(tagValue)}">${escapeAttr(
          tagDisplayLabel(tagValue)
        )}</button>`;
      })
      .join('');
  }

  // Tags on a row that hasn't been saved yet (no dataset.id) are simply left
  // on el.dataset.tags — they ride along automatically the first time the
  // generic save below (studyList's "change" handler) inserts the row,
  // since that handler's `fields` object already includes tags.
  function saveRowTagsIfPersisted(el) {
    if (!el.dataset.id) return;
    chainSave(el, async () => {
      await updateStudySubject(el.dataset.id, { tags: readRowTags(el) });
      flashSaved();
    });
  }

  function renderSubtasksList(el) {
    const listEl = el.querySelector('.task-subtasks-list');
    const subtasks = el._subtasks || [];
    if (listEl) {
      listEl.innerHTML = subtasks
        .map(
          (s) => `
            <div class="task-subtask-row" data-subtask-id="${escapeAttr(s.id)}">
              <input type="checkbox" class="task-subtask-toggle" ${s.completed ? 'checked' : ''}>
              <span class="task-subtask-title${s.completed ? ' task-subtask-done' : ''}">${escapeAttr(s.title)}</span>
              <button type="button" class="task-subtask-remove" data-i18n-title="study.removeSubtask" title="${escapeAttr(t('study.removeSubtask'))}" data-i18n-aria-label="study.removeSubtask" aria-label="${escapeAttr(t('study.removeSubtask'))}"><span aria-hidden="true">✕</span></button>
            </div>`
        )
        .join('');
    }
    const chip = el.querySelector('.task-chip-subtasks');
    if (chip) {
      const { completed, total } = computeSubtaskProgress(subtasks);
      if (total > 0) {
        chip.hidden = false;
        chip.textContent = t('study.subtaskProgress').replace('{completed}', completed).replace('{total}', total);
      } else {
        chip.hidden = true;
      }
    }
  }

  function addStudyRow(row = {}, subtasks = []) {
    const el = document.createElement('div');
    el.className = 'entry-row study';
    if (row.id) el.dataset.id = row.id;
    if (row.origin_subject_id) el.dataset.originId = row.origin_subject_id;
    writeRowTags(el, row.tags);
    const priority = row.priority || 'medium';
    const isChunk = Boolean(row.origin_subject_id);
    const canHaveSubtasks = Boolean(row.id);
    el.innerHTML = `
      <div class="task-row-top">
        <button type="button" class="task-expand-toggle" data-i18n-title="study.expandDetails" title="${escapeAttr(t('study.expandDetails'))}" data-i18n-aria-label="study.expandDetails" aria-label="${escapeAttr(t('study.expandDetails'))}" aria-expanded="false">
          <svg class="task-expand-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
        </button>
        <input type="text" class="study-name" data-i18n-aria-label="study.nameLabel" aria-label="${escapeAttr(t('study.nameLabel'))}" data-i18n-placeholder="study.namePlaceholder" placeholder="${escapeAttr(t('study.namePlaceholder'))}" value="${escapeAttr(row.name || '')}">
        <select class="study-priority" data-i18n-aria-label="study.priorityLabel" aria-label="${escapeAttr(t('study.priorityLabel'))}" data-priority="${priority}">
          <option value="low" data-i18n="taskFilter.priorityLow" ${priority === 'low' ? 'selected' : ''}>${escapeAttr(t('taskFilter.priorityLow'))}</option>
          <option value="medium" data-i18n="taskFilter.priorityMedium" ${priority === 'medium' ? 'selected' : ''}>${escapeAttr(t('taskFilter.priorityMedium'))}</option>
          <option value="high" data-i18n="taskFilter.priorityHigh" ${priority === 'high' ? 'selected' : ''}>${escapeAttr(t('taskFilter.priorityHigh'))}</option>
        </select>
        <button class="remove-btn" type="button" data-i18n-title="common.remove" title="${escapeAttr(t('common.remove'))}" data-i18n-aria-label="common.remove" aria-label="${escapeAttr(t('common.remove'))}"><span aria-hidden="true">✕</span></button>
      </div>
      <div class="task-row-chips">
        <span class="task-chip task-chip-due" hidden></span>
        <span class="task-chip task-chip-remaining" hidden></span>
        <span class="task-chip task-chip-subtasks" hidden></span>
      </div>
      <div class="task-row-details">
        <div class="task-row-meta">
          <label class="task-mini-field">
            <span data-i18n="study.minutesLabel">${escapeAttr(t('study.minutesLabel'))}</span>
            <input type="number" class="study-minutes" min="5" step="5" value="${row.minutes_requested || ''}">
          </label>
          <label class="task-mini-field">
            <span data-i18n="study.dueLabel">${escapeAttr(t('study.dueLabel'))}</span>
            <input type="date" class="study-due" value="${row.due_date || ''}">
          </label>
          ${row.id && !isChunk ? `<button type="button" class="edit-btn plan-days-btn">${escapeAttr(t('multiday.planDaysButton'))}</button>` : ''}
        </div>
        ${isChunk ? `<p class="hint multiday-chunk-hint">${escapeAttr(t('multiday.chunkHint'))}</p>` : ''}
        <input type="text" class="study-notes" data-i18n-aria-label="study.notesLabel" aria-label="${escapeAttr(t('study.notesLabel'))}" data-i18n-placeholder="study.notesPlaceholder" placeholder="${escapeAttr(t('study.notesPlaceholder'))}" value="${escapeAttr(row.notes || '')}">

        <div class="task-tags-section">
          <p class="hint task-section-label">${escapeAttr(t('study.tagsLabel'))}</p>
          <div class="task-tags-chips"></div>
          <div class="task-tags-add">
            <input type="text" class="task-tag-input" placeholder="${escapeAttr(t('study.addCustomTagPlaceholder'))}" maxlength="30">
            <button type="button" class="edit-btn task-tag-add-btn">${escapeAttr(t('study.addTagButton'))}</button>
          </div>
        </div>

        <div class="task-subtasks-section">
          <p class="hint task-section-label">${escapeAttr(t('study.subtasksLabel'))}</p>
          <div class="task-subtasks-list"></div>
          <div class="task-subtasks-add">
            <input type="text" class="task-subtask-input" placeholder="${escapeAttr(t('study.addSubtaskPlaceholder'))}" ${canHaveSubtasks ? '' : 'disabled'}>
            <button type="button" class="edit-btn task-subtask-add-btn" data-i18n-title="study.addSubtaskButton" title="${escapeAttr(t('study.addSubtaskButton'))}" data-i18n-aria-label="study.addSubtaskButton" aria-label="${escapeAttr(t('study.addSubtaskButton'))}" ${canHaveSubtasks ? '' : 'disabled'}><span aria-hidden="true">+</span></button>
          </div>
        </div>

        <div class="multiday-panel-slot"></div>
      </div>
    `;

    const expandBtn = el.querySelector('.task-expand-toggle');
    expandBtn.addEventListener('click', () => {
      const expanded = el.classList.toggle('expanded');
      expandBtn.setAttribute('aria-expanded', String(expanded));
      const labelKey = expanded ? 'study.collapseDetails' : 'study.expandDetails';
      expandBtn.title = t(labelKey);
      expandBtn.setAttribute('aria-label', t(labelKey));
    });

    renderTagsChips(el);
    el.querySelector('.task-tags-chips').addEventListener('click', (e) => {
      const chip = e.target.closest('.task-tag-chip');
      if (!chip) return;
      writeRowTags(el, toggleTag(readRowTags(el), chip.dataset.tag));
      renderTagsChips(el);
      saveRowTagsIfPersisted(el);
    });
    const tagInput = el.querySelector('.task-tag-input');
    function addTagFromInput() {
      if (!tagInput.value.trim()) return;
      writeRowTags(el, addCustomTag(readRowTags(el), tagInput.value));
      tagInput.value = '';
      renderTagsChips(el);
      saveRowTagsIfPersisted(el);
    }
    el.querySelector('.task-tag-add-btn').addEventListener('click', addTagFromInput);
    tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addTagFromInput();
      }
    });

    el._subtasks = (subtasks || []).slice();
    renderSubtasksList(el);
    const subtasksListEl = el.querySelector('.task-subtasks-list');
    subtasksListEl.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.task-subtask-remove');
      if (!removeBtn) return;
      const subtaskId = removeBtn.closest('.task-subtask-row').dataset.subtaskId;
      el._subtasks = el._subtasks.filter((s) => String(s.id) !== subtaskId);
      renderSubtasksList(el);
      deleteSubtask(subtaskId).catch((err) => console.error(err));
    });
    subtasksListEl.addEventListener('change', (e) => {
      const toggle = e.target.closest('.task-subtask-toggle');
      if (!toggle) return;
      const subtaskId = toggle.closest('.task-subtask-row').dataset.subtaskId;
      const subtask = el._subtasks.find((s) => String(s.id) === subtaskId);
      if (!subtask) return;
      subtask.completed = toggle.checked;
      renderSubtasksList(el);
      updateSubtask(subtaskId, { completed: toggle.checked }).catch((err) => console.error(err));
    });
    const subtaskInput = el.querySelector('.task-subtask-input');
    async function addSubtaskFromInput() {
      if (!el.dataset.id || !isValidSubtaskTitle(subtaskInput.value)) return;
      const fields = buildSubtaskFields(subtaskInput.value);
      const sortOrder = nextSubtaskSortOrder(el._subtasks.length);
      subtaskInput.value = '';
      try {
        const created = await insertSubtask(el.dataset.id, userId, fields, sortOrder);
        el._subtasks.push(created);
        renderSubtasksList(el);
      } catch (err) {
        console.error(err);
      }
    }
    el.querySelector('.task-subtask-add-btn').addEventListener('click', addSubtaskFromInput);
    subtaskInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addSubtaskFromInput();
      }
    });

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

  // V2-A: a task's due-date/remaining-time header chips and the active
  // filters both need the exact same per-row data applyStudySortOrder
  // already builds (via buildRowTask) to reorder the list, so this now also
  // refreshes those chips and re-applies the current filters every time it
  // runs — and it already runs on every schedule mutation via
  // renderScheduleEvents (see below), so no new call sites are needed for
  // chips/filters to stay correct.
  function updateTaskHeaderChips(task) {
    const row = task._row;
    const dueChip = row.querySelector('.task-chip-due');
    const remainingChip = row.querySelector('.task-chip-remaining');
    // A blank, just-added row (no name/minutes typed yet) is modeled by
    // buildRowTask as "completed" (nothing to recommend) purely so Smart
    // Priority's sort has something sane to do with it — that's not the
    // same thing as "this task is actually done," so the chips stay hidden
    // entirely until there's a real name to attach a status to.
    const hasContent = Boolean(task.name);
    if (dueChip) {
      const label = hasContent ? formatDueDate(task.dueDate) : null;
      dueChip.textContent = label || '';
      dueChip.hidden = !label;
    }
    // V2-G: the task's status from its own study blocks, same badge as
    // everywhere else; the remaining-time chip now only shows minutes.
    let statusChip = row.querySelector('.task-chip-status');
    if (!statusChip) {
      statusChip = document.createElement('span');
      statusChip.className = 'task-chip-status';
      const chipsEl = row.querySelector('.task-row-chips');
      if (chipsEl) chipsEl.prepend(statusChip);
    }
    if (hasContent) {
      const blocks = currentScheduleItems.filter((i) => i.type === 'study' && (task.id ? i.sourceSubjectId === task.id : i.name === task.name));
      const nowDate = new Date();
      const status = blocks.length > 0
        ? deriveTaskStatus(blocks, { isToday: Boolean(schedule) && schedule.for_date === todayDateStr(), nowMinutes: nowDate.getHours() * 60 + nowDate.getMinutes() })
        : null;
      statusChip.innerHTML = status ? statusBadgeHtml(status, t(statusLabelKey(status)), { compact: true }) : '';
      statusChip.hidden = !status;
    } else {
      statusChip.hidden = true;
    }
    if (remainingChip) {
      if (!hasContent || task.completed) {
        remainingChip.hidden = true;
      } else if (task.remainingMinutes > 0) {
        remainingChip.textContent = t('study.minutesRemaining').replace('{minutes}', task.remainingMinutes);
        remainingChip.hidden = false;
      } else {
        remainingChip.hidden = true;
      }
    }
  }

  function applyStudySortOrder() {
    if (!studyList) return;
    const rows = Array.from(studyList.children);
    if (rows.length === 0) return;
    const availableMinutesToday = computeAvailableStudyMinutes(currentScheduleItems);
    const context = { todayDateStr: schedule ? schedule.for_date : null, availableMinutesToday };
    const tasks = rows.map((row) => ({
      ...buildRowTask(row),
      _row: row,
      tags: readRowTags(row),
      notes: row.querySelector('.study-notes').value,
    }));
    tasks.forEach((task) => updateTaskHeaderChips(task));
    if (taskSortSelect && rows.length >= 2) {
      const ordered = sortTasksForDisplay(tasks, taskSortSelect.value, context);
      ordered.forEach((task) => studyList.appendChild(task._row));
    }
    applyTaskFilters(tasks);
  }

  if (taskSortSelect) taskSortSelect.addEventListener('change', applyStudySortOrder);

  // ---------------- Task filtering + search (V2-A) ----------------
  // Display-only: filterTasks (src/dashboard/taskFilters.js) never mutates
  // the task list or any stored field — matching a filter just toggles
  // `row.hidden` on rows that don't match, the same way applyStudySortOrder
  // reorders rows by relocating the same DOM nodes rather than rebuilding them.
  const taskFilterModesEl = document.getElementById('taskFilterModes');
  const taskSearchInputEl = document.getElementById('taskSearchInput');
  const taskFilterSubjectEl = document.getElementById('taskFilterSubject');
  const taskFilterPriorityEl = document.getElementById('taskFilterPriority');
  const taskFilterTagEl = document.getElementById('taskFilterTag');
  const taskFilterEmptyEl = document.getElementById('taskFilterEmpty');

  let taskFilterState = { mode: 'all', priority: '', tag: '', subjectName: '', query: '' };

  // Rebuilds a <select>'s options from `values` (keeping its existing
  // "any ___" first option, read back from the DOM so its i18n translation
  // is preserved) and restores the previously-selected value if it's still
  // present among `values`, otherwise falls back to "any". Returns the
  // value that ended up selected, so the caller can keep taskFilterState in
  // sync with what the control actually shows.
  function populateFilterOptions(selectEl, values, currentValue) {
    if (!selectEl) return currentValue;
    const anyOption = selectEl.querySelector('option[value=""]');
    const anyOptionHtml = anyOption ? anyOption.outerHTML : '';
    const optionsHtml = values.map((v) => `<option value="${escapeAttr(v)}">${escapeAttr(v)}</option>`).join('');
    selectEl.innerHTML = anyOptionHtml + optionsHtml;
    const keep = values.includes(currentValue) ? currentValue : '';
    selectEl.value = keep;
    return keep;
  }

  function applyTaskFilters(precomputedTasks) {
    if (!studyList) return;
    const tasks =
      precomputedTasks ||
      Array.from(studyList.children).map((row) => ({
        ...buildRowTask(row),
        _row: row,
        tags: readRowTags(row),
        notes: row.querySelector('.study-notes').value,
      }));

    taskFilterState.subjectName = populateFilterOptions(taskFilterSubjectEl, listDistinctSubjectNames(tasks), taskFilterState.subjectName);
    taskFilterState.tag = populateFilterOptions(taskFilterTagEl, listDistinctTags(tasks), taskFilterState.tag);

    const todayDateStr = schedule ? schedule.for_date : null;
    const matched = filterTasks(tasks, taskFilterState, todayDateStr);
    const matchedRows = new Set(matched.map((task) => task._row));
    tasks.forEach((task) => {
      task._row.hidden = !matchedRows.has(task._row);
    });
    if (taskFilterEmptyEl) taskFilterEmptyEl.hidden = !(tasks.length > 0 && matched.length === 0);
  }

  if (taskFilterModesEl) {
    taskFilterModesEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.task-filter-mode');
      if (!btn) return;
      taskFilterModesEl.querySelectorAll('.task-filter-mode').forEach((b) => b.classList.toggle('active', b === btn));
      taskFilterState.mode = btn.dataset.filterMode;
      applyTaskFilters();
    });
  }
  if (taskSearchInputEl) {
    taskSearchInputEl.addEventListener('input', () => {
      taskFilterState.query = taskSearchInputEl.value;
      applyTaskFilters();
    });
  }
  if (taskFilterPriorityEl) {
    taskFilterPriorityEl.addEventListener('change', () => {
      taskFilterState.priority = taskFilterPriorityEl.value;
      applyTaskFilters();
    });
  }
  if (taskFilterSubjectEl) {
    taskFilterSubjectEl.addEventListener('change', () => {
      taskFilterState.subjectName = taskFilterSubjectEl.value;
      applyTaskFilters();
    });
  }
  if (taskFilterTagEl) {
    taskFilterTagEl.addEventListener('change', () => {
      taskFilterState.tag = taskFilterTagEl.value;
      applyTaskFilters();
    });
  }

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
        ? `<div class="edit-error">${escapeAttr(t('multiday.unscheduledWarning'))} ${escapeAttr(minText(unscheduledMinutes))}</div>`
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
        const reloadedSubtasks = await loadSubtasksSoft(reloadedSubjects.map((s) => s.id));
        if (token !== activeToken || !schedule || schedule.id !== scheduleId) return;
        const reloadedSubtasksBySubjectId = new Map();
        reloadedSubtasks.forEach((st) => {
          const list = reloadedSubtasksBySubjectId.get(st.subject_id) || [];
          list.push(st);
          reloadedSubtasksBySubjectId.set(st.subject_id, list);
        });
        studyList.innerHTML = '';
        reloadedSubjects.forEach((s) => addStudyRow(s, reloadedSubtasksBySubjectId.get(s.id) || []));
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
    // handled by its own listener in addStudyRow — skip the generic
    // name/minutes/priority/due/notes save below entirely for this target
    if (e.target.classList.contains('task-subtask-toggle')) return;

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
        tags: readRowTags(row),
      };
      if (row.dataset.id) {
        await updateStudySubject(row.dataset.id, fields);
      } else {
        const sortOrder = Array.from(studyList.children).indexOf(row);
        const created = await insertStudySubject(scheduleId, userId, fields, sortOrder);
        row.dataset.id = created.id;
        const subtaskInput = row.querySelector('.task-subtask-input');
        const subtaskAddBtn = row.querySelector('.task-subtask-add-btn');
        if (subtaskInput) subtaskInput.disabled = false;
        if (subtaskAddBtn) subtaskAddBtn.disabled = false;
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

  // ---------------- V2-C: Focus Mode ----------------
  // A full-screen countdown for one study block. All timer math lives in
  // focusMode.js (timestamp-based, so a backgrounded tab never drifts); the
  // 250ms interval below only re-renders. Ending a session writes through
  // setScheduleItemPartialCompletion — the same call the Partial Completion
  // panel makes — so there is no second completion path to disagree with
  // the Done/Partial buttons.
  const FOCUS_STORAGE_KEY = 'scheduler.focusSession.v1';
  let focusSession = null;
  let focusItem = null;
  let focusOverlay = null;
  let focusTickTimer = null;
  let focusSaving = false;
  let focusPrevTitle = '';

  function storeFocusSession() {
    try {
      if (focusSession) localStorage.setItem(FOCUS_STORAGE_KEY, serializeSession(focusSession));
      else localStorage.removeItem(FOCUS_STORAGE_KEY);
    } catch {
      // storage unavailable — the session just won't survive a reload
    }
  }

  function readStoredFocusSession() {
    try {
      return parseStoredSession(localStorage.getItem(FOCUS_STORAGE_KEY));
    } catch {
      return null;
    }
  }

  function buildFocusOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'focus-overlay';
    overlay.hidden = true;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'focusTaskName');
    overlay.innerHTML = `
      <div class="focus-panel">
        <div class="focus-eyebrow"></div>
        <h2 class="focus-task" id="focusTaskName"></h2>
        <div class="focus-meta"></div>
        <div class="focus-countdown" aria-live="off"></div>
        <div class="focus-status" aria-live="polite"></div>
        <div class="focus-bar" aria-hidden="true"><span class="focus-bar-fill"></span></div>
        <div class="focus-controls">
          <button type="button" class="btn-secondary focus-pause-btn"></button>
          <button type="button" class="focus-complete-btn"></button>
        </div>
        <div class="focus-secondary">
          <button type="button" class="focus-link-btn focus-stop-btn"></button>
          <button type="button" class="focus-link-btn focus-exit-btn"></button>
        </div>
        <div class="focus-error hint-error"></div>
        <div class="focus-progress">
          <div class="focus-progress-label"></div>
          <div class="focus-progress-value"></div>
          <div class="focus-progress-dots" aria-hidden="true"></div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const q = (sel) => overlay.querySelector(sel);
    const els = {
      overlay,
      eyebrow: q('.focus-eyebrow'),
      task: q('.focus-task'),
      meta: q('.focus-meta'),
      countdown: q('.focus-countdown'),
      status: q('.focus-status'),
      barFill: q('.focus-bar-fill'),
      pauseBtn: q('.focus-pause-btn'),
      completeBtn: q('.focus-complete-btn'),
      stopBtn: q('.focus-stop-btn'),
      exitBtn: q('.focus-exit-btn'),
      error: q('.focus-error'),
      progressLabel: q('.focus-progress-label'),
      progressValue: q('.focus-progress-value'),
      progressDots: q('.focus-progress-dots'),
    };

    els.pauseBtn.addEventListener('click', () => {
      if (!focusSession) return;
      const now = Date.now();
      focusSession = isPaused(focusSession) ? resumeSession(focusSession, now) : pauseSession(focusSession, now);
      storeFocusSession();
      renderFocusOverlay();
    });
    els.completeBtn.addEventListener('click', () => endFocusSession('complete'));
    els.stopBtn.addEventListener('click', () => endFocusSession('stop'));
    els.exitBtn.addEventListener('click', () => {
      if (focusSaving) return;
      if (!window.confirm(t('focus.exitConfirm'))) return;
      closeFocusOverlay();
    });
    // A tab returning from the background re-renders immediately rather
    // than waiting for the next (possibly throttled) tick.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !overlay.hidden) renderFocusOverlay();
    });

    return els;
  }

  // Only touches the DOM when text actually changes — the overlay re-renders
  // every 250ms, and rewriting an aria-live region with identical text can
  // make screen readers re-announce it.
  function setFocusText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function renderFocusOverlay() {
    if (!focusOverlay || !focusSession || !focusItem) return;
    const els = focusOverlay;
    const now = Date.now();
    const remaining = getRemainingMs(focusSession, now);
    const paused = isPaused(focusSession);
    const timeUp = isTimeUp(focusSession, now);
    const countdown = formatCountdown(remaining);

    setFocusText(els.eyebrow, t('focus.eyebrow'));
    setFocusText(els.task, focusItem.name); // user-created content — never translated
    const loggedNote = focusSession.baseCompletedMinutes > 0 ? ` · ${t('focus.alreadyLogged').replace('{n}', focusSession.baseCompletedMinutes)}` : '';
    setFocusText(els.meta, `${formatClock(focusItem.start)} – ${formatClock(focusItem.end)}${loggedNote}`);
    setFocusText(els.countdown, countdown);
    els.countdown.classList.toggle('is-paused', paused);
    setFocusText(els.status, timeUp ? t('focus.timeUp') : paused ? t('focus.paused') : t('focus.remaining'));
    const fraction = focusSession.plannedMs > 0 ? 1 - remaining / focusSession.plannedMs : 1;
    els.barFill.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 1000) / 10}%`;

    setFocusText(els.pauseBtn, paused ? t('focus.resume') : t('focus.pause'));
    els.pauseBtn.disabled = focusSaving || timeUp;
    setFocusText(els.completeBtn, t('focus.complete'));
    els.completeBtn.disabled = focusSaving;
    setFocusText(els.stopBtn, t('focus.stopEarly'));
    els.stopBtn.disabled = focusSaving;
    setFocusText(els.exitBtn, t('focus.exit'));
    els.exitBtn.disabled = focusSaving;

    const isToday = schedule && schedule.for_date === addDaysToDateStr(tomorrowDateStr(), -1);
    const progress = computeTodaySessionProgress(currentScheduleItems);
    setFocusText(els.progressLabel, isToday ? t('focus.todayProgress') : t('focus.dayProgress'));
    setFocusText(els.progressValue, t('focus.sessionsCount').replace('{done}', progress.done).replace('{total}', progress.total));
    const dotsHtml = Array.from({ length: Math.min(progress.total, 12) }, (_, i) =>
      `<span class="focus-dot${i < progress.done ? ' is-done' : ''}"></span>`
    ).join('');
    if (els.progressDots.innerHTML !== dotsHtml) els.progressDots.innerHTML = dotsHtml;

    document.title = `${paused ? '⏸ ' : ''}${countdown} · ${focusItem.name}`;
  }

  function openFocusOverlay() {
    if (!focusOverlay) focusOverlay = buildFocusOverlay();
    focusOverlay.error.textContent = '';
    if (focusOverlay.overlay.hidden) focusPrevTitle = document.title;
    focusOverlay.overlay.hidden = false;
    document.body.classList.add('focus-open');
    renderFocusOverlay();
    clearInterval(focusTickTimer);
    focusTickTimer = setInterval(renderFocusOverlay, 250);
    focusOverlay.pauseBtn.focus(); // never Complete — a stray Enter/Space must not end the session
  }

  function closeFocusOverlay() {
    clearInterval(focusTickTimer);
    focusTickTimer = null;
    focusSession = null;
    focusItem = null;
    focusSaving = false;
    storeFocusSession();
    if (focusOverlay) focusOverlay.overlay.hidden = true;
    document.body.classList.remove('focus-open');
    if (focusPrevTitle) document.title = focusPrevTitle;
  }

  function startFocusSession(item) {
    const duration = item.end - item.start;
    const base = Number.isFinite(item.completedMinutes) ? Math.max(0, item.completedMinutes) : 0;
    focusItem = item;
    focusSession = createFocusSession({
      itemId: item.id,
      plannedMinutes: Math.max(0, duration - base),
      baseCompletedMinutes: base,
      now: Date.now(),
    });
    storeFocusSession();
    openFocusOverlay();
  }

  // A session left open across a reload comes back when its block is on
  // screen again. A stored session whose block is gone, done or locked is
  // dropped rather than resumed against the wrong data.
  function maybeRestoreFocusSession() {
    if (focusSession) return;
    const stored = readStoredFocusSession();
    if (!stored) return;
    const item = currentScheduleItems.find((i) => i.id === stored.itemId);
    if (!item) return; // may belong to another date — keep it for when that date loads
    if (!canStartFocus(item)) {
      try { localStorage.removeItem(FOCUS_STORAGE_KEY); } catch { /* ignore */ }
      return;
    }
    focusItem = item;
    focusSession = stored;
    openFocusOverlay();
  }

  async function endFocusSession(kind) {
    if (!focusSession || !focusItem || focusSaving) return;
    const item = focusItem;
    const duration = item.end - item.start;
    const write = buildFocusCompletionWrite({ kind, session: focusSession, now: Date.now(), duration });
    // Nothing to record — leave the block untouched instead of writing a no-op.
    if (kind === 'stop' && write.completedMinutes === (item.completedMinutes || 0) && !write.completed) {
      closeFocusOverlay();
      return;
    }
    // Freeze the clock while saving so the number written is the one shown.
    focusSession = pauseSession(focusSession, Date.now());
    focusSaving = true;
    renderFocusOverlay();
    const token = activeToken;
    try {
      await setScheduleItemPartialCompletion(item.id, write.completedMinutes, write.completed);
      closeFocusOverlay();
      if (token !== activeToken) return; // navigated away before this resolved
      item.completedMinutes = write.completedMinutes;
      item.completed = write.completed;
      renderScheduleEvents(currentScheduleItems, buildSubjectsInput());
      renderDailySummaryFromCurrent();
      refreshHistoryList();
      flashSaved();
    } catch (err) {
      console.error('Could not save focus session:', err);
      focusSaving = false;
      storeFocusSession();
      if (focusOverlay) focusOverlay.error.textContent = t('errors.couldNotSave');
      renderFocusOverlay();
    }
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
        <p class="hint">${escapeAttr(t('carryOver.remainingMinutesLabel'))}: ${escapeAttr(minText(preview.remainingMinutes))}</p>
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
    const nowDate = new Date();
    const timelineStatusContext = {
      isToday: Boolean(schedule) && schedule.for_date === todayDateStr(),
      nowMinutes: nowDate.getHours() * 60 + nowDate.getMinutes(),
    };
    const html = events
      .map((e) => {
        const dur = e.end - e.start;
        const durText = dur >= 60 ? `${Math.floor(dur / 60)}h ${dur % 60 ? (dur % 60) + 'm' : ''}`.trim() : minText(dur);
        const metaParts = [`${formatClock(e.start)} – ${formatClock(e.end)}`, durText];

        let priorityBadge = '';
        let statusBadge = '';
        let blockStatus = null;
        let lockControl = '';
        let doneControl = '';
        let editControl = '';
        let partialControl = '';
        let missedControl = '';
        let carryOverControl = '';
        let focusControl = '';
        let nameHtml = escapeAttr(displayBlockName(e, t));
        if (e.type === 'study') {
          const subj = subjectByName.get(e.name);
          if (subj?.priority) {
            const priorityKey = { high: 'taskFilter.priorityHigh', medium: 'taskFilter.priorityMedium', low: 'taskFilter.priorityLow' }[subj.priority];
            priorityBadge = `<span class="tl-badge tl-badge-${subj.priority}">${escapeAttr(priorityKey ? t(priorityKey) : subj.priority)}</span>`;
          }
          const dueText = formatDueDate(subj?.dueDate);
          if (dueText) metaParts.push(dueText);

          // V2-G: one status badge (statusModel.js) — the same label/icon/
          // color the Tasks list, Week, History, Board and Insights use.
          blockStatus = deriveBlockStatus(e, timelineStatusContext);
          if (blockStatus) statusBadge = statusBadgeHtml(blockStatus, t(statusLabelKey(blockStatus)));

          // Phase 14: partial-completion + carried-over audit trail, shown
          // right alongside the existing time/duration/due-date meta line —
          // never replacing it.
          const duration = e.end - e.start;
          if (e.completedMinutes > 0 && !e.completed) {
            metaParts.push(`${t('carryOver.completedMinutesLabel')}: ${e.completedMinutes}/${minText(duration)}`);
          }
          if (e.carriedOverMinutes > 0) {
            metaParts.push(`${t('carryOver.carriedOverNote')} ${minText(e.carriedOverMinutes)}`);
          }

          if (e.id) {
            // Focus Mode is a live timer, so only for today's blocks — not a
            // past or future day that happens to be open in the Planner.
            if (canStartFocus(e) && schedule && schedule.for_date === todayDateStr()) {
              focusControl = `<button type="button" class="focus-btn" data-id="${e.id}">${escapeAttr(t('focus.start'))}</button>`;
            }
            lockControl = `<button type="button" class="lock-btn" data-id="${e.id}" data-locked="${e.locked ? '1' : '0'}">${escapeAttr(e.locked ? t('schedule.locked') : t('schedule.lockAction'))}</button>`;
            doneControl = `<button type="button" class="done-btn" data-id="${e.id}" data-completed="${e.completed ? '1' : '0'}">${escapeAttr(e.completed ? t('schedule.undo') : t('schedule.markDone'))}</button>`;
            // editing a locked block is blocked in favor of unlocking it first — see
            // the Phase 9 note on validateManualStudyEdit for why
            if (e.id === editingItemId) {
              editControl = `
                <div class="edit-panel">
                  <div class="edit-fields">
                    <div class="edit-field">
                      <label for="editStart-${e.id}">${escapeAttr(t('schedule.startTimeLabel'))}</label>
                      <div class="edit-start-row">
                        <button type="button" class="edit-nudge-btn" data-nudge="-${NUDGE_MINUTES}" aria-label="${escapeAttr(t('manualEdit.earlier'))}" title="${escapeAttr(t('manualEdit.earlier'))}">−${NUDGE_MINUTES}</button>
                        <input type="time" class="edit-start-input" id="editStart-${e.id}" value="${minutesToInputTime(e.start)}">
                        <button type="button" class="edit-nudge-btn" data-nudge="${NUDGE_MINUTES}" aria-label="${escapeAttr(t('manualEdit.later'))}" title="${escapeAttr(t('manualEdit.later'))}">+${NUDGE_MINUTES}</button>
                      </div>
                    </div>
                    <div class="edit-field">
                      <label for="editDuration-${e.id}">${escapeAttr(t('manualEdit.durationLabel'))}</label>
                      <input type="number" class="edit-duration-input" id="editDuration-${e.id}" min="5" max="600" step="5" inputmode="numeric" value="${e.end - e.start}">
                    </div>
                  </div>
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
          focusControl || lockControl || doneControl || editControl || partialControl || missedControl || carryOverControl
            ? `<div class="tl-actions">${focusControl}${lockControl}${doneControl}${editControl}${partialControl}${missedControl}${carryOverControl}</div>`
            : '';

        return `
          <div class="tl-row tl-${e.type}${e.locked ? ' tl-locked' : ''}${e.completed ? ' tl-completed' : ''}${blockStatus === 'in_progress' ? ' tl-in-progress' : ''}">
            <div class="tl-time">${formatClock(e.start)}</div>
            <div class="tl-rail"><span class="tl-dot"></span></div>
            <div class="tl-card">
              <div class="tl-card-top">
                <span class="tl-name">${nameHtml}</span>
                ${priorityBadge}
                ${statusBadge}
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
    refreshConflictPanel();
    maybeRestoreFocusSession();
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
          <div class="nextup-name">${escapeAttr(displayBlockName(block, t))}</div>
          <div class="nextup-meta">${escapeAttr(label)} · ${formatClock(block.start)} – ${formatClock(block.end)}</div>
        </div>
      </div>
    `;
  }

  output.addEventListener('click', async (e) => {
    const focusBtn = e.target.closest('.focus-btn');
    if (focusBtn) {
      const item = currentScheduleItems.find((i) => i.id === focusBtn.dataset.id);
      if (item && canStartFocus(item)) {
        closeSecondaryPanels();
        startFocusSession(item);
      }
      return;
    }

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

    const nudgeBtn = e.target.closest('.edit-nudge-btn');
    if (nudgeBtn) {
      const startInput = nudgeBtn.closest('.edit-panel').querySelector('.edit-start-input');
      const next = nudgeClock(startInput.value, Number(nudgeBtn.dataset.nudge));
      if (next) startInput.value = next;
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
        errorEl.textContent = tMessage(bounds);
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
      // V2: the duration is editable too; it goes through the same
      // placement check (validateManualStudyEdit) as a start-time move.
      const durationInput = panel.querySelector('.edit-duration-input');
      const durationCheck = durationInput
        ? validateBlockDuration(durationInput.value, { completedMinutes: item.completed ? 0 : item.completedMinutes })
        : { ok: true, value: item.end - item.start };
      if (!durationCheck.ok) {
        errorEl.textContent = tMessage(durationCheck);
        return;
      }

      const fixedEvents = currentScheduleItems.filter((i) => i.type === 'class' || i.type === 'meal');
      const otherStudyBlocks = currentScheduleItems.filter((i) => i.type === 'study' && i.id !== id);

      const result = validateManualStudyEdit({
        newStart,
        duration: durationCheck.value,
        dayStart: bounds.dayStart,
        dayEnd: bounds.dayEnd,
        studyWindowStart,
        studyWindowEnd,
        fixedEvents,
        otherStudyBlocks,
      });

      if (!result.ok) {
        errorEl.textContent = tMessage(result);
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
        errorEl.textContent = tMessage(validated);
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
        flashError(t('errors.couldNotMarkMissed'));
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

  // ---------------- Schedule conflicts panel (V2 item 11) ----------------
  // One place for every conflict: overlapping classes, classes outside the
  // wake/sleep window, study blocks that now clash, locked blocks that
  // stopped regeneration, and not enough time — each with one clear action.
  // Detection is pure (conflictModel.js); this only gathers current state
  // and renders it.
  const conflictPanelEl = document.getElementById('conflictPanel');
  const conflictPanelBody = document.getElementById('conflictPanelBody');
  let lastLockConflictDetails = [];
  let lastShortfall = null;

  const CONFLICT_ACTION_KEYS = {
    edit_classes: 'conflicts.actionEditClasses',
    edit_day: 'conflicts.actionEditDay',
    edit_block: 'conflicts.actionEditBlock',
    regenerate: 'conflicts.actionRegenerate',
    unlock_block: 'conflicts.actionReviewLocked',
    shortfall_details: 'conflicts.actionShowDetails',
  };

  function renderLockConflicts(conflicts, details = []) {
    lastLockConflictDetails = conflicts && conflicts.length > 0
      ? conflicts.map((text, i) => details[i] || { error: text })
      : [];
    refreshConflictPanel();
  }

  function refreshConflictPanel() {
    if (!conflictPanelEl || !conflictPanelBody) return;
    if (!schedule) {
      conflictPanelEl.hidden = true;
      return;
    }
    const bounds = resolveDayBounds(wakeTimeEl.value, sleepTimeEl.value);
    const classRows = Array.from(classList.querySelectorAll('.entry-row')).map((row) => ({
      name: row.querySelector('.class-name')?.value || '',
      start: row.querySelector('.class-start')?.value || '',
      end: row.querySelector('.class-end')?.value || '',
    }));
    const conflicts = detectScheduleConflicts({
      classes: classesToMinutes(classRows, timeToMinutes),
      items: currentScheduleItems,
      dayStart: bounds.error ? null : bounds.dayStart,
      dayEnd: bounds.error ? null : bounds.dayEnd,
      lockConflictDetails: lastLockConflictDetails,
      shortfall: lastShortfall,
      formatRange: (start, end) => `${formatClock(start)} – ${formatClock(end)}`,
    });
    conflictPanelEl.hidden = conflicts.length === 0;
    conflictPanelBody.innerHTML = conflicts
      .map((c) => {
        const params = c.params.minutes !== undefined ? { ...c.params, minutes: minText(c.params.minutes) } : c.params;
        const text = c.key ? tMessage({ key: c.key, params }) : tMessage({ error: c.error });
        const actionKey = CONFLICT_ACTION_KEYS[c.action];
        const button = actionKey
          ? `<button type="button" class="conflict-action-btn" data-conflict-action="${escapeAttr(c.action)}"${c.itemId ? ` data-item-id="${escapeAttr(c.itemId)}"` : ''}>${escapeAttr(t(actionKey))}</button>`
          : '';
        return `<li class="conflict-item conflict-${escapeAttr(c.kind)}"><span class="conflict-text">${escapeAttr(text)}</span>${button}</li>`;
      })
      .join('');
  }

  if (conflictPanelBody) {
    conflictPanelBody.addEventListener('click', (e) => {
      const btn = e.target.closest('.conflict-action-btn');
      if (!btn) return;
      const action = btn.dataset.conflictAction;
      if (action === 'edit_classes') {
        const card = document.getElementById('classesCard');
        if (card) card.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
        const firstInput = classList.querySelector('.class-start:not([readonly])');
        if (firstInput) firstInput.focus({ preventScroll: true });
      } else if (action === 'edit_day') {
        const day = document.getElementById('dayCard');
        if (day) {
          day.open = true;
          day.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
          if (wakeTimeEl) wakeTimeEl.focus({ preventScroll: true });
        }
      } else if (action === 'edit_block' && btn.dataset.itemId) {
        closeSecondaryPanels();
        editingItemId = btn.dataset.itemId;
        renderScheduleEvents(currentScheduleItems, buildSubjectsInput());
        const input = output.querySelector('.edit-start-input');
        if (input) {
          input.closest('.tl-row').scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
          input.focus({ preventScroll: true });
        }
      } else if (action === 'regenerate') {
        (generateBtn.hidden ? regenerateBtn : generateBtn).click();
      } else if (action === 'unlock_block') {
        output.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
      } else if (action === 'shortfall_details') {
        const card = document.getElementById('shortfallWarning');
        if (card) card.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
      }
    });
  }

  // ---------------- daily summary + insufficient-time warning ----------------
  const shortfallWarningEl = document.getElementById('shortfallWarning');
  const shortfallWarningBody = document.getElementById('shortfallWarningBody');
  const dailySummaryCard = document.getElementById('dailySummaryCard');
  const dailySummaryBody = document.getElementById('dailySummaryBody');

  function renderShortfallWarning(progress) {
    lastShortfall = progress && progress.unscheduledTotal > 0 ? progress : null;
    refreshConflictPanel();
    if (!progress || progress.unscheduledTotal <= 0) {
      shortfallWarningEl.hidden = true;
      shortfallWarningBody.innerHTML = '';
      return;
    }
    const affected = progress.subjects.filter((s) => s.unscheduled > 0);
    const list = affected
      .map((s) => `<div class="item"><span>${escapeAttr(s.name)}</span><span class="value">${s.scheduled} / ${escapeAttr(minText(s.requested))}</span></div>`)
      .join('');
    shortfallWarningBody.innerHTML = `
      <div class="warning-totals">
        <div class="row"><span>${escapeAttr(t('shortfall.requestedLabel'))}</span><span class="value">${escapeAttr(minText(progress.requestedTotal))}</span></div>
        <div class="row"><span>${escapeAttr(t('shortfall.scheduledLabel'))}</span><span class="value">${escapeAttr(minText(progress.scheduledTotal))}</span></div>
        <div class="row"><span>${escapeAttr(t('shortfall.unscheduledLabel'))}</span><span class="value">${escapeAttr(minText(progress.unscheduledTotal))}</span></div>
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
        maxDailyStudyMinutes: schedule.max_daily_study_minutes || null,
      },
      lockedBlocks,
    });

    if (result.error) {
      showScheduleError(tMessage(result));
      renderDailySummary(null);
      renderShortfallWarning(null);
      renderLockConflicts(null);
      return;
    }

    if (result.lockConflicts && result.lockConflicts.length > 0) {
      // don't touch the saved schedule or currentScheduleItems — leave things exactly
      // as they were and tell the user what needs to be unlocked/adjusted first
      renderLockConflicts(result.lockConflicts, result.lockConflictDetails);
      return;
    }
    renderLockConflicts(null);

    renderScheduleEvents(result.events, subjectsInput);
    renderNotes(result.noteDetails
      ? result.noteDetails
        .filter((d) => d.key !== 'schedulerMsg.classOverlap') // shown in the Schedule conflicts panel instead
        .map((d) => tMessage(d.params && d.params.meal ? { ...d, params: { ...d.params, meal: mealLabel(d.params.meal, t) } } : d))
      : result.notes);

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
      flashError(t('errors.generatedNotSaved'));
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

  // ---------------- History filters (V2-E) ----------------
  // Client-side over the already-loaded history rows (filterHistory in
  // history.js) — filtering never refetches or changes anything stored.
  const historyFilterFromEl = document.getElementById('historyFilterFrom');
  const historyFilterToEl = document.getElementById('historyFilterTo');
  const historyFilterSubjectEl = document.getElementById('historyFilterSubject');
  const historyFilterStatusEl = document.getElementById('historyFilterStatus');
  const historyFiltersCountEl = document.getElementById('historyFiltersCount');
  const historyFiltersClearBtn = document.getElementById('historyFiltersClear');
  let historyRows = [];

  function readHistoryFilters() {
    return {
      from: historyFilterFromEl ? historyFilterFromEl.value : '',
      to: historyFilterToEl ? historyFilterToEl.value : '',
      subject: historyFilterSubjectEl ? historyFilterSubjectEl.value : '',
      status: historyFilterStatusEl ? historyFilterStatusEl.value : 'all',
    };
  }

  function refreshHistorySubjectOptions() {
    if (!historyFilterSubjectEl) return;
    const current = historyFilterSubjectEl.value;
    const names = collectHistorySubjects(historyRows);
    historyFilterSubjectEl.innerHTML = `<option value="">${escapeAttr(t('history.allSubjects'))}</option>${names
      .map((n) => `<option value="${escapeAttr(n)}">${escapeAttr(n)}</option>`)
      .join('')}`;
    historyFilterSubjectEl.value = names.includes(current) ? current : '';
  }

  function applyHistoryFilters() {
    const filters = readHistoryFilters();
    const active = countActiveHistoryFilters(filters);
    if (historyFiltersCountEl) {
      historyFiltersCountEl.hidden = active === 0;
      historyFiltersCountEl.textContent = `(${active})`;
    }
    const filtered = filterHistory(historyRows, filters);
    renderHistoryList(filtered, schedule ? schedule.for_date : null, historyRows.length > 0 && active > 0);
  }

  [historyFilterFromEl, historyFilterToEl, historyFilterSubjectEl, historyFilterStatusEl].forEach((filterEl) => {
    if (filterEl) filterEl.addEventListener('change', applyHistoryFilters);
  });
  if (historyFiltersClearBtn) {
    historyFiltersClearBtn.addEventListener('click', () => {
      if (historyFilterFromEl) historyFilterFromEl.value = '';
      if (historyFilterToEl) historyFilterToEl.value = '';
      if (historyFilterSubjectEl) historyFilterSubjectEl.value = '';
      if (historyFilterStatusEl) historyFilterStatusEl.value = 'all';
      applyHistoryFilters();
    });
  }

  function renderHistoryList(history, activeDate, filtered = false) {
    if (!history || history.length === 0) {
      const key = filtered ? 'history.noMatches' : 'history.noSavedDates';
      historyListEl.innerHTML = `<div class="placeholder">${escapeAttr(t(key))}</div>`;
      return;
    }
    historyListEl.innerHTML = history
      .map((h) => {
        const dateLabel = formatDateLabel(h.forDate);
        const bits = [tCount('history.classCount', h.classCount), tCount('history.subjectCount', h.subjectCount)];
        if (h.studyBlockCount > 0) bits.push(t('history.completionPercent').replace('{percent}', h.completionPercent));
        // V2-E: the minutes behind the percentage, plus carried-over and
        // missed work only when there is some.
        const minuteBits = [];
        if (h.plannedMinutes > 0) {
          minuteBits.push(`${t('analytics.planned')} ${formatDuration(h.plannedMinutes)}`);
          minuteBits.push(`${t('analytics.completed')} ${formatDuration(h.completedMinutes)}`);
        }
        if (h.carriedOverMinutes > 0) minuteBits.push(`${t('status.carried_over')} ${formatDuration(h.carriedOverMinutes)}`);
        // V2-G: the day's block statuses as the shared badges.
        const counts = h.statusCounts || {};
        const statusKeys = ['done', 'partial', 'missed', 'carried_over'].filter((k) => counts[k] > 0);
        const statusRow = statusKeys.length > 0
          ? `<span class="status-summary">${statusKeys.map((k) => statusBadgeHtml(k, t(statusLabelKey(k)), { count: counts[k], compact: true })).join('')}</span>`
          : '';
        return `
          <div class="history-item${h.forDate === activeDate ? ' active' : ''}" data-date="${h.forDate}" tabindex="0" role="button">
            <div class="history-main">
              <span class="history-date">${escapeAttr(dateLabel)}</span>
              <span class="history-stats">${escapeAttr(bits.join(' · '))}</span>
              ${minuteBits.length > 0 ? `<span class="history-stats history-minutes">${escapeAttr(minuteBits.join(' · '))}</span>` : ''}
              ${statusRow}
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
      historyRows = history.filter((h) => h.classCount > 0 || h.subjectCount > 0 || h.studyBlockCount > 0);
      refreshHistorySubjectOptions();
      applyHistoryFilters();
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
            copyStatusEl.textContent = t('copy.canceled');
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
      copyStatusEl.textContent = t('copy.failed');
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
    if (maxDailyStudyEl) maxDailyStudyEl.value = schedule.max_daily_study_minutes || '';
    updateDayLengthHint();

    try {
      const [loadedClasses, loadedSubjects] = await Promise.all([listClasses(schedule.id), listStudySubjects(schedule.id)]);
      if (token !== activeToken) return;
      // Subtasks are an extra: if they can't be read (e.g. migration 0005 not
      // applied yet) the day's classes and tasks must still render (V2-G).
      const loadedSubtasks = await loadSubtasksSoft(loadedSubjects.map((s) => s.id));
      if (token !== activeToken) return;
      const loadedSubtasksBySubjectId = new Map();
      loadedSubtasks.forEach((st) => {
        const list = loadedSubtasksBySubjectId.get(st.subject_id) || [];
        list.push(st);
        loadedSubtasksBySubjectId.set(st.subject_id, list);
      });
      renderClassListRows(loadedClasses);
      loadedSubjects.forEach((s) => addStudyRow(s, loadedSubtasksBySubjectId.get(s.id) || []));
      applyStudySortOrder();
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

  // Loaded once, before the first date renders — class_series/exceptions
  // are user-scoped (not per-date), so renderClassListRows above (called
  // from inside loadScheduleForDate) needs them already populated the
  // very first time a date's classList is built.
  setNextDayLabel(t('scheduler.nextDay')); // overnight times read "(次日)" etc. in zh/ja
  setClockLocale(getLocale()); // zh/ja show their own clock style (e.g. 19:35)
  await loadRecurringClassesData();
  await loadScheduleForDate(initialDate);

  // Home (analyticsView) is the default landing view; a #/route in the URL
  // (bookmark, reload, shared link) opens that page instead. The Planner's
  // own data is loaded above regardless, so switching to it is instant.
  const initialRoute = parseHash(location.hash);
  if (initialRoute && initialRoute.view === 'plannerForm') activatePlannerScroll('plannerForm');
  else if (initialRoute) await activateView(initialRoute.view, initialRoute.param);
  else {
    showAltView(document.getElementById('analyticsView'));
    history.replaceState(null, '', '#/home');
    if (analyticsSection && typeof analyticsSection.onShow === 'function') analyticsSection.onShow();
  }
  document.body.dataset.appReady = '1';

  // ---------------- First-run onboarding (V2-F) ----------------
  // "Build my first plan" fills the REAL Planner inputs and fires their own
  // change events, so the existing save handlers (saveScheduleSettings,
  // the classes/study rows' chainSave listeners) persist everything, then
  // the existing Generate runs. No second way of saving.
  const ONBOARDING_LOCAL_KEY = `scheduler.onboardingDone.v1:${userId}`;
  function readOnboardingLocalFlag() {
    try {
      return localStorage.getItem(ONBOARDING_LOCAL_KEY) === '1';
    } catch {
      return false;
    }
  }

  async function applyOnboardingPlan(plan) {
    if (forDateEl.value !== todayDateStr()) await loadScheduleForDate(todayDateStr());
    activatePlannerScroll('plannerForm');

    if (plan.day) {
      wakeTimeEl.value = plan.day.wake_time;
      sleepTimeEl.value = plan.day.sleep_time;
    }
    preferredPeriodEl.value = plan.prefs.preferred_study_period;
    if (plan.prefs.session_cap_minutes) sessionCapEl.value = String(plan.prefs.session_cap_minutes);
    saveScheduleSettings();
    await scheduleSaveTarget._savePromise;

    const classRows = plan.classes.map((c) => addClassRow(c));
    classRows.forEach((row) => row.querySelector('.class-name').dispatchEvent(new Event('change', { bubbles: true })));
    const taskRows = plan.tasks.map((task) => addStudyRow(task));
    taskRows.forEach((row) => row.querySelector('.study-name').dispatchEvent(new Event('change', { bubbles: true })));
    await Promise.all([...classRows, ...taskRows].map((row) => row._savePromise));

    // chainSave reports its own errors; a row without an id here means its
    // save failed, so stop before generating a plan from unsaved tasks.
    if ([...classRows, ...taskRows].some((row) => !row.dataset.id)) throw new Error('onboarding_save_failed');
    if (taskRows.length > 0) await handleGenerateClick(generateBtn.hidden ? regenerateBtn : generateBtn);
    output.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  }

  const onboarding = initOnboarding({
    t,
    applyPlan: applyOnboardingPlan,
    markComplete: async () => {
      try {
        localStorage.setItem(ONBOARDING_LOCAL_KEY, '1');
      } catch {
        // the server flag below still records it when available
      }
      await markOnboardingCompleted(userId);
    },
  });

  const replayOnboardingBtn = document.getElementById('settingsReplayOnboardingBtn');
  if (replayOnboardingBtn) {
    replayOnboardingBtn.hidden = false;
    replayOnboardingBtn.addEventListener('click', () => onboarding.open());
  }

  try {
    const [completedAt, hasExistingData] = await Promise.all([
      getOnboardingCompletedAt(userId),
      userHasAnyPlanningData(userId).catch(() => undefined),
    ]);
    if (shouldShowOnboarding({ completedAt, hasExistingData, dismissedLocally: readOnboardingLocalFlag() })) onboarding.open();
  } catch (err) {
    console.error('Could not check onboarding state:', err);
  }
}
