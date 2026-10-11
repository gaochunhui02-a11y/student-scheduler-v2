-- 0025 — Notes (V4-H). Requires 0010 (v3_assert_owned_ref), 0011 (courses),
-- 0013 (exams), 0018 (spaces), 0019 (projects), 0022 (goals).
--
-- ADDITIVE ONLY: a new table public.notes (+ RLS, four own-row policies).
--
-- A note is the student's own text (lecture notes, meeting notes, ideas).
-- It can optionally belong to ONE thing of each kind — a course, a project,
-- a goal, an exam and/or a task — and to a space; every link is
-- ownership-checked.
--
-- DELETION (deliberate): notes are the student's writing, so deleting what
-- a note is linked to NEVER deletes the note — every link is ON DELETE SET
-- NULL and the note simply becomes unlinked. Deleting a note is confirmed
-- in the app; archiving is the gentle alternative.
--
-- The body is plain text with a small Markdown subset rendered by the app
-- (src/notes/noteMarkdown.js), which escapes everything and only allows
-- http(s) links — no HTML is ever stored or rendered from a note.

create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  space_id uuid references public.spaces (id) on delete set null,
  course_id uuid references public.courses (id) on delete set null,
  project_id uuid references public.projects (id) on delete set null,
  goal_id uuid references public.goals (id) on delete set null,
  exam_id uuid references public.exams (id) on delete set null,
  task_id uuid references public.study_subjects (id) on delete set null,
  title text not null default '',
  body text not null default '',
  tags jsonb not null default '[]'::jsonb,
  pinned boolean not null default false,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notes_title_length check (char_length(title) <= 200),
  constraint notes_body_length check (char_length(body) <= 50000),
  constraint notes_tags_array check (jsonb_typeof(tags) = 'array' and jsonb_array_length(tags) <= 20)
);

create index if not exists notes_user_updated_idx on public.notes (user_id, updated_at desc);
create index if not exists notes_course_id_idx on public.notes (course_id);
create index if not exists notes_project_id_idx on public.notes (project_id);
create index if not exists notes_goal_id_idx on public.notes (goal_id);
create index if not exists notes_exam_id_idx on public.notes (exam_id);
create index if not exists notes_task_id_idx on public.notes (task_id);
create index if not exists notes_space_id_idx on public.notes (space_id);

alter table public.notes enable row level security;

do $$
declare
  tbl text;
begin
  foreach tbl in array array['notes'] loop
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

drop trigger if exists notes_space_owned on public.notes;
create trigger notes_space_owned before insert or update of space_id on public.notes
  for each row execute function public.v3_assert_owned_ref('spaces', 'space_id');
drop trigger if exists notes_course_owned on public.notes;
create trigger notes_course_owned before insert or update of course_id on public.notes
  for each row execute function public.v3_assert_owned_ref('courses', 'course_id');
drop trigger if exists notes_project_owned on public.notes;
create trigger notes_project_owned before insert or update of project_id on public.notes
  for each row execute function public.v3_assert_owned_ref('projects', 'project_id');
drop trigger if exists notes_goal_owned on public.notes;
create trigger notes_goal_owned before insert or update of goal_id on public.notes
  for each row execute function public.v3_assert_owned_ref('goals', 'goal_id');
drop trigger if exists notes_exam_owned on public.notes;
create trigger notes_exam_owned before insert or update of exam_id on public.notes
  for each row execute function public.v3_assert_owned_ref('exams', 'exam_id');
drop trigger if exists notes_task_owned on public.notes;
create trigger notes_task_owned before insert or update of task_id on public.notes
  for each row execute function public.v3_assert_owned_ref('study_subjects', 'task_id');
