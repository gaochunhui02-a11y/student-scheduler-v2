-- 0019 — Projects + milestones (V4-B). Requires 0010 (v3_assert_owned_ref)
-- and 0018 (spaces).
--
-- ADDITIVE ONLY:
--   * new tables public.projects and public.project_milestones (+ RLS)
--   * new NULLABLE project_id and project_milestone_id on study_subjects
--     (tasks). Every existing task gets NULL = "not in a project", exactly
--     how V3 / V4-A show it. Nothing existing is rewritten.
--
-- DELETION (deliberate):
--   * deleting a project NEVER deletes tasks: study_subjects.project_id is
--     ON DELETE SET NULL, so its tasks stay (with their blocks, history and
--     focus time) and simply stop belonging to a project.
--   * a project's milestones ARE deleted with it (ON DELETE CASCADE) — a
--     milestone has no meaning outside its project and holds no work.
--   * deleting a milestone only clears study_subjects.project_milestone_id.
--   * archiving (status = 'archived') is the normal way to put a project
--     away; delete exists for mistakes and is confirmed in the app.
--
-- Ownership triggers stop a row pointing at another user's space, project
-- or milestone, and a task's milestone must belong to the task's project.

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  space_id uuid references public.spaces (id) on delete set null,
  title text not null,
  description text not null default '',
  status text not null default 'active',
  priority text not null default 'medium',
  start_date date,
  due_date date,
  estimated_minutes int,
  progress_mode text not null default 'auto',
  manual_progress int,
  sort_order int not null default 0,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint projects_title_length check (char_length(btrim(title)) between 1 and 120),
  constraint projects_description_length check (char_length(description) <= 5000),
  constraint projects_status_check check (status in ('planned', 'active', 'on_hold', 'completed', 'archived')),
  constraint projects_priority_check check (priority in ('low', 'medium', 'high')),
  constraint projects_date_order check (start_date is null or due_date is null or due_date >= start_date),
  constraint projects_estimate_range check (estimated_minutes is null or (estimated_minutes > 0 and estimated_minutes <= 1000000)),
  constraint projects_progress_mode_check check (progress_mode in ('auto', 'manual')),
  constraint projects_manual_progress_range check (manual_progress is null or (manual_progress between 0 and 100))
);

create index if not exists projects_user_id_idx on public.projects (user_id);
create index if not exists projects_space_id_idx on public.projects (space_id);
create index if not exists projects_user_status_idx on public.projects (user_id, status);

create table if not exists public.project_milestones (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  title text not null,
  description text not null default '',
  due_date date,
  status text not null default 'open',
  completed_at timestamptz,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_milestones_title_length check (char_length(btrim(title)) between 1 and 120),
  constraint project_milestones_description_length check (char_length(description) <= 2000),
  constraint project_milestones_status_check check (status in ('open', 'done'))
);

create index if not exists project_milestones_user_id_idx on public.project_milestones (user_id);
create index if not exists project_milestones_project_id_idx on public.project_milestones (project_id);

alter table public.projects enable row level security;
alter table public.project_milestones enable row level security;

do $$
declare
  tbl text;
begin
  foreach tbl in array array['projects', 'project_milestones'] loop
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

drop trigger if exists projects_space_owned on public.projects;
create trigger projects_space_owned
  before insert or update of space_id on public.projects
  for each row execute function public.v3_assert_owned_ref('spaces', 'space_id');

drop trigger if exists project_milestones_project_owned on public.project_milestones;
create trigger project_milestones_project_owned
  before insert or update of project_id on public.project_milestones
  for each row execute function public.v3_assert_owned_ref('projects', 'project_id');

-- ---------------- task links (nullable) ----------------
alter table public.study_subjects add column if not exists project_id uuid references public.projects (id) on delete set null;
alter table public.study_subjects add column if not exists project_milestone_id uuid references public.project_milestones (id) on delete set null;

create index if not exists study_subjects_project_id_idx on public.study_subjects (project_id);
create index if not exists study_subjects_project_milestone_id_idx on public.study_subjects (project_milestone_id);

drop trigger if exists study_subjects_project_owned on public.study_subjects;
create trigger study_subjects_project_owned
  before insert or update of project_id on public.study_subjects
  for each row execute function public.v3_assert_owned_ref('projects', 'project_id');

drop trigger if exists study_subjects_project_milestone_owned on public.study_subjects;
create trigger study_subjects_project_milestone_owned
  before insert or update of project_milestone_id on public.study_subjects
  for each row execute function public.v3_assert_owned_ref('project_milestones', 'project_milestone_id');

-- A task's milestone must be one of its own project's milestones.
create or replace function public.v4_task_milestone_matches()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.project_milestone_id is null then
    return new;
  end if;
  -- No project = no milestone. This also lets "delete project" work: its
  -- SET NULL on project_id may run before the milestone's own SET NULL.
  if new.project_id is null then
    new.project_milestone_id := null;
    return new;
  end if;
  if not exists (
    select 1 from public.project_milestones m
    where m.id = new.project_milestone_id and m.project_id = new.project_id
  ) then
    raise exception 'A task milestone must belong to the task''s project'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists study_subjects_milestone_matches on public.study_subjects;
create trigger study_subjects_milestone_matches
  before insert or update of project_id, project_milestone_id on public.study_subjects
  for each row execute function public.v4_task_milestone_matches();
