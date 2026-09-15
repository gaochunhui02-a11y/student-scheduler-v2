// Notifications client controller (Phase 11) — owns the Settings card's
// notification UI, localStorage-persisted preferences, and the polling
// loop that turns the existing generated schedule + existing study-task
// due dates into browser Notification calls. Completely isolated from
// src/dashboard/dashboard.js: it never imports data.js directly, and
// dashboard.js only ever calls initNotificationsSection(userId, hostApi);
// it never reaches into this module's internals. Same bridge pattern as
// board.js/advisor.js/analytics.js.
//
// HONEST LIMITATION (see the Phase 11 report / notifications.limitationNote
// in the UI): this app has no push-notification backend (Web Push would
// need server infrastructure and a subscription/VAPID setup this phase
// deliberately does not build — see the brief). Reminders here only fire
// while this page is open in a browser tab; they cannot wake the device
// or notify the user while the app/tab is fully closed. That's the
// reliable scope of what a plain client-side setInterval can promise, and
// this file does not pretend otherwise.
//
// Study-reminder eligibility, reminder-time math, deadline classification,
// and duplicate-notification prevention are all pure functions in
// src/notifications/notificationsModel.js — this file only does the
// browser-API and DOM work: reading/writing localStorage, asking
// Notification.requestPermission(), polling on an interval, and calling
// `new Notification(...)`.

import { t } from '../shared/i18n.js';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  normalizeNotificationSettings,
  normalizeLeadMinutes,
  classifyPermissionState,
  isStudyReminderDue,
  formatStudyReminderText,
  classifyDeadlineReminderType,
  formatDeadlineReminderText,
  buildStudyReminderKey,
  buildDeadlineReminderKey,
  shouldNotify,
  markNotified,
} from './notificationsModel.js';

const SETTINGS_STORAGE_KEY = 'student-scheduler-notification-settings';
const STUDY_POLL_MS = 30000; // 30s — cheap, reads in-memory schedule state only
const DEADLINE_POLL_MS = 5 * 60 * 1000; // 5min — the only path that makes a Supabase call
const FIRST_STUDY_CHECK_DELAY_MS = 3000;
const FIRST_DEADLINE_CHECK_DELAY_MS = 5000;

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY));
    return normalizeNotificationSettings(raw);
  } catch {
    return { ...DEFAULT_NOTIFICATION_SETTINGS };
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // per-viewer convenience only — fine if it can't persist
  }
}

function isNotificationApiSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function initNotificationsSection(userId, hostApi = {}) {
  const permissionHintEl = document.getElementById('notificationPermissionHint');
  const enableBtn = document.getElementById('enableNotificationsBtn');
  const studyToggle = document.getElementById('studyReminderToggle');
  const deadlineToggle = document.getElementById('deadlineReminderToggle');
  const leadSelect = document.getElementById('reminderLeadSelect');

  // The settings card isn't on every page (only dashboard.html) — nothing
  // to wire up elsewhere, but the caller can still exist harmlessly.
  const hasUi = Boolean(permissionHintEl || enableBtn || studyToggle || deadlineToggle || leadSelect);

  let settings = loadSettings();
  let notifiedKeys = new Set(); // session-only — resets on reload, by design (see notificationsModel.shouldNotify)

  function refreshPermissionUI() {
    if (!permissionHintEl && !enableBtn) return;
    const supported = isNotificationApiSupported();
    const state = classifyPermissionState(supported ? Notification.permission : undefined, supported);

    if (permissionHintEl) {
      const key =
        state === 'granted'
          ? 'notifications.permissionGranted'
          : state === 'denied'
          ? 'notifications.permissionDenied'
          : state === 'unsupported'
          ? 'notifications.permissionUnsupported'
          : 'notifications.permissionDefault';
      permissionHintEl.dataset.i18n = key;
      permissionHintEl.textContent = t(key);
    }
    if (enableBtn) {
      enableBtn.hidden = state === 'granted' || state === 'unsupported';
      enableBtn.disabled = state === 'denied';
    }
  }

  if (enableBtn) {
    // Only ever called from this click handler — never on page load, never
    // automatically. The explanatory text (notifications.explain) is
    // already visible in the settings card before the user ever reaches
    // this button.
    enableBtn.addEventListener('click', async () => {
      if (!isNotificationApiSupported()) return;
      try {
        await Notification.requestPermission();
      } catch (err) {
        console.error('Notification permission request failed:', err);
      }
      refreshPermissionUI();
    });
  }

  function persist() {
    saveSettings(settings);
  }

  if (studyToggle) {
    studyToggle.checked = settings.studyRemindersEnabled;
    studyToggle.addEventListener('change', () => {
      settings = { ...settings, studyRemindersEnabled: studyToggle.checked };
      persist();
    });
  }
  if (deadlineToggle) {
    deadlineToggle.checked = settings.deadlineRemindersEnabled;
    deadlineToggle.addEventListener('change', () => {
      settings = { ...settings, deadlineRemindersEnabled: deadlineToggle.checked };
      persist();
    });
  }
  if (leadSelect) {
    leadSelect.value = String(settings.leadMinutes);
    leadSelect.addEventListener('change', () => {
      settings = { ...settings, leadMinutes: normalizeLeadMinutes(leadSelect.value) };
      persist();
    });
  }

  refreshPermissionUI();

  function canFireNotifications() {
    return isNotificationApiSupported() && Notification.permission === 'granted';
  }

  function fireNotification(title, body) {
    try {
      // eslint-disable-next-line no-new
      new Notification(title, { body, icon: '/icons/icon-192.png' });
    } catch (err) {
      console.error('Could not show notification:', err);
    }
  }

  // Reads whatever schedule is CURRENTLY loaded in the Planner — only
  // fires when that happens to be today's own schedule (checked below),
  // since "starts in N minutes" is only meaningful for the day actually
  // in progress. No network call: currentScheduleItems is already in
  // dashboard.js's memory.
  function checkStudyReminders() {
    if (!settings.studyRemindersEnabled || !canFireNotifications()) return;
    if (typeof hostApi.getCurrentScheduleDate !== 'function' || typeof hostApi.getTodayDateStr !== 'function') return;
    const currentDate = hostApi.getCurrentScheduleDate();
    const today = hostApi.getTodayDateStr();
    if (!currentDate || currentDate !== today) return;

    const items = typeof hostApi.getScheduleItemsForReminders === 'function' ? hostApi.getScheduleItemsForReminders() : [];
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    (items || []).forEach((item) => {
      if (!isStudyReminderDue(item, nowMinutes, settings.leadMinutes)) return;
      const key = buildStudyReminderKey(item.id);
      if (!shouldNotify(key, notifiedKeys)) return;
      notifiedKeys = markNotified(notifiedKeys, key);
      const text = formatStudyReminderText(item.name, settings.leadMinutes, {
        startsIn: t('notifications.startsIn'),
        minutes: t('notifications.minutesWord'),
      });
      fireNotification(t('notifications.studyReminderTitle'), text);
    });
  }

  // The one path that makes a Supabase call — polled far less often than
  // study reminders (every 5 minutes is more than enough precision for a
  // "due today/due tomorrow" check) to avoid hammering the database.
  async function checkDeadlineReminders() {
    if (!settings.deadlineRemindersEnabled || !canFireNotifications()) return;
    if (typeof hostApi.getUpcomingSubjectsForReminders !== 'function' || typeof hostApi.getTodayDateStr !== 'function') return;
    const today = hostApi.getTodayDateStr();

    let subjects = [];
    try {
      subjects = await hostApi.getUpcomingSubjectsForReminders();
    } catch (err) {
      console.error('Could not check deadline reminders:', err);
      return;
    }

    (subjects || []).forEach((s) => {
      const type = classifyDeadlineReminderType(s.due_date, today);
      if (!type) return;
      const key = buildDeadlineReminderKey(s.id, type);
      if (!shouldNotify(key, notifiedKeys)) return;
      notifiedKeys = markNotified(notifiedKeys, key);
      const text = formatDeadlineReminderText(s.name, type, {
        dueToday: t('notifications.dueToday'),
        dueTomorrow: t('notifications.dueTomorrow'),
      });
      fireNotification(t('notifications.deadlineReminderTitle'), text);
    });
  }

  setInterval(checkStudyReminders, STUDY_POLL_MS);
  setInterval(checkDeadlineReminders, DEADLINE_POLL_MS);
  setTimeout(checkStudyReminders, FIRST_STUDY_CHECK_DELAY_MS);
  setTimeout(checkDeadlineReminders, FIRST_DEADLINE_CHECK_DELAY_MS);

  return hasUi ? { refreshPermissionUI } : null;
}
