-- 0013 — Exams and revision topics (V3-D). Requires 0010 + 0011.
--
-- ADDITIVE ONLY: two new tables with RLS. No existing table is touched.
--
-- exams: a dated assessment, optionally linked to a course (deleting the
--        course keeps the exam, unlinked).
-- exam_topics: what to revise for an exam, with the student's own estimate
--        of difficulty (1–3), confidence (1–5), study minutes needed and
--        minutes already revised. Deleted with their exam.

create table if not exists public.exams (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  course_id uuid references public.courses (id) on delete set null,
  name text not null,
  exam_date date not null,
  start_time time,
  duration_minutes int,
  location text,
  weight numeric(6, 3),
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint exams_name_length check (char_length(name) between 1 and 120),
  constraint exams_duration_range check (duration_minutes is null or (duration_minutes > 0 and duration_minutes <= 720)),
  constraint exams_location_length check (location is null or char_length(location) <= 120),
  constraint exams_weight_range check (weight is null or (weight >= 0 and weight <= 100)),
  constraint exams_notes_length check (char_length(notes) <= 5000)
);

create index if not exists exams_user_id_idx on public.exams (user_id);
create index if not exists exams_course_id_idx on public.exams (course_id);
create index if not exists exams_user_date_idx on public.exams (user_id, exam_date);

create table if not exists public.exam_topics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  exam_id uuid not null references public.exams (id) on delete cascade,
  name text not null,
  difficulty smallint not null default 2,
  confidence smallint not null default 3,
  estimated_minutes int not null default 60,
  completed_minutes int not null default 0,
  status text not null default 'not_started',
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint exam_topics_name_length check (char_length(name) between 1 and 120),
  constraint exam_topics_difficulty_range check (difficulty between 1 and 3),
  constraint exam_topics_confidence_range check (confidence between 1 and 5),
  constraint exam_topics_estimate_range check (estimated_minutes > 0 and estimated_minutes <= 6000),
  constraint exam_topics_completed_range check (completed_minutes >= 0 and completed_minutes <= 20000),
  constraint exam_topics_status_check check (status in ('not_started', 'in_progress', 'done'))
);

create index if not exists exam_topics_user_id_idx on public.exam_topics (user_id);
create index if not exists exam_topics_exam_id_idx on public.exam_topics (exam_id);

alter table public.exams enable row level security;
alter table public.exam_topics enable row level security;

do $$
declare
  tbl text;
begin
  foreach tbl in array array['exams', 'exam_topics'] loop
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

drop trigger if exists exams_course_owned on public.exams;
create trigger exams_course_owned
  before insert or update of course_id on public.exams
  for each row execute function public.v3_assert_owned_ref('courses', 'course_id');

drop trigger if exists exam_topics_exam_owned on public.exam_topics;
create trigger exam_topics_exam_owned
  before insert or update of exam_id on public.exam_topics
  for each row execute function public.v3_assert_owned_ref('exams', 'exam_id');
