// Pure, DOM-free, browser-API-free logic for Notifications (Phase 11).
// Mirrors the rest of this codebase's split: nothing here touches
// `Notification`, `localStorage`, `Date.now()`, or any other global —
// every function takes its inputs as plain arguments and returns a plain
// value, so it's testable with plain Node the same way scheduler.js,
// boardModel.js, and analyticsModel.js are. The runtime pieces (asking for
// permission, polling the current schedule, actually calling
// `new Notification(...)`, reading/writing localStorage) live in
// src/notifications/notifications.js.
//
// Reuses src/analytics/analyticsModel.js's daysBetween for deadline-day
// math rather than a second date-diff implementation.

import { daysBetween } from '../analytics/analyticsModel.js';

export const VALID_LEAD_MINUTES = [5, 10, 15, 30];
export const DEFAULT_LEAD_MINUTES = 10;

export const DEFAULT_NOTIFICATION_SETTINGS = {
  studyRemindersEnabled: false,
  deadlineRemindersEnabled: false,
  leadMinutes: DEFAULT_LEAD_MINUTES,
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

// Any value outside the offered 5/10/15/30 options (missing, a string, a
// stray number, NaN) falls back to the default rather than scheduling a
// reminder at a nonsensical offset.
export function normalizeLeadMinutes(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  return VALID_LEAD_MINUTES.includes(n) ? n : DEFAULT_LEAD_MINUTES;
}

// Merges arbitrary/partial/malformed stored settings (e.g. from
// localStorage, which could contain anything or nothing) onto the
// defaults — booleans are coerced, leadMinutes is normalized. Both
// reminder kinds default OFF: notifications are opt-in, never assumed.
export function normalizeNotificationSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    studyRemindersEnabled: source.studyRemindersEnabled === true,
    deadlineRemindersEnabled: source.deadlineRemindersEnabled === true,
    leadMinutes: normalizeLeadMinutes(source.leadMinutes),
  };
}

// ---------------------------------------------------------------------------
// Permission state
// ---------------------------------------------------------------------------

// Classifies the browser's Notification API state without reading it
// itself — the caller passes in `Notification.permission` (or undefined)
// and whether the API exists at all, keeping this function testable
// without a DOM/Notification global.
export function classifyPermissionState(permission, isSupported) {
  if (!isSupported) return 'unsupported';
  if (permission === 'granted') return 'granted';
  if (permission === 'denied') return 'denied';
  return 'default'; // API exists, not yet asked (or the user dismissed the prompt)
}

// ---------------------------------------------------------------------------
// Study reminders — from the currently generated schedule
// ---------------------------------------------------------------------------

// A schedule_item is reminder-eligible only if it's an actual study block
// with a valid start time, isn't already marked completed (nothing useful
// to remind about work that's already done), and hasn't been explicitly
// flagged Missed (Phase 14) — once a student has already said "this isn't
// happening," a countdown reminder for it is stale noise, not help.
export function isEligibleForStudyReminder(item) {
  return Boolean(item) && item.type === 'study' && item.completed !== true && item.missed !== true && Number.isFinite(item.start);
}

// The reminder fires this many minutes before the block starts — same
// absolute-minutes-since-midnight space every schedule_item already uses
// (so it stays correct for an overnight block whose start exceeds 1440,
// same convention scheduler.js/analyticsModel.js use).
export function computeReminderTime(blockStartMinutes, leadMinutes) {
  if (!Number.isFinite(blockStartMinutes)) return null;
  const lead = normalizeLeadMinutes(leadMinutes);
  return blockStartMinutes - lead;
}

// True once "now" (in the same absolute-minutes space, computed by the
// caller from the wall clock against the schedule's date) has reached the
// reminder time but the block hasn't started yet — the actionable window.
// Once the block has actually started, reminding "starts in N minutes" no
// longer makes sense, so this returns false past blockStartMinutes.
export function isStudyReminderDue(item, nowMinutes, leadMinutes) {
  if (!isEligibleForStudyReminder(item)) return false;
  const reminderTime = computeReminderTime(item.start, leadMinutes);
  if (reminderTime === null || !Number.isFinite(nowMinutes)) return false;
  return nowMinutes >= reminderTime && nowMinutes < item.start;
}

export function formatStudyReminderText(itemName, leadMinutes, labels = {}) {
  const name = typeof itemName === 'string' && itemName.trim() ? itemName.trim() : (labels.untitled || 'Study session');
  const startsIn = labels.startsIn || 'starts in';
  const minutesWord = labels.minutes || 'minutes';
  return `${name} ${startsIn} ${normalizeLeadMinutes(leadMinutes)} ${minutesWord}`;
}

// ---------------------------------------------------------------------------
// Deadline reminders — from existing study-task due dates
// ---------------------------------------------------------------------------

// null (not eligible) unless the subject is due exactly today or exactly
// tomorrow — deliberately narrow scope, matching "due tomorrow / due
// today" from the brief rather than a broader/noisier due-date digest.
export function classifyDeadlineReminderType(dueDate, todayDateStr) {
  if (!dueDate || !todayDateStr) return null;
  const diff = daysBetween(todayDateStr, dueDate);
  if (diff === 0) return 'due_today';
  if (diff === 1) return 'due_tomorrow';
  return null;
}

export function formatDeadlineReminderText(subjectName, reminderType, labels = {}) {
  const name = typeof subjectName === 'string' && subjectName.trim() ? subjectName.trim() : (labels.untitled || 'Task');
  const suffix = reminderType === 'due_today' ? labels.dueToday || 'is due today' : labels.dueTomorrow || 'is due tomorrow';
  return `${name} ${suffix}`;
}

// ---------------------------------------------------------------------------
// Duplicate-notification prevention (one per key per session)
// ---------------------------------------------------------------------------

export function buildStudyReminderKey(scheduleItemId) {
  return `study:${scheduleItemId}`;
}

export function buildDeadlineReminderKey(subjectId, reminderType) {
  return `deadline:${subjectId}:${reminderType}`;
}

export function shouldNotify(key, alreadyNotifiedKeys) {
  return Boolean(key) && !(alreadyNotifiedKeys instanceof Set && alreadyNotifiedKeys.has(key));
}

// Returns a NEW Set with `key` added — never mutates the one passed in,
// same immutable-update convention as src/board/boardModel.js's
// linkNodeToStudyTask.
export function markNotified(alreadyNotifiedKeys, key) {
  const next = new Set(alreadyNotifiedKeys instanceof Set ? alreadyNotifiedKeys : []);
  if (key) next.add(key);
  return next;
}
