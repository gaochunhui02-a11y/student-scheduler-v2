-- 0027 — Product events and in-app feedback (V5-D). Requires nothing newer
-- than the base schema.
--
-- ADDITIVE ONLY: two new tables, public.product_events and public.feedback
-- (+ RLS, four own-row policies each). No existing table changes.
--
-- PRIVACY (deliberate):
--   * product_events is OPT-IN — the app only writes here after the student
--     agreed in Settings → Privacy (and never when the browser sends Do Not
--     Track / Global Privacy Control unless they opted in explicitly).
--   * Event names come from a fixed allow-list (CHECK below); props are a
--     tiny JSON object of counts/labels (size-capped) — never task names,
--     course names, emails or free text.
--   * Every row belongs to its user (on delete cascade with the account) and
--     the user may delete their own rows; nobody can read anyone else's.
--     The owner reads aggregates with the service role (docs/ANALYTICS.md).
--   * feedback holds what the student chose to send us, with the page it
--     was sent from and the app version; nothing else is attached.

create table if not exists public.product_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  props jsonb not null default '{}'::jsonb,
  app_version text not null default '',
  created_at timestamptz not null default now(),
  constraint product_events_name_allowed check (name in (
    'session_start', 'signup_started', 'signup_completed', 'onboarding_completed', 'onboarding_skipped',
    'first_schedule_generated', 'plan_applied', 'catchup_applied', 'import_completed', 'tour_completed',
    'pro_interest', 'upgrade_started', 'subscription_started', 'feedback_sent'
  )),
  constraint product_events_props_object check (jsonb_typeof(props) = 'object'),
  constraint product_events_props_size check (pg_column_size(props) <= 512),
  constraint product_events_version_length check (char_length(app_version) <= 32)
);

create index if not exists product_events_name_created_idx on public.product_events (name, created_at);
create index if not exists product_events_user_created_idx on public.product_events (user_id, created_at);

create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null default 'idea',
  message text not null,
  page text not null default '',
  app_version text not null default '',
  created_at timestamptz not null default now(),
  constraint feedback_kind_check check (kind in ('bug', 'confusing', 'idea', 'other')),
  constraint feedback_message_length check (char_length(message) between 1 and 4000),
  constraint feedback_page_length check (char_length(page) <= 64),
  constraint feedback_version_length check (char_length(app_version) <= 32)
);

create index if not exists feedback_created_idx on public.feedback (created_at desc);
create index if not exists feedback_user_idx on public.feedback (user_id);

alter table public.product_events enable row level security;
alter table public.feedback enable row level security;

do $$
declare
  tbl text;
begin
  foreach tbl in array array['product_events', 'feedback'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = tbl and policyname = tbl || ': select own') then
      execute format('create policy %I on public.%I for select using (auth.uid() = user_id)', tbl || ': select own', tbl);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = tbl and policyname = tbl || ': insert own') then
      execute format('create policy %I on public.%I for insert with check (auth.uid() = user_id)', tbl || ': insert own', tbl);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = tbl and policyname = tbl || ': update own') then
      execute format('create policy %I on public.%I for update using (auth.uid() = user_id) with check (auth.uid() = user_id)', tbl || ': update own', tbl);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = tbl and policyname = tbl || ': delete own') then
      execute format('create policy %I on public.%I for delete using (auth.uid() = user_id)', tbl || ': delete own', tbl);
    end if;
  end loop;
end $$;
