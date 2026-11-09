# Billing: Free / Student Pro (V5-E)

**Status: built and unit-tested; not connected to Stripe.** No Stripe account,
keys, products or webhook have been configured, and no real or test payment
has been made. Billing is **off by default**. While it is off, every account
is on the "Founding beta" with all features, and the app shows no purchase
button.

## Architecture

```
Browser (no secrets)                Supabase Edge Functions (secrets)         Stripe
────────────────────                ───────────────────────────────           ──────
Settings → Plan ── invoke ────────▶ billing-checkout ── create session ─────▶ Checkout
  (JWT identifies the user)           · user from JWT only                         │
                                      · price from env by interval                 │
                                      · redirect URLs from APP_URL only            │
                                                                                   ▼
public.subscriptions ◀── upsert ──── stripe-webhook ◀── signed event ──────── webhooks
  (SELECT own only;                   · HMAC signature on raw body (5-min window)
   no client writes)                  · stripe_events id → idempotent
                                      · re-fetches the subscription
                                      · ignores out-of-order (older) events
Settings → Plan ── invoke ────────▶ billing-portal ── portal session ───────▶ Customer Portal
                                                                              (cancel / switch / card)
```

* **Entitlements:** `src/billing/plans.js#entitlementsFor` turns the user's
  subscription row into Free or Pro.
  * `active` and `trialing` give Pro.
  * `past_due` keeps Pro for a 7-day grace period.
  * `canceled`, `unpaid`, `incomplete` and `paused` give Free.
  * An "active" row whose period ended more than 7 days ago is not trusted.
* **Gates:** the browser cannot write `subscriptions` (verified on real Postgres in `tests/db/migrations-pglite.mjs`).
  * Pro features today are deterministic code running in the browser. That makes the Free limit (a 14-day planning look-ahead) a product gate rather than a security boundary, which is acceptable because no server cost or data is exposed.
  * Any future feature that costs money on the server (OCR, calendar sync) must re-check `subscriptions` inside its Edge Function.
* **Free stays complete:** courses, tasks, calendar, manual planning, day generation, routines, reminders, import and export are never gated.

## Files

| Path | Purpose |
|---|---|
| `supabase/migrations/0028_subscriptions.sql` | `subscriptions` (select-own only), `stripe_events` (no client access) |
| `supabase/functions/_shared/billing.mjs` | Signature verification, webhook flow, row mapping, checkout params. Pure JS with no dependencies, tested in Node |
| `supabase/functions/stripe-webhook` | Thin Deno wrapper around `processWebhook` |
| `supabase/functions/billing-checkout` | Creates or reuses the Stripe customer and starts Checkout (subscription mode) |
| `supabase/functions/billing-portal` | Opens the Customer Portal |
| `src/billing/*` | Plans, entitlements, the Settings → Plan tab, return handling |
| `tests/billing.test.js` | Signatures (cross-checked against the official `stripe` SDK in development), idempotency, ordering, config refusal, no secrets in the client |

## Owner setup: Stripe **test mode**

1. **Stripe Dashboard (test mode):** create the product "Student Pro" with two recurring prices, $3.99/month and $29/year. Note their `price_…` ids.
2. **Customer Portal** (Settings → Billing → Customer portal):
   * Allow cancellation (at period end).
   * Allow switching between the two prices.
   * Allow updating the payment method.
   * Add links to your terms and privacy pages.
3. **Apply migration `0028`** to a staging Supabase project (after 0018–0027).
4. **Edge Function secrets** (staging):
   ```
   supabase secrets set BILLING_ENABLED=true STRIPE_SECRET_KEY=sk_test_... \
     STRIPE_PRICE_MONTHLY=price_... STRIPE_PRICE_YEARLY=price_... \
     APP_URL=https://<your-preview-or-staging-domain> STRIPE_WEBHOOK_SECRET=whsec_...
   supabase functions deploy billing-checkout
   supabase functions deploy billing-portal
   supabase functions deploy stripe-webhook --no-verify-jwt
   ```
5. **Webhook endpoint** (Stripe → Developers → Webhooks): point it at `https://<project>.functions.supabase.co/stripe-webhook` with these events:
   * `checkout.session.completed`
   * `customer.subscription.created`
   * `customer.subscription.updated`
   * `customer.subscription.deleted`
   
   Copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
6. **Frontend (Preview only):** set `VITE_BILLING_ENABLED=true` in the Vercel *Preview* environment. Leave Production unset.

### Test plan (test mode)

* Use Stripe CLI `stripe listen --forward-to <webhook url>` and `stripe trigger customer.subscription.updated`. Check that a bad signature returns 400 and that a re-sent event returns `duplicate`.
* Pay with card `4242 4242 4242 4242`. You should come back to Settings → Plan showing "Student Pro is on" and a renewal date.
* Card `4000 0000 0000 0341` (attach, then the renewal fails) should show the past-due warning, then Free after the grace period.
* Cancel in the portal: the plan should show "Pro stays on until …", then Free when the period ends. Data must be untouched.
* User B cannot see user A's row, and no user can update their own row. This is already covered by PGlite; repeat it on staging.

## Launch gate (owner approval required)

Live mode is refused by code unless `STRIPE_LIVE_MODE_APPROVED=true` is set as
well as a `sk_live_` key. Before setting it:

* Legal review of terms and privacy, including renewal and cancellation wording and refund policy.
* Tax setup (Stripe Tax or equivalent), business details, statement descriptor.
* The full test plan above passing on staging.
* Explicit written approval from the owner.

## What is NOT verified

* Nothing has run against a real Stripe account, in either test or live mode.
* The Edge Functions have not been deployed or run under Deno. Their logic is tested in Node through the shared module.
* Checkout and Customer Portal pages are configured in the Stripe dashboard and haven't been seen.
