-- Migration 0007 — Max Daily Study Minutes (V2-B, Planning Options)
--
-- Run once in your Supabase project: SQL Editor -> New query -> paste this
-- whole file -> Run. Safe to run on a database that already has schema.sql
-- and migrations 0001-0006 applied. Adds a single nullable column —
-- nothing existing is dropped, renamed, or has its type changed, and every
-- existing schedules row is unaffected: null means "no cap," which reads
-- back exactly as generateSchedule()/computeDayCapacity() in scheduler.js
-- already treat an omitted maxDailyStudyMinutes — a pre-existing row is
-- scheduled identically to how it always was.
--
-- What's new:
--   schedules.max_daily_study_minutes — a per-day hard ceiling on total
--     study minutes generateSchedule() will place (already-locked study
--     blocks count toward it). Part of the Planning Options panel, in the
--     same place and spirit as the existing session_cap_minutes/
--     stamina_break_minutes/switch_break_minutes/min_block_minutes columns.

alter table public.schedules
  add column if not exists max_daily_study_minutes int;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'schedules_max_daily_study_minutes_check'
  ) then
    alter table public.schedules
      add constraint schedules_max_daily_study_minutes_check
      check (max_daily_study_minutes is null or max_daily_study_minutes > 0);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Row Level Security — no changes needed. schedules already has RLS scoped
-- to auth.uid() = user_id, which covers this new column exactly like every
-- other column on the row.
-- ---------------------------------------------------------------------------
