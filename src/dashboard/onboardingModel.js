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
// V3 (when the courses feature exists): set up the term first, then the
// week, then the first tasks — each step still optional.
export const ONBOARDING_STEPS_V3 = ['courses', 'classes', 'tasks', 'day', 'style'];
export const MAX_ONBOARDING_COURSES = 4;

export function onboardingSteps({ courses = false } = {}) {
  return courses ? ONBOARDING_STEPS_V3 : ONBOARDING_STEPS;
}

// V4: first ask what the app is for; the rest of the setup follows from it.
// School / Multiple areas (or no answer yet) keep the academic setup; Work,
// Personal and Self-study skip courses and the class timetable.
export const PURPOSES = ['school', 'work', 'personal', 'selfstudy', 'multiple'];
export function onboardingStepsV4({ courses = false, purpose = null } = {}) {
  const academic = !purpose || purpose === 'school' || purpose === 'multiple';
  const rest = academic ? onboardingSteps({ courses }) : ['tasks', 'day', 'style'];
  return ['purpose', ...rest];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
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
      if (c.weekly && !(Number.isInteger(Number(c.weekday)) && Number(c.weekday) >= 0 && Number(c.weekday) <= 6)) errors.push({ index, field: 'weekday', key: 'onboarding.errChoose' });
    });
  } else if (step === 'purpose') {
    if (!PURPOSES.includes(answers.purpose)) errors.push({ field: 'purpose', key: 'onboarding.errPurpose' });
  } else if (step === 'courses') {
    const sem = answers.semester || {};
    const semName = (sem.name || '').trim();
    const anySem = semName || sem.start || sem.end;
    if (anySem) {
      if (!semName) errors.push({ field: 'semName', key: 'onboarding.errSemesterName' });
      if (!DATE_RE.test(sem.start || '') || !DATE_RE.test(sem.end || '')) errors.push({ field: 'semDates', key: 'onboarding.errSemesterDates' });
      else if (sem.end < sem.start) errors.push({ field: 'semDates', key: 'onboarding.errSemesterOrder' });
    }
    (answers.courses || []).forEach((c, index) => {
      const name = (c.name || '').trim();
      const code = (c.code || '').trim();
      if (!name && !code) return;
      if (!name) errors.push({ index, field: 'name', key: 'onboarding.errCourseName' });
      if (name.length > 120 || code.length > 32) errors.push({ index, field: 'name', key: 'onboarding.errCourseLong' });
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
    .filter((c) => !c.weekly)
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

// V3: the academic part of the answers — semester, courses, weekly classes
// and which course each one-off class / task belongs to. Indices in
// classCourse / taskCourse line up with buildOnboardingPlan's classes /
// tasks; a course is referred to by its index in `courses` (null = none).
export function buildOnboardingAcademics(answers = {}, { today, defaultWeeks = 16 } = {}) {
  const sem = answers.semester || {};
  const semester = (sem.name || '').trim() && DATE_RE.test(sem.start || '') && DATE_RE.test(sem.end || '') && sem.end >= sem.start
    ? { name: sem.name.trim().slice(0, 120), start_date: sem.start, end_date: sem.end }
    : null;
  // Course indices in the answers -> compacted indices after dropping empty rows.
  const remap = new Map();
  const courses = [];
  (answers.courses || []).forEach((c, i) => {
    const name = (c.name || '').trim();
    if (!name || courses.length >= MAX_ONBOARDING_COURSES) return;
    remap.set(i, courses.length);
    courses.push({ name: name.slice(0, 120), code: (c.code || '').trim().slice(0, 32) || null });
  });
  const courseRef = (v) => (v === '' || v === null || v === undefined || !remap.has(Number(v)) ? null : remap.get(Number(v)));
  const validClass = (c) => (c.name || '').trim() && isValidClock(c.start) && isValidClock(c.end);
  const seriesEnd = semester ? semester.end_date : (today ? addDaysStr(today, defaultWeeks * 7 - 1) : null);
  const seriesStart = semester && today && semester.start_date > today ? semester.start_date : today;
  const weeklyClasses = (answers.classes || [])
    .filter((c) => c.weekly && validClass(c))
    .slice(0, MAX_ONBOARDING_ROWS)
    .map((c) => ({
      name: c.name.trim().slice(0, 100),
      days_of_week: [Number(c.weekday)],
      start_time: c.start,
      end_time: c.end,
      start_date: seriesStart,
      end_date: seriesEnd && seriesStart && seriesEnd >= seriesStart ? seriesEnd : seriesStart,
      courseIndex: courseRef(c.course),
    }));
  const classCourse = (answers.classes || []).filter((c) => !c.weekly && validClass(c)).slice(0, MAX_ONBOARDING_ROWS).map((c) => courseRef(c.course));
  const taskCourse = (answers.tasks || [])
    .filter((tk) => (tk.name || '').trim() && Number(tk.minutes) > 0)
    .slice(0, MAX_ONBOARDING_ROWS)
    .map((tk) => courseRef(tk.course));
  return { semester, courses, weeklyClasses, classCourse, taskCourse };
}

function addDaysStr(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export function defaultOnboardingAnswersV3(today) {
  const base = defaultOnboardingAnswers();
  const weekday = today ? new Date(`${today}T00:00:00Z`).getUTCDay() : 1;
  return {
    ...base,
    semester: { name: '', start: '', end: '' },
    courses: [{ name: '', code: '' }, { name: '', code: '' }, { name: '', code: '' }],
    classes: base.classes.map((c) => ({ ...c, weekly: true, weekday, course: '' })),
    tasks: base.tasks.map((tk) => ({ ...tk, course: '' })),
  };
}
