// Checkpoint E — deterministic Quick (Study) Planning Templates. No AI, no
// network. A template is nothing more than a fixed, named preset for a few
// of the EXISTING `schedules` row columns the Study Preferences form
// already reads/writes (see dashboard.js's collectStudyPrefsFields /
// saveScheduleSettings) — applying one is exactly the same
// updateSchedule(scheduleId, fields) call a manual preferences edit already
// makes. No new column, no new concept the scheduler doesn't already
// understand, and nothing here ever touches a study task's own priority,
// due date, or minutes — those stay entirely student-authored.

// The only schedule columns a template is ever allowed to set. Kept as an
// explicit allow-list so a malformed/typo'd template key can never leak an
// unsupported field into a real updateSchedule() call.
export const SCHEDULE_PREF_FIELDS = [
  'preferred_study_period',
  'session_cap_minutes',
  'switch_break_minutes',
  'min_block_minutes',
  'earliest_study_time',
  'latest_study_time',
];

// Each template touches only the 1-2 fields its own description in the
// product brief actually implies, rather than every supported field — a
// narrower, more honest preview, and less chance of silently overwriting an
// unrelated preference the student set on purpose.
export const QUICK_TEMPLATES = [
  {
    key: 'examWeek',
    nameKey: 'quickTemplates.examWeek',
    descriptionKey: 'quickTemplates.examWeekDesc',
    focusKeys: ['quickTemplates.focusLongerBlocks', 'quickTemplates.focusShorterBreaks'],
    prefs: { session_cap_minutes: 90, switch_break_minutes: 5 },
  },
  {
    key: 'catchUpDay',
    nameKey: 'quickTemplates.catchUpDay',
    descriptionKey: 'quickTemplates.catchUpDayDesc',
    focusKeys: ['quickTemplates.focusOverdue', 'quickTemplates.focusMissed', 'quickTemplates.focusCarryOver'],
    prefs: { earliest_study_time: null, latest_study_time: null },
  },
  {
    key: 'busyDay',
    nameKey: 'quickTemplates.busyDay',
    descriptionKey: 'quickTemplates.busyDayDesc',
    focusKeys: ['quickTemplates.focusShorterSessions', 'quickTemplates.focusHighPriorityOnly'],
    prefs: { session_cap_minutes: 25, min_block_minutes: 15 },
  },
  {
    key: 'lightStudyDay',
    nameKey: 'quickTemplates.lightStudyDay',
    descriptionKey: 'quickTemplates.lightStudyDayDesc',
    focusKeys: ['quickTemplates.focusModerateWorkload', 'quickTemplates.focusRelaxedBreaks'],
    prefs: { session_cap_minutes: 40, switch_break_minutes: 15 },
  },
  {
    key: 'projectWork',
    nameKey: 'quickTemplates.projectWork',
    descriptionKey: 'quickTemplates.projectWorkDesc',
    focusKeys: ['quickTemplates.focusFewerSwitches', 'quickTemplates.focusLongFocusBlocks'],
    prefs: { session_cap_minutes: 120, min_block_minutes: 60 },
  },
];

export function getQuickTemplate(key) {
  return QUICK_TEMPLATES.find((tpl) => tpl.key === key) || null;
}

export function isSupportedPrefField(field) {
  return SCHEDULE_PREF_FIELDS.includes(field);
}

function normalize(value) {
  return value === undefined ? null : value;
}

// Every field the template WOULD change, alongside its actual value in
// `currentPrefs` (a plain { session_cap_minutes, ... } object shaped exactly
// like the `schedules` row / collectStudyPrefsFields()'s own output) — a
// field the schedule already has set to the same value is omitted, so the
// preview only ever shows a REAL change, never a no-op line.
export function buildTemplatePreview(template, currentPrefs) {
  if (!template) return [];
  const current = currentPrefs || {};
  return Object.keys(template.prefs)
    .filter(isSupportedPrefField)
    .map((field) => ({ field, from: normalize(current[field]), to: normalize(template.prefs[field]) }))
    .filter((change) => change.from !== change.to);
}

// The exact patch to send to the existing updateSchedule(scheduleId, patch)
// call — built from the allow-list, never the template object's own `prefs`
// directly, so a future template can never accidentally introduce a field
// the scheduler doesn't understand.
export function buildTemplatePrefsPatch(template) {
  if (!template) return {};
  const patch = {};
  SCHEDULE_PREF_FIELDS.forEach((field) => {
    if (field in template.prefs) patch[field] = template.prefs[field];
  });
  return patch;
}
