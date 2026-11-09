// Current account's entitlements (V5), synchronous for UI code.
// billingEnabled comes from the build (VITE_BILLING_ENABLED=true) — off by
// default, so everyone has the full product during the beta. The
// subscription row is loaded by billingData.js (Milestone E) and handed in
// with setSubscription(); until then this reports the beta plan.

import { entitlementsFor } from './plans.js';

let subscription = null;

export function billingEnabled() {
  try {
    return import.meta.env && import.meta.env.VITE_BILLING_ENABLED === 'true';
  } catch {
    return false;
  }
}

export function setSubscription(sub) {
  subscription = sub || null;
}

export function currentEntitlements(now = new Date()) {
  return entitlementsFor(subscription, { now, billingEnabled: billingEnabled() });
}

/** How far ahead the smart planner / catch-up may look. */
export function planHorizonDays() {
  return currentEntitlements().features.planHorizonDays;
}
