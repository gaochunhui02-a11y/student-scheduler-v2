// Supabase Edge Function — start a Student Pro checkout (V5-E).
//
// Called by the signed-in app (supabase.functions.invoke) with
// { interval: 'month' | 'year' }. The user is identified ONLY from their
// Supabase JWT, never from the request body; redirect URLs come ONLY from
// APP_URL. Refuses to run unless billing is fully configured
// (BILLING_ENABLED=true + Stripe key + both price ids + APP_URL), and
// refuses live keys unless STRIPE_LIVE_MODE_APPROVED=true.
//
// Deploy: supabase functions deploy billing-checkout

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { billingConfig, priceIdFor, checkoutParams, formEncode } from '../_shared/billing.mjs';

const env = (k: string) => Deno.env.get(k) || '';
const ENV = Object.fromEntries(['BILLING_ENABLED', 'STRIPE_SECRET_KEY', 'STRIPE_PRICE_MONTHLY', 'STRIPE_PRICE_YEARLY', 'APP_URL', 'STRIPE_LIVE_MODE_APPROVED'].map((k) => [k, env(k)]));
const CORS = {
  'Access-Control-Allow-Origin': env('APP_URL') || '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function stripePost(path: string, params: Record<string, unknown>) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ENV.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formEncode(params),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json && json.error ? json.error.message : `stripe ${res.status}`);
  return json;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
  const cfg = billingConfig(ENV);
  if (!cfg.ok) return reply(503, { error: 'billing_not_configured' });

  const auth = req.headers.get('Authorization') || '';
  const userClient = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return reply(401, { error: 'not_signed_in' });
  const user = userData.user;

  let body: { interval?: string } = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const priceId = priceIdFor(body.interval, ENV);
  if (!priceId) return reply(400, { error: 'invalid_interval' });

  const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  const { data: existing } = await admin.from('subscriptions').select('stripe_customer_id, plan, status').eq('user_id', user.id).maybeSingle();
  if (existing && existing.plan === 'pro' && ['active', 'trialing', 'past_due'].includes(existing.status)) return reply(409, { error: 'already_subscribed' });

  try {
    let customerId = existing && existing.stripe_customer_id;
    if (!customerId) {
      const customer = await stripePost('customers', { email: user.email, metadata: { user_id: user.id } });
      customerId = customer.id;
      const { error } = await admin.from('subscriptions').upsert({ user_id: user.id, stripe_customer_id: customerId, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
      if (error) throw error;
    }
    const session = await stripePost('checkout/sessions', checkoutParams({ userId: user.id, customerId, priceId, appUrl: ENV.APP_URL }));
    return reply(200, { url: session.url, testMode: !cfg.live });
  } catch (err) {
    console.error('billing-checkout failed', err);
    return reply(502, { error: 'checkout_failed' });
  }
});
