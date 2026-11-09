// Plans and entitlements (V5), pure — no DOM, no network.
//
// Free is a complete product: courses, tasks, calendar, manual planning,
// day schedule generation, routines, reminders, export — and the smart
// planner for the next two weeks. Student Pro adds depth to the automation
// (whole-semester horizon, bulk import, advanced forecasting/insights,
// calendar sync once it exists). Nothing that completes basic work is
// ever locked.
//
// While billing is not configured (the default), every account gets every
// feature — the "founding beta" — and the UI says so. Entitlements are
// derived ONLY from a subscription row the server wrote (Stripe webhook);
// the browser can't grant itself Pro, and for features that cost money on
// the server the Edge Function re-checks the same row.

export const PLANS = {
  free: { id: 'free', priceMonthly: 0, priceYearly: 0 },
  pro: { id: 'pro', priceMonthly: 3.99, priceYearly: 29, currency: 'USD' },
};

/** Feature limits per plan. */
export const FEATURES = {
  free: {
    planHorizonDays: 14, // smart plan / catch-up look-ahead
    forecastDays: 14,
    bulkImport: false, // syllabus import: one course at a time
    advancedInsights: false,
    calendarSync: false,
  },
  pro: {
    planHorizonDays: 120, // a full semester
    forecastDays: 120,
    bulkImport: true,
    advancedInsights: true,
    calendarSync: false, // not built yet — never advertised as available
  },
};

/** Stripe subscription statuses that keep Pro active. */
const ACTIVE = ['active', 'trialing'];
/** Grace: a failed renewal keeps Pro for a few days while Stripe retries. */
export const PAST_DUE_GRACE_DAYS = 7;

/**
 * Plan for a subscription row (as written by the webhook), at `now`.
 * @param {{ status?: string, plan?: string, current_period_end?: string|null, updated_at?: string|null } | null} sub
 * @param {{ now?: Date, billingEnabled?: boolean }} [opts]
 * @returns {{ plan: 'free'|'pro', source: 'beta'|'subscription'|'grace'|'none', features: object }}
 */
export function entitlementsFor(sub, { now = new Date(), billingEnabled = false } = {}) {
  if (!billingEnabled) return { plan: 'pro', source: 'beta', features: FEATURES.pro };
  const free = { plan: 'free', source: 'none', features: FEATURES.free };
  if (!sub || sub.plan !== 'pro') return free;
  const end = sub.current_period_end ? Date.parse(sub.current_period_end) : NaN;
  if (ACTIVE.includes(sub.status)) {
    // A period that ended long ago without a renewal event is not trusted.
    if (Number.isFinite(end) && end + PAST_DUE_GRACE_DAYS * 86400000 < now.getTime()) return free;
    return { plan: 'pro', source: 'subscription', features: FEATURES.pro };
  }
  if (sub.status === 'past_due') {
    const since = sub.updated_at ? Date.parse(sub.updated_at) : NaN;
    const graceEnd = (Number.isFinite(end) ? end : since) + PAST_DUE_GRACE_DAYS * 86400000;
    if (Number.isFinite(graceEnd) && now.getTime() <= graceEnd) return { plan: 'pro', source: 'grace', features: FEATURES.pro };
    return free;
  }
  // canceled / unpaid / incomplete / incomplete_expired / paused
  return free;
}

/** Yearly price as a monthly figure, for "save X%" copy. */
export function yearlySavingsPercent(plan = PLANS.pro) {
  if (!plan.priceMonthly || !plan.priceYearly) return 0;
  return Math.round((1 - plan.priceYearly / (plan.priceMonthly * 12)) * 100);
}
