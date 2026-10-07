-- 0010 — Semesters (V3-B) + shared ownership guard used by later V3 migrations.
--
-- ADDITIVE ONLY: one new table, one new helper function. Touches no existing
-- table or row. Safe to re-run (IF NOT EXISTS / CREATE OR REPLACE / guarded
-- policy creation).
--
-- semesters: a named term (e.g. "Fall 2026") with a start/end date, optional
-- breaks, and at most one flagged as the user's current semester.
--
-- breaks is a JSON array of { "name": text, "start_date": "YYYY-MM-DD",
-- "end_date": "YYYY-MM-DD" } objects. Only its array-ness is enforced here;
-- the app validates the shape (src/academics/semesterModel.js).

create table if not exists public.semesters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  start_date date not null,
  end_date date not null,
  breaks jsonb not null default '[]'::jsonb,
  is_current boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint semesters_name_length check (char_length(name) between 1 and 120),
  constraint semesters_date_order check (end_date >= start_date),
  constraint semesters_max_span check (end_date - start_date <= 400),
  constraint semesters_breaks_is_array check (jsonb_typeof(breaks) = 'array')
);

create index if not exists semesters_user_id_idx on public.semesters (user_id);

-- At most one current semester per user (partial unique index).
create unique index if not exists semesters_one_current_per_user
  on public.semesters (user_id) where is_current;

alter table public.semesters enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'semesters' and policyname = 'semesters: select own') then
    create policy "semesters: select own" on public.semesters for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'semesters' and policyname = 'semesters: insert own') then
    create policy "semesters: insert own" on public.semesters for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'semesters' and policyname = 'semesters: update own') then
    create policy "semesters: update own" on public.semesters for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'semesters' and policyname = 'semesters: delete own') then
    create policy "semesters: delete own" on public.semesters for delete using (auth.uid() = user_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- v3_assert_owned_ref(): BEFORE INSERT/UPDATE trigger guard.
--
-- A foreign key only proves the referenced row EXISTS — Postgres checks it
-- without RLS — so on its own it would let a user point their own row at
-- someone else's course/semester/exam id. This trigger rejects any reference
-- whose target row doesn't belong to the same user_id as the row being
-- written. Usage:
--   create trigger … before insert or update of <col> on public.<table>
--   for each row execute function public.v3_assert_owned_ref('<target table>', '<col>');
--
-- SECURITY INVOKER: the lookup runs under the caller's own RLS, so it can
-- never reveal anything about rows the caller couldn't already read.
-- ---------------------------------------------------------------------------
create or replace function public.v3_assert_owned_ref()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_table text := tg_argv[0];
  ref_column text := tg_argv[1];
  ref_id uuid;
  is_owned boolean;
begin
  execute format('select ($1).%I', ref_column) using new into ref_id;
  if ref_id is null then
    return new;
  end if;
  execute format('select exists (select 1 from public.%I where id = $1 and user_id = $2)', target_table)
    using ref_id, new.user_id
    into is_owned;
  if not is_owned then
    raise exception 'The referenced % row does not belong to this user', target_table
      using errcode = '42501';
  end if;
  return new;
end;
$$;
