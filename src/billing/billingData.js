// Billing I/O for the browser (V5-E). Reads the user's own subscription
// row (RLS: select own) and calls the billing Edge Functions. Holds no
// secrets: checkout and portal sessions are created server-side, and only
// the webhook can change a subscription.

import { supabase } from '../lib/supabaseClient.js';
import { has } from '../shared/capabilities.js';
import { app } from '../app/context.js';
import { setSubscription, billingEnabled } from './entitlements.js';

export async function loadSubscription() {
  if (!has('subscriptions') || app().isDemo) {
    setSubscription(null);
    return null;
  }
  const { data, error } = await supabase.from('subscriptions').select('plan, status, price_interval, current_period_end, cancel_at_period_end, updated_at, stripe_customer_id').eq('user_id', app().userId).maybeSingle();
  if (error) return null;
  setSubscription(data || null);
  return data || null;
}

/** Checkout is offered only when the build enables billing AND the database has 0028. */
export function canCheckout() {
  return billingEnabled() && has('subscriptions') && !app().isDemo;
}

async function invoke(name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let code = 'failed';
    try { code = (await error.context.json()).error || code; } catch { /* not JSON */ }
    throw Object.assign(new Error(code), { code });
  }
  if (!data || typeof data.url !== 'string' || !/^https:\/\/(checkout|billing)\.stripe\.com\//.test(data.url)) throw Object.assign(new Error('bad_url'), { code: 'failed' });
  return data;
}

/** Redirects to Stripe Checkout (test mode until the owner approves live). */
export async function startCheckout(interval) {
  const data = await invoke('billing-checkout', { interval });
  window.location.assign(data.url);
}

export async function openBillingPortal() {
  const data = await invoke('billing-portal', {});
  window.location.assign(data.url);
}

/** After returning from Checkout the webhook may lag a few seconds: poll briefly. */
export async function waitForPro({ tries = 6, delay = 2000 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const sub = await loadSubscription();
    if (sub && sub.plan === 'pro' && ['active', 'trialing'].includes(sub.status)) return sub;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, delay));
  }
  return null;
}
