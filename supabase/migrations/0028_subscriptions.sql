-- 0028 — Subscriptions and Stripe webhook log (V5-E). Requires nothing
-- newer than the base schema.
--
-- ADDITIVE ONLY: two new tables. No existing table changes.
--
-- SECURITY MODEL (deliberate, reviewed exception to "four own-row policies"):
--   * public.subscriptions — one row per user, written ONLY by the
--     stripe-webhook / billing Edge Functions using the service role (which
--     bypasses RLS). Users get a SELECT-own policy and nothing else, so the
--     browser can read its plan but can never grant itself Pro.
--   * public.stripe_events — the webhook's idempotency log (Stripe event id
--     as primary key). RLS on with NO policies: no client can read or write.
--   * Billing is off until the owner sets Stripe test/live keys on the Edge
--     Functions (docs/BILLING.md). Without them these tables stay empty and
--     every account is on the beta plan.

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  plan text not null default 'free',
  status text not null default 'none',
  price_interval text,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  last_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subscriptions_plan_check check (plan in ('free', 'pro')),
  constraint subscriptions_status_check check (status in ('none', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused')),
  constraint subscriptions_interval_check check (price_interval is null or price_interval in ('month', 'year')),
  constraint subscriptions_customer_format check (stripe_customer_id is null or stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'),
  constraint subscriptions_subscription_format check (stripe_subscription_id is null or stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$')
);

create table if not exists public.stripe_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint stripe_events_id_format check (id ~ '^evt_[A-Za-z0-9]+$')
);

alter table public.subscriptions enable row level security;
alter table public.stripe_events enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'subscriptions' and policyname = 'subscriptions: select own') then
    create policy "subscriptions: select own" on public.subscriptions for select using (auth.uid() = user_id);
  end if;
end $$;
-- Intentionally no insert / update / delete policies on subscriptions, and
-- no policies at all on stripe_events (service role only).
