-- 0023 — Routines (V4-C). Requires 0010 (v3_assert_owned_ref), 0018 (spaces)
-- and 0022 (goals).
--
-- A routine is a repeating habit ("Gym", "Read 20 minutes", "Duolingo") that
-- the student ticks off per day. It is NOT a task: it never creates
-- study_subjects rows, so the Planner, Tasks and Carry Over are unaffected.
--
-- ADDITIVE ONLY: new tables public.routines and public.routine_completions
-- (+ RLS, four own-row policies each). Nothing existing changes.
--
-- SCHEDULE (frequency):
--   daily        — every day
--   days         — chosen weekdays (days_of_week, 0 = Sunday … 6 = Saturday)
--   weekly_count — N times a week on any days (weekly_target, 1–7)
--
-- COMPLETIONS: at most one row per routine per day (unique index), status
-- 'done' or 'skipped' (a planned day off: it neither counts nor breaks a
-- streak). Un-ticking deletes the row.
--
-- PAUSE: paused_at remembers the first paused day. On resume the app
-- records the paused days as 'skipped', so a pause never breaks a streak.
--
-- DELETION (deliberate): deleting a routine deletes its completion history
-- (CASCADE) — the app confirms and recommends Pause or Archive instead.
-- Deleting a goal or space only clears routines.goal_id / space_id.

create table if not exists public.routines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  space_id uuid references public.spaces (id) on delete set null,
  goal_id uuid references public.goals (id) on delete set null,
  title text not null,
  notes text not null default '',
  frequency text not null default 'daily',
  days_of_week jsonb not null default '[]'::jsonb,
  weekly_target int not null default 3,
  time_of_day text not null default 'anytime',
  duration_minutes int,
  start_date date not null default current_date,
  end_date date,
  paused boolean not null default false,
  paused_at date,
  archived boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint routines_title_length check (char_length(btrim(title)) between 1 and 120),
  constraint routines_notes_length check (char_length(notes) <= 2000),
  constraint routines_frequency_check check (frequency in ('daily', 'days', 'weekly_count')),
  constraint routines_days_is_array check (jsonb_typeof(days_of_week) = 'array' and jsonb_array_length(days_of_week) <= 7),
  constraint routines_days_needed check (frequency <> 'days' or jsonb_array_length(days_of_week) >= 1),
  constraint routines_weekly_target_range check (weekly_target between 1 and 7),
  constraint routines_time_of_day_check check (time_of_day in ('anytime', 'morning', 'afternoon', 'evening')),
  constraint routines_duration_range check (duration_minutes is null or (duration_minutes between 1 and 1440)),
  constraint routines_date_order check (end_date is null or end_date >= start_date),
  constraint routines_paused_at check (paused or paused_at is null)
);

create index if not exists routines_user_id_idx on public.routines (user_id);
create index if not exists routines_space_id_idx on public.routines (space_id);
create index if not exists routines_goal_id_idx on public.routines (goal_id);

create table if not exists public.routine_completions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  routine_id uuid not null references public.routines (id) on delete cascade,
  completed_on date not null,
  status text not null default 'done',
  note text not null default '',
  created_at timestamptz not null default now(),
  constraint routine_completions_status_check check (status in ('done', 'skipped')),
  constraint routine_completions_note_length check (char_length(note) <= 500)
);

create unique index if not exists routine_completions_one_per_day on public.routine_completions (routine_id, completed_on);
create index if not exists routine_completions_user_date_idx on public.routine_completions (user_id, completed_on);

alter table public.routines enable row level security;
alter table public.routine_completions enable row level security;

do $$
declare
  tbl text;
begin
  foreach tbl in array array['routines', 'routine_completions'] loop
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

drop trigger if exists routines_space_owned on public.routines;
create trigger routines_space_owned
  before insert or update of space_id on public.routines
  for each row execute function public.v3_assert_owned_ref('spaces', 'space_id');

drop trigger if exists routines_goal_owned on public.routines;
create trigger routines_goal_owned
  before insert or update of goal_id on public.routines
  for each row execute function public.v3_assert_owned_ref('goals', 'goal_id');

drop trigger if exists routine_completions_routine_owned on public.routine_completions;
create trigger routine_completions_routine_owned
  before insert or update of routine_id on public.routine_completions
  for each row execute function public.v3_assert_owned_ref('routines', 'routine_id');
