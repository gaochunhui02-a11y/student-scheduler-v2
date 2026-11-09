// V5-E billing: webhook signature verification, idempotent and ordered
// processing, subscription rows, checkout safety, and that no secret or
// purchase path leaks into the browser bundle.
// Run: node tests/billing.test.js

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseSignatureHeader, verifyStripeSignature, signPayload, subscriptionRow, shouldApply, userIdFromStripe,
  billingConfig, priceIdFor, formEncode, checkoutParams, processWebhook,
} from '../supabase/functions/_shared/billing.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
let failures = 0;
async function check(label, fn) {
  try {
    await fn();
    console.log(`  PASS  ${label}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${label}`);
    console.log(`        ${e.message}`);
  }
}

// A made-up secret used only by these tests.
const SECRET = 'whsec_unit_test_only_not_a_real_secret';
const USER = '0f8fad5b-d9cb-469f-a165-70867728950e';
const NOW = 1_800_000_000;
const PRICES = ['price_month_test', 'price_year_test'];
const stripeSub = (over = {}) => ({
  id: 'sub_ABC123', customer: 'cus_XYZ789', status: 'active', cancel_at_period_end: false,
  metadata: { user_id: USER },
  items: { data: [{ price: { id: 'price_month_test', recurring: { interval: 'month' } }, current_period_end: NOW + 30 * 86400 }] },
  ...over,
});

console.log('\n=== webhook signatures ===');
await check('header parsing keeps only well-formed t and v1 values', () => {
  const h = parseSignatureHeader(`t=123,v1=${'a'.repeat(64)},v0=old,v1=zz,v1=${'B'.repeat(64)}`);
  assert.equal(h.t, 123);
  assert.deepEqual(h.v1, ['a'.repeat(64), 'b'.repeat(64)]);
});
await check('a correctly signed body verifies; any change to body, secret or timestamp fails', async () => {
  const body = '{"id":"evt_1","type":"customer.subscription.updated"}';
  const header = await signPayload(body, SECRET, NOW);
  assert.deepEqual(await verifyStripeSignature(body, header, SECRET, { now: NOW }), { ok: true });
  assert.equal((await verifyStripeSignature(`${body} `, header, SECRET, { now: NOW })).reason, 'mismatch');
  assert.equal((await verifyStripeSignature(body, header, 'whsec_other', { now: NOW })).reason, 'mismatch');
  assert.equal((await verifyStripeSignature(body, header.replace(`t=${NOW}`, `t=${NOW + 1}`), SECRET, { now: NOW })).reason, 'mismatch');
});
await check('replays outside 5 minutes, malformed headers and a missing secret are rejected', async () => {
  const body = '{}';
  assert.equal((await verifyStripeSignature(body, await signPayload(body, SECRET, NOW - 301), SECRET, { now: NOW })).reason, 'too_old');
  assert.equal((await verifyStripeSignature(body, 'garbage', SECRET, { now: NOW })).reason, 'malformed');
  assert.equal((await verifyStripeSignature(body, null, SECRET, { now: NOW })).reason, 'malformed');
  assert.equal((await verifyStripeSignature(body, await signPayload(body, SECRET, NOW), '', { now: NOW })).reason, 'no_secret');
});

console.log('\n=== subscription rows ===');
await check('active subscription on our price → Pro with interval and period end', () => {
  const row = subscriptionRow(stripeSub(), { userId: USER, proPriceIds: PRICES, eventCreated: NOW });
  assert.equal(row.plan, 'pro');
  assert.equal(row.status, 'active');
  assert.equal(row.price_interval, 'month');
  assert.equal(row.current_period_end, new Date((NOW + 30 * 86400) * 1000).toISOString());
  assert.equal(row.stripe_customer_id, 'cus_XYZ789');
  assert.equal(row.last_event_at, new Date(NOW * 1000).toISOString());
});
await check('a price that is not ours never grants Pro; unknown statuses are not trusted', () => {
  const foreign = stripeSub({ items: { data: [{ price: { id: 'price_someone_else', recurring: { interval: 'month' } } }] } });
  assert.equal(subscriptionRow(foreign, { userId: USER, proPriceIds: PRICES, eventCreated: NOW }).plan, 'free');
  assert.equal(subscriptionRow(stripeSub({ status: 'hacked' }), { userId: USER, proPriceIds: PRICES, eventCreated: NOW }).status, 'incomplete');
});
await check('user id only from our metadata / client_reference_id, and only a UUID', () => {
  assert.equal(userIdFromStripe({ metadata: { user_id: USER } }), USER);
  assert.equal(userIdFromStripe({ client_reference_id: USER }), USER);
  assert.equal(userIdFromStripe({ metadata: { user_id: "x' or 1=1" } }), null);
  assert.equal(userIdFromStripe(null), null);
});
await check('an older event never overwrites newer state', () => {
  assert.equal(shouldApply(null, NOW), true);
  assert.equal(shouldApply({ last_event_at: new Date(NOW * 1000).toISOString() }, NOW + 5), true);
  assert.equal(shouldApply({ last_event_at: new Date(NOW * 1000).toISOString() }, NOW - 5), false);
});

console.log('\n=== webhook flow (fakes for Supabase and Stripe) ===');
function fakeIo(subscription = stripeSub()) {
  const state = { log: new Map(), rows: new Map(), fetches: 0, upserts: 0 };
  const io = {
    async getEventLog(id) { return state.log.get(id) || null; },
    async insertEventLog(id, type) { if (state.log.has(id)) return { duplicate: true }; state.log.set(id, { type, processed_at: null }); return {}; },
    async markProcessed(id) { state.log.get(id).processed_at = 'now'; },
    async fetchSubscription() { state.fetches += 1; return subscription; },
    async findUserByCustomer() { return null; },
    async getRow(userId) { return state.rows.get(userId) || null; },
    async upsertRow(row) { state.upserts += 1; state.rows.set(row.user_id, row); },
  };
  return { io, state };
}
const event = (id, type, created, object) => JSON.stringify({ id, type, created, data: { object } });
const send = async (raw, io, { secret = SECRET, sig } = {}) => processWebhook({ raw, signature: sig ?? await signPayload(raw, SECRET, NOW), secret, proPriceIds: PRICES, now: NOW }, io);

await check('bad signature → 400 and nothing is written', async () => {
  const { io, state } = fakeIo();
  const res = await send(event('evt_1', 'customer.subscription.updated', NOW, { id: 'sub_ABC123' }), io, { sig: 't=1,v1=' + '0'.repeat(64) });
  assert.equal(res.status, 400);
  assert.equal(state.log.size + state.upserts, 0);
});
await check('a valid subscription event upserts Pro; the same event again is a no-op (idempotent)', async () => {
  const { io, state } = fakeIo();
  const raw = event('evt_2', 'customer.subscription.updated', NOW, { id: 'sub_ABC123' });
  const a = await send(raw, io);
  assert.deepEqual([a.status, a.body.result], [200, 'applied']);
  assert.equal(state.rows.get(USER).plan, 'pro');
  const b = await send(raw, io);
  assert.deepEqual([b.status, b.body.duplicate], [200, true]);
  assert.equal(state.upserts, 1);
  assert.equal(state.fetches, 1);
});
await check('checkout.session.completed links the session to the user and applies the subscription', async () => {
  const { io, state } = fakeIo(stripeSub({ metadata: {} }));
  const res = await send(event('evt_3', 'checkout.session.completed', NOW, { mode: 'subscription', subscription: 'sub_ABC123', client_reference_id: USER }), io);
  assert.equal(res.body.result, 'applied');
  assert.equal(state.rows.get(USER).plan, 'pro');
});
await check('out-of-order: a late older event after a cancellation does not revive Pro', async () => {
  const { io, state } = fakeIo(stripeSub({ status: 'canceled' }));
  await send(event('evt_new', 'customer.subscription.deleted', NOW + 100, { id: 'sub_ABC123' }), io);
  assert.equal(state.rows.get(USER).status, 'canceled');
  const late = await send(event('evt_old', 'customer.subscription.updated', NOW, { id: 'sub_ABC123' }), io);
  assert.equal(late.body.result, 'stale');
  assert.equal(state.rows.get(USER).status, 'canceled');
});
await check('unknown event types are acknowledged and ignored; a processing failure returns 500 and stays retryable', async () => {
  const { io, state } = fakeIo();
  const res = await send(event('evt_4', 'invoice.created', NOW, {}), io);
  assert.deepEqual([res.status, res.body.ignored], [200, true]);
  const broken = { ...io, async fetchSubscription() { throw new Error('stripe down'); } };
  const fail = await send(event('evt_5', 'customer.subscription.updated', NOW, { id: 'sub_ABC123' }), broken);
  assert.equal(fail.status, 500);
  assert.equal(state.log.get('evt_5').processed_at, null);
  const retry = await send(event('evt_5', 'customer.subscription.updated', NOW, { id: 'sub_ABC123' }), io);
  assert.equal(retry.body.result, 'applied');
});
await check('a subscription that can\'t be tied to a user changes nothing', async () => {
  const { io, state } = fakeIo(stripeSub({ metadata: {} }));
  const res = await send(event('evt_6', 'customer.subscription.created', NOW, { id: 'sub_ABC123' }), io);
  assert.equal(res.body.result, 'no_user');
  assert.equal(state.upserts, 0);
});

console.log('\n=== checkout configuration ===');
await check('billing refuses to run half-configured, and live keys need explicit approval', () => {
  assert.equal(billingConfig({}).ok, false);
  const test = { BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_MONTHLY: 'price_m', STRIPE_PRICE_YEARLY: 'price_y', APP_URL: 'https://app.example' };
  assert.deepEqual(billingConfig(test), { ok: true, missing: [], live: false });
  assert.equal(billingConfig({ ...test, BILLING_ENABLED: 'yes' }).ok, false);
  const live = { ...test, STRIPE_SECRET_KEY: 'sk_live_x' };
  assert.deepEqual(billingConfig(live).missing, ['STRIPE_LIVE_MODE_APPROVED']);
  assert.equal(billingConfig({ ...live, STRIPE_LIVE_MODE_APPROVED: 'true' }).ok, true);
});
await check('prices by interval only; redirect URLs only from APP_URL; Stripe form encoding', () => {
  const env = { STRIPE_PRICE_MONTHLY: 'price_m', STRIPE_PRICE_YEARLY: 'price_y' };
  assert.equal(priceIdFor('month', env), 'price_m');
  assert.equal(priceIdFor('year', env), 'price_y');
  assert.equal(priceIdFor('week', env), null);
  const p = checkoutParams({ userId: USER, customerId: 'cus_1', priceId: 'price_m', appUrl: 'https://app.example/' });
  assert.equal(p.success_url, 'https://app.example/dashboard.html?billing=success#/settings/plan');
  assert.equal(p.subscription_data.metadata.user_id, USER);
  assert.equal(formEncode({ a: 1, line_items: [{ price: 'p', quantity: 1 }], m: { user_id: 'u' } }), 'a=1&line_items%5B0%5D%5Bprice%5D=p&line_items%5B0%5D%5Bquantity%5D=1&m%5Buser_id%5D=u');
});

console.log('\n=== the browser never holds payment secrets ===');
await check('no Stripe secret / webhook secret / service-role key anywhere in src/ or the HTML pages', () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  const files = [...walk(join(root, 'src')), ...['index.html', 'dashboard.html', 'signup.html', 'login.html', 'privacy.html', 'terms.html'].map((f) => join(root, f))];
  const bad = files.filter((f) => /sk_(live|test)_[0-9A-Za-z]{8,}|whsec_[0-9A-Za-z]{8,}|STRIPE_SECRET_KEY|SERVICE_ROLE/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(bad.map((f) => f.split(/[\\/]src[\\/]/)[1] || f), []);
});

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
