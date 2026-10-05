-- Migration 0006 — Recurring Classes (V2-B)
--
-- Run once in your Supabase project: SQL Editor -> New query -> paste this
-- whole file -> Run. Safe to run on a database that already has schema.sql
-- and migrations 0001-0005 applied. Adds two brand-new tables and one
-- additive, defaulted column on the existing `classes` table — nothing
-- existing is dropped, renamed, or has its type changed, and every
-- existing `classes` row reads back exactly as it always has
-- (source = 'manual', which is the honest default: every class entered
-- before this migration was entered by hand, one date at a time).
--
-- Design note (read before touching src/dashboard/recurringClasses.js):
-- a recurring class is NEVER materialized into the `classes` table just
-- because a day was viewed or the app loaded — that is exactly the
-- "duplicate classes every time the app loads" failure mode this feature
-- must avoid. `classes` stays the single source of truth for an AD-HOC
-- (one-off, hand-typed) class on one specific date, exactly as it already
-- is today. A recurring class's actual occurrences are computed in memory,
-- on demand, from `class_series` + `class_series_exceptions` only — see
-- the pure, tested resolution logic in src/dashboard/recurringClasses.js.
-- The only two things ever WRITTEN for a recurring class are:
--   1. the `class_series` row itself (created once, edited in place to
--      change every future occurrence, deleted once to remove all of them)
--   2. a `class_series_exceptions` row, created ONLY when the student
--      explicitly edits or deletes ONE specific occurrence — never as a
--      side effect of merely viewing a date.
--
-- What's new:
--   class_series             — a recurring class definition: which days of
--     the week, what time, over what date range.
--   class_series_exceptions  — a per-date override or skip for one series,
--     so editing/deleting a single occurrence never touches the series
--     definition or creates a duplicate `classes` row.
--   classes.source           — lets a class row say whether it was typed by
--     hand, imported from a .ics file (Phase 12), or (reserved for a
--     possible future "pin this occurrence" action) copied from a series —
--     today every existing and newly-typed row is 'manual'.

-- ---------------------------------------------------------------------------
-- class_series
--
-- days_of_week is a jsonb array of integers 0-6 using JavaScript's own
-- Date#getDay() convention (0 = Sunday ... 6 = Saturday) — deliberately the
-- SAME convention src/dashboard/recurringClasses.js uses to check "does
-- this series occur on date X" via `new Date(dateStr).getDay()`, so there is
-- never a remapping step between storage and the one place that reads it.
-- This is unrelated to (and intentionally different from) the Week View's
-- own Monday-first grid ordering (src/week/weekModel.js) — that's a display
-- choice for a 7-day grid, not a recurrence-matching rule, and the two were
-- never meant to share a convention.
-- ---------------------------------------------------------------------------
create table if not exists public.class_series (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  days_of_week jsonb not null default '[]'::jsonb,
  start_time time not null,
  end_time time not null,
  start_date date not null,
  end_date date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'class_series_days_of_week_is_array') then
    alter table public.class_series
      add constraint class_series_days_of_week_is_array
      check (jsonb_typeof(days_of_week) = 'array');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'class_series_time_order') then
    alter table public.class_series
      add constraint class_series_time_order
      check (end_time > start_time);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'class_series_date_order') then
    alter table public.class_series
      add constraint class_series_date_order
      check (end_date >= start_date);
  end if;
end $$;

create index if not exists class_series_user_id_idx on public.class_series (user_id);

alter table public.class_series enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'class_series' and policyname = 'class_series: select own') then
    create policy "class_series: select own" on public.class_series for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'class_series' and policyname = 'class_series: insert own') then
    create policy "class_series: insert own" on public.class_series for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'class_series' and policyname = 'class_series: update own') then
    create policy "class_series: update own" on public.class_series for update using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'class_series' and policyname = 'class_series: delete own') then
    create policy "class_series: delete own" on public.class_series for delete using (auth.uid() = user_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- class_series_exceptions — one row per EDITED or DELETED single occurrence
-- of a series. unique(series_id, exception_date) means a given date can
-- only ever carry one override: either "skip" (deleted that one day) or
-- "modify" (different time/name that one day), never both at once.
-- override_* columns are only meaningful when action = 'modify'; left null
-- for a 'skip' row.
-- ---------------------------------------------------------------------------
create table if not exists public.class_series_exceptions (
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null references public.class_series (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  exception_date date not null,
  action text not null,
  override_name text,
  override_start_time time,
  override_end_time time,
  created_at timestamptz not null default now(),
  unique (series_id, exception_date)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'class_series_exceptions_action_check') then
    alter table public.class_series_exceptions
      add constraint class_series_exceptions_action_check
      check (action in ('skip', 'modify'));
  end if;
end $$;

create index if not exists class_series_exceptions_series_id_idx on public.class_series_exceptions (series_id);

alter table public.class_series_exceptions enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'class_series_exceptions' and policyname = 'class_series_exceptions: select own') then
    create policy "class_series_exceptions: select own" on public.class_series_exceptions for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'class_series_exceptions' and policyname = 'class_series_exceptions: insert own') then
    create policy "class_series_exceptions: insert own" on public.class_series_exceptions for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'class_series_exceptions' and policyname = 'class_series_exceptions: update own') then
    create policy "class_series_exceptions: update own" on public.class_series_exceptions for update using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'class_series_exceptions' and policyname = 'class_series_exceptions: delete own') then
    create policy "class_series_exceptions: delete own" on public.class_series_exceptions for delete using (auth.uid() = user_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- classes.source — distinguishes a hand-typed class from an imported (.ics,
-- Phase 12) one. Every pre-existing row defaults to 'manual', which is
-- simply true: nothing before this migration could have been anything else.
-- ---------------------------------------------------------------------------
alter table public.classes
  add column if not exists source text not null default 'manual';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'classes_source_check') then
    alter table public.classes
      add constraint classes_source_check
      check (source in ('manual', 'imported', 'recurring'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Row Level Security on `classes` itself — no changes needed. It already
-- has RLS scoped to auth.uid() = user_id, which covers the new `source`
-- column exactly like every other column on the row.
-- ---------------------------------------------------------------------------
