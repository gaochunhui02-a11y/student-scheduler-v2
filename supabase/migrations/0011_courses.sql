-- 0011 — Courses (V3-A). Requires 0010 (semesters + v3_assert_owned_ref).
--
-- ADDITIVE ONLY:
--   * new table public.courses (+ RLS)
--   * new NULLABLE course_id column on study_subjects, classes, class_series,
--     boards, board_nodes — every existing row simply gets NULL ("no course"),
--     which is exactly how V2 behaves today. No existing value is rewritten.
--   * ON DELETE SET NULL everywhere: deleting a course never deletes a task,
--     class, or board — they just become "no course" again.
--   * ownership triggers so a row can only point at the same user's course.

create table if not exists public.courses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  semester_id uuid references public.semesters (id) on delete set null,
  name text not null,
  code text,
  instructor text,
  color text,
  location text,
  notes text not null default '',
  target_grade numeric(5, 2),
  credits numeric(4, 1),
  archived boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint courses_name_length check (char_length(name) between 1 and 120),
  constraint courses_code_length check (code is null or char_length(code) <= 32),
  constraint courses_instructor_length check (instructor is null or char_length(instructor) <= 120),
  constraint courses_location_length check (location is null or char_length(location) <= 120),
  constraint courses_notes_length check (char_length(notes) <= 5000),
  constraint courses_color_hex check (color is null or color ~ '^#[0-9A-Fa-f]{6}$'),
  constraint courses_target_grade_range check (target_grade is null or (target_grade >= 0 and target_grade <= 100)),
  constraint courses_credits_range check (credits is null or (credits >= 0 and credits <= 50))
);

create index if not exists courses_user_id_idx on public.courses (user_id);
create index if not exists courses_semester_id_idx on public.courses (semester_id);

alter table public.courses enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'courses' and policyname = 'courses: select own') then
    create policy "courses: select own" on public.courses for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'courses' and policyname = 'courses: insert own') then
    create policy "courses: insert own" on public.courses for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'courses' and policyname = 'courses: update own') then
    create policy "courses: update own" on public.courses for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'courses' and policyname = 'courses: delete own') then
    create policy "courses: delete own" on public.courses for delete using (auth.uid() = user_id);
  end if;
end $$;

drop trigger if exists courses_semester_owned on public.courses;
create trigger courses_semester_owned
  before insert or update of semester_id on public.courses
  for each row execute function public.v3_assert_owned_ref('semesters', 'semester_id');

-- ---------------- course links on existing tables (nullable) ----------------
alter table public.study_subjects add column if not exists course_id uuid references public.courses (id) on delete set null;
alter table public.classes add column if not exists course_id uuid references public.courses (id) on delete set null;
alter table public.class_series add column if not exists course_id uuid references public.courses (id) on delete set null;
alter table public.boards add column if not exists course_id uuid references public.courses (id) on delete set null;
alter table public.board_nodes add column if not exists course_id uuid references public.courses (id) on delete set null;

create index if not exists study_subjects_course_id_idx on public.study_subjects (course_id);
create index if not exists classes_course_id_idx on public.classes (course_id);
create index if not exists class_series_course_id_idx on public.class_series (course_id);
create index if not exists boards_course_id_idx on public.boards (course_id);
create index if not exists board_nodes_course_id_idx on public.board_nodes (course_id);

drop trigger if exists study_subjects_course_owned on public.study_subjects;
create trigger study_subjects_course_owned
  before insert or update of course_id on public.study_subjects
  for each row execute function public.v3_assert_owned_ref('courses', 'course_id');

drop trigger if exists classes_course_owned on public.classes;
create trigger classes_course_owned
  before insert or update of course_id on public.classes
  for each row execute function public.v3_assert_owned_ref('courses', 'course_id');

drop trigger if exists class_series_course_owned on public.class_series;
create trigger class_series_course_owned
  before insert or update of course_id on public.class_series
  for each row execute function public.v3_assert_owned_ref('courses', 'course_id');

drop trigger if exists boards_course_owned on public.boards;
create trigger boards_course_owned
  before insert or update of course_id on public.boards
  for each row execute function public.v3_assert_owned_ref('courses', 'course_id');

drop trigger if exists board_nodes_course_owned on public.board_nodes;
create trigger board_nodes_course_owned
  before insert or update of course_id on public.board_nodes
  for each row execute function public.v3_assert_owned_ref('courses', 'course_id');
