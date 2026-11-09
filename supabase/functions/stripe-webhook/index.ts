// Supabase Edge Function — Stripe webhook (V5-E).
//
// The ONLY writer of subscription state. The whole flow lives in
// ../_shared/billing.mjs#processWebhook (tested in tests/billing.test.js):
//   1. verify the Stripe-Signature header against the RAW body
//      (HMAC-SHA256, constant-time, 5-minute replay window) → 400 if bad
//   2. log the event id in public.stripe_events; an already-processed id
//      returns 200 without doing anything (idempotent retries)
//   3. subscription events: fetch the CURRENT subscription from Stripe and
//      upsert our row, unless a newer event was already applied
//   4. mark processed; unknown event types are acknowledged and ignored;
//      failures return 500 unmarked so Stripe's retry is safe
//
// Deploy (owner, after docs/BILLING.md):
//   supabase functions deploy stripe-webhook --no-verify-jwt
//   (Stripe can't send a Supabase JWT — the signature check replaces it.)
// Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_MONTHLY,
// STRIPE_PRICE_YEARLY. SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided
// by the platform and never leave the server.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { processWebhook } from '../_shared/billing.mjs';

const env = (k: string) => Deno.env.get(k) || '';
const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

const io = {
  async getEventLog(id: string) {
    const { data } = await admin.from('stripe_events').select('processed_at').eq('id', id).maybeSingle();
    return data;
  },
  async insertEventLog(id: string, type: string) {
    const { error } = await admin.from('stripe_events').insert({ id, type });
    if (error && /duplicate|unique/i.test(error.message)) return { duplicate: true };
    if (error) throw error;
    return {};
  },
  async markProcessed(id: string) {
    await admin.from('stripe_events').update({ processed_at: new Date().toISOString() }).eq('id', id);
  },
  async fetchSubscription(id: string) {
    const res = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${env('STRIPE_SECRET_KEY')}` } });
    if (!res.ok) throw new Error(`stripe subscription ${res.status}`);
    return res.json();
  },
  async findUserByCustomer(customerId: string) {
    const { data } = await admin.from('subscriptions').select('user_id').eq('stripe_customer_id', customerId).maybeSingle();
    return data ? data.user_id : null;
  },
  async getRow(userId: string) {
    const { data } = await admin.from('subscriptions').select('last_event_at').eq('user_id', userId).maybeSingle();
    return data;
  },
  async upsertRow(row: Record<string, unknown>) {
    const { error } = await admin.from('subscriptions').upsert(row, { onConflict: 'user_id' });
    if (error) throw error;
  },
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405 });
  const { status, body } = await processWebhook({
    raw: await req.text(),
    signature: req.headers.get('stripe-signature'),
    secret: env('STRIPE_WEBHOOK_SECRET'),
    proPriceIds: [env('STRIPE_PRICE_MONTHLY'), env('STRIPE_PRICE_YEARLY')].filter(Boolean),
  }, io);
  if (status >= 500) console.error('stripe-webhook', body);
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
});
