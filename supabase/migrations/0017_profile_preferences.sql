-- Migration 0017 — Account-wide study preferences (V3)
--
-- Run AFTER 0010–0016, once, in the Supabase SQL Editor. Not applied
-- automatically by anything in this repo.
--
-- ADDITIVE ONLY. Adds one column to profiles with a constant default
-- (Postgres 11+ adds it without rewriting the table). Existing rows read
-- as '{}' = "no preference saved", which is exactly how the app behaves
-- today. Nothing is dropped, renamed, updated or deleted; no policy is
-- changed. The existing "profiles: read own" / "profiles: update own"
-- policies already restrict this column to its owner.
--
-- What's new:
--   profiles.preferences — small JSON object of account-wide settings.
--     Keys the app reads today:
--       maxDailyStudyMinutes  (int, 30–960) default daily study ceiling
--                             used by the workload forecast, exam
--                             revision planner and Smart Rebalance.
--     Unknown keys are ignored by the app.
--
-- The V2 (v1.x) app never selects this column, so it is unaffected.

alter table public.profiles
  add column if not exists preferences jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_preferences_is_object'
  ) then
    alter table public.profiles
      add constraint profiles_preferences_is_object check (jsonb_typeof(preferences) = 'object');
  end if;
end $$;
