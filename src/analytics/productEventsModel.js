// Product events (V5-D), pure — which events exist, which properties they
// may carry, and when we may record anything at all.
//
// Opt-in only. Nothing is recorded until the student says yes; a browser
// sending Do Not Track or Global Privacy Control is never asked (they can
// still opt in from Settings → Privacy). Properties are small counts and
// fixed labels — never task names, course names, email or free text — and
// the database enforces the same allow-list (0027).

export const EVENT_NAMES = [
  'session_start', 'signup_started', 'signup_completed', 'onboarding_completed', 'onboarding_skipped',
  'first_schedule_generated', 'plan_applied', 'catchup_applied', 'import_completed', 'tour_completed',
  'pro_interest', 'upgrade_started', 'subscription_started', 'feedback_sent',
];

/** Allowed property keys and how their values are checked. */
const PROP_RULES = {
  source: 'label', mode: 'label', tour: 'label', plan: 'label', interval: 'label', kind: 'label', step: 'label',
  count: 'int', tasks: 'int', exams: 'int', meetings: 'int', days: 'int', minutes: 'int',
};
const LABEL_RE = /^[a-z0-9_-]{1,24}$/;

/** Drops anything that isn't an allowed key with a safe value (max 8 keys). */
export function sanitizeProps(props) {
  const out = {};
  if (!props || typeof props !== 'object') return out;
  Object.entries(props).forEach(([k, v]) => {
    if (Object.keys(out).length >= 8) return;
    const rule = PROP_RULES[k];
    if (rule === 'int' && Number.isInteger(v) && v >= 0 && v <= 100000) out[k] = v;
    else if (rule === 'label' && typeof v === 'string' && LABEL_RE.test(v)) out[k] = v;
  });
  return out;
}

/**
 * @param {{ consent: 'granted'|'denied'|null, optOutSignal: boolean, isDemo: boolean, signedIn: boolean, available: boolean }} s
 */
export function canRecord({ consent, isDemo, signedIn, available }) {
  return consent === 'granted' && !isDemo && signedIn && available;
}

/** Ask once, only when undecided, never in the demo, never with DNT/GPC on. */
export function shouldAskConsent({ consent, optOutSignal, isDemo, available }) {
  return consent === null && !optOutSignal && !isDemo && available;
}

/** Events recorded at most once per account (or once per day for session_start). */
export const ONCE_PER_USER = ['signup_completed', 'onboarding_completed', 'onboarding_skipped', 'first_schedule_generated'];
export function onceKey(name, today) {
  if (name === 'session_start') return `${name}:${today}`;
  return ONCE_PER_USER.includes(name) ? name : null;
}
