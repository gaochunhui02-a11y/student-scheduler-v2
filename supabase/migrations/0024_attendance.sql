-- 0024 — Attendance (V4-G). Requires 0010 (v3_assert_owned_ref) and 0011
-- (courses, class_series.course_id).
--
-- ADDITIVE ONLY: a new table public.attendance_records (+ RLS, four own-row
-- policies). Nothing existing changes.
--
-- A record is one class session of one course: (course, day, start time).
-- That key works the same for recurring classes, one-off classes and
-- generated class blocks, so marking attendance never depends on how the
-- class was entered. At most one record per session (unique index).
--   status: present | late | absent | excused
--   class_series_id: which recurring class it was (informational)
--
-- DELETION (deliberate):
--   * deleting a course deletes its attendance (CASCADE) — attendance has
--     no meaning without the course; the app's course delete already warns
--     that course data goes with it and recommends Archive
--   * deleting a recurring class keeps its records (class_series_id -> NULL)

create table if not exists public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  course_id uuid not null references public.courses (id) on delete cascade,
  class_series_id uuid references public.class_series (id) on delete set null,
  attended_on date not null,
  start_minutes int not null,
  status text not null default 'present',
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attendance_records_start_range check (start_minutes between 0 and 1439),
  constraint attendance_records_status_check check (status in ('present', 'late', 'absent', 'excused')),
  constraint attendance_records_note_length check (char_length(note) <= 500)
);

create unique index if not exists attendance_records_one_per_session on public.attendance_records (course_id, attended_on, start_minutes);
create index if not exists attendance_records_user_id_idx on public.attendance_records (user_id);
create index if not exists attendance_records_series_idx on public.attendance_records (class_series_id);

alter table public.attendance_records enable row level security;

do $$
declare
  tbl text;
begin
  foreach tbl in array array['attendance_records'] loop
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

drop trigger if exists attendance_records_course_owned on public.attendance_records;
create trigger attendance_records_course_owned
  before insert or update of course_id on public.attendance_records
  for each row execute function public.v3_assert_owned_ref('courses', 'course_id');

drop trigger if exists attendance_records_series_owned on public.attendance_records;
create trigger attendance_records_series_owned
  before insert or update of class_series_id on public.attendance_records
  for each row execute function public.v3_assert_owned_ref('class_series', 'class_series_id');
