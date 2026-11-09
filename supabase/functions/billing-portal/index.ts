// Supabase Edge Function — open the Stripe Customer Portal (V5-E), where a
// subscriber updates payment details, switches monthly/yearly, or cancels.
// The customer is looked up from the caller's own subscriptions row (via
// their JWT); the return URL comes only from APP_URL.
//
// Deploy: supabase functions deploy billing-portal
// The portal itself (cancellation allowed, plans shown) is configured once
// in the Stripe dashboard — see docs/BILLING.md.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { billingConfig, formEncode } from '../_shared/billing.mjs';

const env = (k: string) => Deno.env.get(k) || '';
const ENV = Object.fromEntries(['BILLING_ENABLED', 'STRIPE_SECRET_KEY', 'STRIPE_PRICE_MONTHLY', 'STRIPE_PRICE_YEARLY', 'APP_URL', 'STRIPE_LIVE_MODE_APPROVED'].map((k) => [k, env(k)]));
const CORS = {
  'Access-Control-Allow-Origin': env('APP_URL') || '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
  if (!billingConfig(ENV).ok) return reply(503, { error: 'billing_not_configured' });

  const userClient = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), { global: { headers: { Authorization: req.headers.get('Authorization') || '' } }, auth: { persistSession: false } });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return reply(401, { error: 'not_signed_in' });

  // Read through the user's own client: RLS guarantees it's their row.
  const { data: sub } = await userClient.from('subscriptions').select('stripe_customer_id').eq('user_id', userData.user.id).maybeSingle();
  if (!sub || !sub.stripe_customer_id) return reply(404, { error: 'no_customer' });

  const res = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ENV.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formEncode({ customer: sub.stripe_customer_id, return_url: `${ENV.APP_URL.replace(/\/+$/, '')}/dashboard.html#/settings/plan` }),
  });
  const json = await res.json();
  if (!res.ok) {
    console.error('billing-portal failed', json && json.error ? json.error.message : res.status);
    return reply(502, { error: 'portal_failed' });
  }
  return reply(200, { url: json.url });
});
