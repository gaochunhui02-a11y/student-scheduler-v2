-- Migration 0005 — Task Tags + Subtasks (V2-A)
--
-- Run once in your Supabase project: SQL Editor -> New query -> paste this
-- whole file -> Run. Safe to run on a database that already has schema.sql
-- and migrations 0001-0004 applied. Adds one new nullable-free, defaulted
-- column to study_subjects and one brand-new table — nothing existing is
-- dropped, renamed, or has its type changed, and every existing row is
-- unaffected (a pre-existing study_subjects row simply reads back with
-- tags = '[]', i.e. "no tags," which is exactly correct for a row that
-- predates this feature).
--
-- What's new:
--   study_subjects.tags          — a small JSON array of plain strings
--     (e.g. ["Exam","Reading"]). Kept as jsonb rather than a lookup table:
--     tags here are lightweight, per-task labels with no shared metadata
--     (no color/description/ordering of their own) and no cross-task
--     reporting ever needs to join "every task with tag X" at the database
--     level — filtering happens client-side on already-loaded rows, exactly
--     like every other Study Tasks filter in this app.
--   study_subject_subtasks       — one row per subtask of a study task.
--     A separate table (not a jsonb column, unlike tags) because a subtask
--     has its own identity that must survive independent edits/reordering
--     (toggle one subtask's completed state without rewriting the others)
--     and its own RLS-enforced ownership, matching every other list-shaped
--     piece of data in this project (classes, study_subjects themselves).

-- ---------------------------------------------------------------------------
-- study_subjects: tags
-- ---------------------------------------------------------------------------
alter table public.study_subjects
  add column if not exists tags jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'study_subjects_tags_is_array'
  ) then
    alter table public.study_subjects
      add constraint study_subjects_tags_is_array
      check (jsonb_typeof(tags) = 'array');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- study_subject_subtasks — checklist items under one study_subjects row
-- ---------------------------------------------------------------------------
create table if not exists public.study_subject_subtasks (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references public.study_subjects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null default '',
  completed boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists study_subject_subtasks_subject_id_idx
  on public.study_subject_subtasks (subject_id);

alter table public.study_subject_subtasks enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'study_subject_subtasks' and policyname = 'study_subject_subtasks: select own') then
    create policy "study_subject_subtasks: select own" on public.study_subject_subtasks for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'study_subject_subtasks' and policyname = 'study_subject_subtasks: insert own') then
    create policy "study_subject_subtasks: insert own" on public.study_subject_subtasks for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'study_subject_subtasks' and policyname = 'study_subject_subtasks: update own') then
    create policy "study_subject_subtasks: update own" on public.study_subject_subtasks for update using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'study_subject_subtasks' and policyname = 'study_subject_subtasks: delete own') then
    create policy "study_subject_subtasks: delete own" on public.study_subject_subtasks for delete using (auth.uid() = user_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Cascade behavior: deleting a study_subjects row deletes its subtasks too
-- (on delete cascade above) — a subtask never outlives the task it belongs
-- to, matching how classes/study_subjects already cascade from schedules.
-- ---------------------------------------------------------------------------
