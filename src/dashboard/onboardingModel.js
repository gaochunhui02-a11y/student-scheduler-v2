// Pure logic for first-run onboarding (V2-F). No DOM, no Supabase.
//
// Four short steps, each skippable, then "Build my first plan":
//   1. tasks   — what you're studying (up to 3 tasks: name + minutes)
//   2. day     — wake / sleep time
//   3. classes — today's classes (optional)
//   4. style   — preferred study time + session length
// buildOnboardingPlan turns the raw answers into exactly the fields the
// Planner's existing forms already save; onboarding.js hands that to the
// host, which fills the real Planner inputs and lets their own save
// handlers persist it. Nothing here is a second way of saving anything.

export const ONBOARDING_STEPS = ['tasks', 'day', 'classes', 'style'];
export const STUDY_PERIODS = ['none', 'morning', 'afternoon', 'evening'];
export const SESSION_LENGTHS = [25, 45, 60, 90];
export const MAX_ONBOARDING_ROWS = 3;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function isValidClock(value) {
  return typeof value === 'string' && TIME_RE.test(value);
}

// Never for someone who already has planning data or already finished/
// skipped (server flag or this browser's flag). Safe before migration 0009
// too: an unknown completed_at (column missing) relies on the other two
// checks, so an existing user with data is never forced through it.
export function shouldShowOnboarding({ completedAt, hasExistingData, dismissedLocally }) {
  if (dismissedLocally) return false;
  if (completedAt) return false;
  if (hasExistingData !== false) return false; // unknown counts as "has data" — never force it
  return true;
}

// Per-step validation. Empty rows are fine (every step is optional); only
// a half-filled row is an error, so the student can fix it or clear it.
// Returns { ok, errors: [{ index?, field, key }] } with i18n keys.
export function validateOnboardingStep(step, answers = {}) {
  const errors = [];
  if (step === 'tasks') {
    (answers.tasks || []).forEach((task, index) => {
      const name = (task.name || '').trim();
      const minutesRaw = task.minutes;
      const empty = !name && (minutesRaw === '' || minutesRaw === null || minutesRaw === undefined);
      if (empty) return;
      if (!name) errors.push({ index, field: 'name', key: 'onboarding.errTaskName' });
      const minutes = Number(minutesRaw);
      if (!Number.isFinite(minutes) || minutes < 15 || minutes > 600) errors.push({ index, field: 'minutes', key: 'onboarding.errTaskMinutes' });
    });
  } else if (step === 'day') {
    const { wake, sleep } = answers.day || {};
    if (!isValidClock(wake)) errors.push({ field: 'wake', key: 'onboarding.errTime' });
    if (!isValidClock(sleep)) errors.push({ field: 'sleep', key: 'onboarding.errTime' });
    if (isValidClock(wake) && isValidClock(sleep)) {
      // An overnight day (sleep after midnight) is allowed, as in the
      // Planner; only a day shorter than 4 hours is rejected as a typo.
      const length = (toMinutes(sleep) - toMinutes(wake) + 1440) % 1440;
      if (length < 240) errors.push({ field: 'sleep', key: 'onboarding.errDayLength' });
    }
  } else if (step === 'classes') {
    (answers.classes || []).forEach((c, index) => {
      const name = (c.name || '').trim();
      const empty = !name && !c.start && !c.end;
      if (empty) return;
      if (!name) errors.push({ index, field: 'name', key: 'onboarding.errClassName' });
      if (!isValidClock(c.start) || !isValidClock(c.end)) errors.push({ index, field: 'time', key: 'onboarding.errTime' });
      else if (toMinutes(c.end) <= toMinutes(c.start)) errors.push({ index, field: 'time', key: 'onboarding.errClassOrder' });
    });
  } else if (step === 'style') {
    const { period, sessionMinutes } = answers.style || {};
    if (!STUDY_PERIODS.includes(period)) errors.push({ field: 'period', key: 'onboarding.errChoose' });
    if (!SESSION_LENGTHS.includes(Number(sessionMinutes))) errors.push({ field: 'session', key: 'onboarding.errChoose' });
  }
  return { ok: errors.length === 0, errors };
}

// The answers, cleaned into Planner-shaped fields. Empty rows are dropped;
// at most MAX_ONBOARDING_ROWS of each. Assumes every step validated.
export function buildOnboardingPlan(answers = {}) {
  const tasks = (answers.tasks || [])
    .map((tk) => ({ name: (tk.name || '').trim(), minutes_requested: Math.round(Number(tk.minutes)) }))
    .filter((tk) => tk.name && Number.isFinite(tk.minutes_requested) && tk.minutes_requested > 0)
    .slice(0, MAX_ONBOARDING_ROWS);
  const classes = (answers.classes || [])
    .map((c) => ({ name: (c.name || '').trim(), start_time: c.start, end_time: c.end }))
    .filter((c) => c.name && isValidClock(c.start_time) && isValidClock(c.end_time))
    .slice(0, MAX_ONBOARDING_ROWS);
  const day = answers.day || {};
  const style = answers.style || {};
  return {
    day: isValidClock(day.wake) && isValidClock(day.sleep) ? { wake_time: day.wake, sleep_time: day.sleep } : null,
    prefs: {
      preferred_study_period: STUDY_PERIODS.includes(style.period) ? style.period : 'none',
      session_cap_minutes: SESSION_LENGTHS.includes(Number(style.sessionMinutes)) ? Number(style.sessionMinutes) : null,
    },
    classes,
    tasks,
  };
}

// "Build my first plan" is only offered when there's something to plan.
export function canBuildPlan(plan) {
  return Boolean(plan && plan.tasks && plan.tasks.length > 0);
}

export function defaultOnboardingAnswers() {
  return {
    tasks: [{ name: '', minutes: '' }, { name: '', minutes: '' }, { name: '', minutes: '' }],
    day: { wake: '07:00', sleep: '23:00' },
    classes: [{ name: '', start: '', end: '' }, { name: '', start: '', end: '' }, { name: '', start: '', end: '' }],
    style: { period: 'none', sessionMinutes: 45 },
  };
}
