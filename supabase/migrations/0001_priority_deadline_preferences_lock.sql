-- Migration 0001 — priority/deadline, study preferences, lock + complete
--
-- Run once in your Supabase project: SQL Editor -> New query -> paste this
-- whole file -> Run. Safe to run on a database that already has the base
-- schema from supabase/schema.sql applied and already has real rows in it —
-- every new column is added with a default and/or as nullable, so existing
-- rows are filled in automatically and nothing existing is dropped, renamed,
-- or has its type changed. This does not touch Supabase Auth, RLS is left in
-- place exactly as it already is (see notes at the bottom), and the
-- `secret`/`service_role` key is never needed to run this — the same
-- SQL Editor session you used for schema.sql is enough.
--
-- What already exists and is being reused (no new columns needed for these):
--   schedules.session_cap_minutes   -> "maximum study session length"
--   schedules.min_block_minutes     -> "minimum study block length"
--   schedules.switch_break_minutes  -> "preferred break length" (between subjects)
--   schedules.stamina_break_minutes -> break length within a long single-subject session
--
-- What's new:
--   study_subjects.priority, due_date, notes   (feature 1)
--   schedules.preferred_study_period,
--     earliest_study_time, latest_study_time   (features 2 & 3)
--   schedule_items.locked, completed,
--     source_subject_id                        (features 4, 6, 7)

-- ---------------------------------------------------------------------------
-- study_subjects: priority + deadline + notes
-- ---------------------------------------------------------------------------
alter table public.study_subjects
  add column if not exists priority text not null default 'medium',
  add column if not exists due_date date,
  add column if not exists notes text not null default '';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'study_subjects_priority_check'
  ) then
    alter table public.study_subjects
      add constraint study_subjects_priority_check
      check (priority in ('low', 'medium', 'high'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- schedules: preferred study time-of-day + earliest/latest study time window
-- (earliest/latest study time are independent of wake_time/sleep_time — e.g.
-- a student who wakes at 7am may not want to start studying before 9am, or
-- may want to stop studying at 10pm even though bedtime is 1am)
-- ---------------------------------------------------------------------------
alter table public.schedules
  add column if not exists preferred_study_period text not null default 'none',
  add column if not exists earliest_study_time time,
  add column if not exists latest_study_time time;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'schedules_preferred_study_period_check'
  ) then
    alter table public.schedules
      add constraint schedules_preferred_study_period_check
      check (preferred_study_period in ('none', 'morning', 'afternoon', 'evening'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- schedule_items: lock state, completion state, and a link back to the
-- study_subjects row a study block was generated from (needed to report
-- "which subjects were only partially scheduled" and to compute per-subject
-- progress). Nullable + on delete set null: deleting a subject later should
-- never silently delete a student's completion history.
-- ---------------------------------------------------------------------------
alter table public.schedule_items
  add column if not exists locked boolean not null default false,
  add column if not exists completed boolean not null default false,
  add column if not exists source_subject_id uuid references public.study_subjects (id) on delete set null;

create index if not exists schedule_items_source_subject_id_idx
  on public.schedule_items (source_subject_id);

-- ---------------------------------------------------------------------------
-- Row Level Security — no changes needed.
-- All three tables already have RLS enabled with select/insert/update/delete
-- policies scoped to `auth.uid() = user_id`, and that check applies to every
-- column on the row (old and new alike). New columns are automatically
-- covered by the existing policies — nothing to add, nothing weakened.
-- ---------------------------------------------------------------------------
