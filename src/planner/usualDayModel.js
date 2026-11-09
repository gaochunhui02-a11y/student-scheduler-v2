// Usual day (V5-B), pure: which saved fields a new day may start with.

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const PERIODS = ['none', 'morning', 'afternoon', 'evening'];

/** Only valid fields survive; times are HH:MM. */
export function normalizeUsualDay(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.wake_time === 'string' && TIME_RE.test(raw.wake_time)) out.wake_time = raw.wake_time.slice(0, 5);
  if (typeof raw.sleep_time === 'string' && TIME_RE.test(raw.sleep_time)) out.sleep_time = raw.sleep_time.slice(0, 5);
  const max = Number(raw.max_daily_study_minutes);
  if (Number.isInteger(max) && max >= 15 && max <= 1440) out.max_daily_study_minutes = max;
  const cap = Number(raw.session_cap_minutes);
  if (Number.isInteger(cap) && cap >= 10 && cap <= 600) out.session_cap_minutes = cap;
  if (PERIODS.includes(raw.preferred_study_period) && raw.preferred_study_period !== 'none') out.preferred_study_period = raw.preferred_study_period;
  return out;
}
