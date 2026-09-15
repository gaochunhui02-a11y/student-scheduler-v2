-- Student Scheduler V2 — database schema
-- Run this once in your Supabase project: SQL Editor -> New query -> paste -> Run.
--
-- Tables:
--   profiles        one row per user (name), linked 1:1 to Supabase Auth
--   schedules       one row per planned day (wake/sleep/meal/break settings + the date)
--   classes         fixed classes for a given schedule
--   study_subjects  subjects + minutes requested for a given schedule
--   schedule_items  the generated result (class/meal/study/break/free blocks)
--
-- Every table has Row Level Security enabled so a user can only ever read or
-- write their own rows. There is no "service role" involved anywhere here.

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles: read own" on public.profiles
  for select using (auth.uid() = id);

create policy "profiles: update own" on public.profiles
  for update using (auth.uid() = id);

-- profiles are inserted automatically by the trigger below, not by the client,
-- so no insert policy is needed for normal app use.

-- Automatically create a profile row whenever someone signs up.
-- The "name" typed on the sign-up form is passed as auth metadata and read back here.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', ''));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------------------------------------------------------------------------
-- schedules — one row per planned day
-- ---------------------------------------------------------------------------
create table public.schedules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  for_date date not null,

  wake_time time not null default '07:00',
  sleep_time time not null default '22:30',

  breakfast_on boolean not null default true,
  breakfast_time time not null default '08:00',
  lunch_on boolean not null default true,
  lunch_time time not null default '12:30',
  dinner_on boolean not null default true,
  dinner_time time not null default '19:00',

  session_cap_minutes int not null default 60,
  stamina_break_minutes int not null default 15,
  switch_break_minutes int not null default 10,
  min_block_minutes int not null default 30,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (user_id, for_date)
);

alter table public.schedules enable row level security;

create policy "schedules: select own" on public.schedules
  for select using (auth.uid() = user_id);
create policy "schedules: insert own" on public.schedules
  for insert with check (auth.uid() = user_id);
create policy "schedules: update own" on public.schedules
  for update using (auth.uid() = user_id);
create policy "schedules: delete own" on public.schedules
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- classes — fixed commitments for a specific schedule
-- ---------------------------------------------------------------------------
create table public.classes (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.schedules (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  start_time time not null,
  end_time time not null,
  sort_order int not null default 0
);

alter table public.classes enable row level security;

create policy "classes: select own" on public.classes
  for select using (auth.uid() = user_id);
create policy "classes: insert own" on public.classes
  for insert with check (auth.uid() = user_id);
create policy "classes: update own" on public.classes
  for update using (auth.uid() = user_id);
create policy "classes: delete own" on public.classes
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- study_subjects — what the user wants to study for a specific schedule
-- ---------------------------------------------------------------------------
create table public.study_subjects (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.schedules (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  minutes_requested int not null check (minutes_requested > 0),
  sort_order int not null default 0
);

alter table public.study_subjects enable row level security;

create policy "study_subjects: select own" on public.study_subjects
  for select using (auth.uid() = user_id);
create policy "study_subjects: insert own" on public.study_subjects
  for insert with check (auth.uid() = user_id);
create policy "study_subjects: update own" on public.study_subjects
  for update using (auth.uid() = user_id);
create policy "study_subjects: delete own" on public.study_subjects
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- schedule_items — the generated schedule (classes/meals/study/break/free blocks)
-- ---------------------------------------------------------------------------
create table public.schedule_items (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.schedules (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  item_type text not null check (item_type in ('class', 'meal', 'study', 'break', 'free')),
  name text not null,
  start_minutes int not null,
  end_minutes int not null,
  sort_order int not null default 0
);

alter table public.schedule_items enable row level security;

create policy "schedule_items: select own" on public.schedule_items
  for select using (auth.uid() = user_id);
create policy "schedule_items: insert own" on public.schedule_items
  for insert with check (auth.uid() = user_id);
create policy "schedule_items: update own" on public.schedule_items
  for update using (auth.uid() = user_id);
create policy "schedule_items: delete own" on public.schedule_items
  for delete using (auth.uid() = user_id);
