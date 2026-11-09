// Billing logic shared by the Edge Functions (Deno) and the Node tests.
// Plain JavaScript, no dependencies: Stripe is called over HTTPS with fetch,
// and webhook signatures are verified with Web Crypto — the same algorithm
// as Stripe's SDK (HMAC-SHA256 over "<timestamp>.<raw body>", compared in
// constant time, with a replay tolerance).

export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** "t=1492774577,v1=abc,v1=def,v0=old" → { t: 1492774577, v1: ['abc','def'] } */
export function parseSignatureHeader(header) {
  const out = { t: null, v1: [] };
  String(header || '').split(',').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't' && /^\d+$/.test(v)) out.t = Number(v);
    else if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v)) out.v1.push(v.toLowerCase());
  });
  return out;
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verifies a Stripe-Signature header against the RAW request body.
 * @returns {Promise<{ ok: boolean, reason?: 'no_secret'|'malformed'|'too_old'|'mismatch' }>}
 */
export async function verifyStripeSignature(rawBody, header, secret, { tolerance = SIGNATURE_TOLERANCE_SECONDS, now = Math.floor(Date.now() / 1000) } = {}) {
  if (!secret) return { ok: false, reason: 'no_secret' };
  const { t, v1 } = parseSignatureHeader(header);
  if (!t || !v1.length) return { ok: false, reason: 'malformed' };
  if (Math.abs(now - t) > tolerance) return { ok: false, reason: 'too_old' };
  const expected = await hmacHex(secret, `${t}.${rawBody}`);
  return v1.some((s) => timingSafeEqualHex(s, expected)) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/** Test helper / Stripe CLI equivalent: a valid header for a body. */
export async function signPayload(rawBody, secret, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${await hmacHex(secret, `${t}.${rawBody}`)}`;
}

// ---------------- events → subscription rows ----------------

export const HANDLED_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
];

const STATUSES = ['trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validUserId(id) {
  return typeof id === 'string' && UUID_RE.test(id) ? id : null;
}

/** The app user a Stripe object belongs to (set by billing-checkout as metadata / client_reference_id). */
export function userIdFromStripe(obj) {
  if (!obj) return null;
  return validUserId(obj.metadata && obj.metadata.user_id) || validUserId(obj.client_reference_id) || null;
}

const iso = (sec) => (Number.isFinite(Number(sec)) && Number(sec) > 0 ? new Date(Number(sec) * 1000).toISOString() : null);

/**
 * A Stripe Subscription object → our subscriptions row. Pro only when the
 * subscription's price is one of OUR configured Pro prices.
 * @param {object} sub  Stripe Subscription
 * @param {{ userId: string, proPriceIds: string[], eventCreated: number }} ctx
 */
export function subscriptionRow(sub, { userId, proPriceIds, eventCreated }) {
  const item = sub && sub.items && Array.isArray(sub.items.data) ? sub.items.data[0] : null;
  const price = item && item.price ? item.price : null;
  const status = STATUSES.includes(sub && sub.status) ? sub.status : 'incomplete';
  const isPro = Boolean(price && proPriceIds.includes(price.id));
  const interval = price && price.recurring && ['month', 'year'].includes(price.recurring.interval) ? price.recurring.interval : null;
  // Newer Stripe API versions keep the period on the item.
  const periodEnd = iso((sub && sub.current_period_end) ?? (item && item.current_period_end));
  return {
    user_id: userId,
    stripe_customer_id: typeof sub.customer === 'string' ? sub.customer : (sub.customer && sub.customer.id) || null,
    stripe_subscription_id: sub.id,
    plan: isPro ? 'pro' : 'free',
    status,
    price_interval: interval,
    current_period_end: periodEnd,
    cancel_at_period_end: Boolean(sub.cancel_at_period_end),
    last_event_at: iso(eventCreated),
    updated_at: new Date().toISOString(),
  };
}

/** Out-of-order delivery: never let an older event overwrite newer state. */
export function shouldApply(existing, eventCreatedSec) {
  if (!existing || !existing.last_event_at) return true;
  return Date.parse(existing.last_event_at) <= Number(eventCreatedSec) * 1000;
}

// ---------------- checkout ----------------

export function priceIdFor(interval, env) {
  if (interval === 'month') return env.STRIPE_PRICE_MONTHLY || null;
  if (interval === 'year') return env.STRIPE_PRICE_YEARLY || null;
  return null;
}

/** Billing works only when every required setting exists — never half-configured. */
export function billingConfig(env) {
  const missing = ['BILLING_ENABLED', 'STRIPE_SECRET_KEY', 'STRIPE_PRICE_MONTHLY', 'STRIPE_PRICE_YEARLY', 'APP_URL'].filter((k) => !env[k]);
  if (env.BILLING_ENABLED && env.BILLING_ENABLED !== 'true') missing.push('BILLING_ENABLED');
  const live = /^sk_live_/.test(env.STRIPE_SECRET_KEY || '');
  // Live keys additionally need an explicit owner switch.
  if (live && env.STRIPE_LIVE_MODE_APPROVED !== 'true') missing.push('STRIPE_LIVE_MODE_APPROVED');
  return { ok: missing.length === 0, missing, live };
}

/** application/x-www-form-urlencoded with Stripe's bracket syntax for nested objects. */
export function formEncode(obj, prefix = '') {
  const parts = [];
  Object.entries(obj).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' ? parts.push(formEncode(x, `${key}[${i}]`)) : parts.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(x)}`)));
    else if (typeof v === 'object') parts.push(formEncode(v, key));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  });
  return parts.filter(Boolean).join('&');
}

/** Parameters for a subscription Checkout Session; redirect URLs come only from APP_URL. */
export function checkoutParams({ userId, customerId, priceId, appUrl }) {
  const base = appUrl.replace(/\/+$/, '');
  return {
    mode: 'subscription',
    customer: customerId,
    client_reference_id: userId,
    line_items: [{ price: priceId, quantity: 1 }],
    allow_promotion_codes: 'true',
    subscription_data: { metadata: { user_id: userId } },
    metadata: { user_id: userId },
    success_url: `${base}/dashboard.html?billing=success#/settings/plan`,
    cancel_url: `${base}/dashboard.html?billing=cancel#/settings/plan`,
  };
}

// ---------------- the webhook flow, with injected I/O ----------------

/**
 * Everything the webhook does, independent of Deno / Supabase / Stripe so
 * it can be tested with fakes.
 * @param {{ raw: string, signature: string|null, secret: string, proPriceIds: string[], now?: number }} req
 * @param {{
 *   getEventLog(id): Promise<{processed_at}|null>,
 *   insertEventLog(id, type): Promise<{duplicate?: boolean}>,
 *   markProcessed(id): Promise<void>,
 *   fetchSubscription(id): Promise<object>,
 *   findUserByCustomer(customerId): Promise<string|null>,
 *   getRow(userId): Promise<object|null>,
 *   upsertRow(row): Promise<void>,
 * }} io
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function processWebhook({ raw, signature, secret, proPriceIds, now }, io) {
  const check = await verifyStripeSignature(raw, signature, secret, now ? { now } : {});
  if (!check.ok) return { status: 400, body: { error: 'invalid_signature', reason: check.reason } };
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return { status: 400, body: { error: 'invalid_json' } };
  }
  if (!event || typeof event.id !== 'string' || !/^evt_[A-Za-z0-9]+$/.test(event.id)) return { status: 400, body: { error: 'invalid_event' } };

  const seen = await io.getEventLog(event.id);
  if (seen && seen.processed_at) return { status: 200, body: { received: true, duplicate: true } };
  if (!seen) {
    const ins = await io.insertEventLog(event.id, String(event.type || '').slice(0, 100));
    if (ins && ins.duplicate) return { status: 200, body: { received: true, duplicate: true } };
  }
  if (!HANDLED_EVENTS.includes(event.type)) {
    await io.markProcessed(event.id);
    return { status: 200, body: { received: true, ignored: true } };
  }
  try {
    const obj = (event.data && event.data.object) || {};
    let subId = null;
    let hintUser = null;
    if (event.type === 'checkout.session.completed') {
      if (obj.mode === 'subscription' && typeof obj.subscription === 'string') {
        subId = obj.subscription;
        hintUser = userIdFromStripe(obj);
      }
    } else if (typeof obj.id === 'string' && obj.id.startsWith('sub_')) subId = obj.id;
    let result = 'skipped';
    if (subId) {
      // Always the CURRENT subscription from Stripe, not the event payload.
      const sub = await io.fetchSubscription(subId);
      let userId = userIdFromStripe(sub) || hintUser;
      if (!userId && typeof sub.customer === 'string') userId = await io.findUserByCustomer(sub.customer);
      if (!userId) result = 'no_user';
      else if (!shouldApply(await io.getRow(userId), event.created)) result = 'stale';
      else {
        await io.upsertRow(subscriptionRow(sub, { userId, proPriceIds, eventCreated: event.created }));
        result = 'applied';
      }
    }
    await io.markProcessed(event.id);
    return { status: 200, body: { received: true, result } };
  } catch (err) {
    // Not marked processed: Stripe retries, and the retry is safe.
    return { status: 500, body: { error: 'processing_failed' } };
  }
}
