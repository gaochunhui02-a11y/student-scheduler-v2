-- 0022 — Goals (V4-C). Requires 0010 (v3_assert_owned_ref), 0018 (spaces)
-- and 0019 (projects).
--
-- ADDITIVE ONLY:
--   * new tables public.goals, public.goal_milestones and
--     public.goal_progress_log (+ RLS, four own-row policies each)
--   * new NULLABLE goal_id on study_subjects (tasks) and projects. Every
--     existing row gets NULL = "not linked to a goal". Nothing is rewritten.
--
-- PROGRESS (one number per goal, chosen by progress_mode):
--   auto    — linked tasks, linked projects and goal milestones (app-side)
--   numeric — check-ins in goal_progress_log measured from start_value to
--             target_value; aggregate 'sum' adds every check-in ("read 12
--             books"), 'latest' uses the most recent one ("run 5 km")
--   manual  — the student's own percentage (manual_progress)
--
-- DELETION (deliberate):
--   * deleting a goal NEVER deletes work: study_subjects.goal_id and
--     projects.goal_id are ON DELETE SET NULL (routines too, see 0023)
--   * a goal's milestones and check-ins ARE deleted with it (CASCADE) —
--     they have no meaning outside the goal
--   * archiving (status = 'archived') is the normal way to put a goal away

create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  space_id uuid references public.spaces (id) on delete set null,
  title text not null,
  description text not null default '',
  status text not null default 'active',
  start_date date,
  target_date date,
  progress_mode text not null default 'auto',
  start_value numeric not null default 0,
  target_value numeric,
  unit text not null default '',
  aggregate text not null default 'sum',
  manual_progress int,
  sort_order int not null default 0,
  achieved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint goals_title_length check (char_length(btrim(title)) between 1 and 120),
  constraint goals_description_length check (char_length(description) <= 5000),
  constraint goals_status_check check (status in ('active', 'on_hold', 'achieved', 'archived')),
  constraint goals_date_order check (start_date is null or target_date is null or target_date >= start_date),
  constraint goals_progress_mode_check check (progress_mode in ('auto', 'numeric', 'manual')),
  constraint goals_numeric_target check (progress_mode <> 'numeric' or (target_value is not null and target_value <> start_value)),
  constraint goals_value_range check (abs(start_value) <= 1000000000 and (target_value is null or abs(target_value) <= 1000000000)),
  constraint goals_unit_length check (char_length(unit) <= 24),
  constraint goals_aggregate_check check (aggregate in ('sum', 'latest')),
  constraint goals_manual_progress_range check (manual_progress is null or (manual_progress between 0 and 100))
);

create index if not exists goals_user_id_idx on public.goals (user_id);
create index if not exists goals_space_id_idx on public.goals (space_id);
create index if not exists goals_user_status_idx on public.goals (user_id, status);

create table if not exists public.goal_milestones (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  goal_id uuid not null references public.goals (id) on delete cascade,
  title text not null,
  due_date date,
  status text not null default 'open',
  completed_at timestamptz,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint goal_milestones_title_length check (char_length(btrim(title)) between 1 and 120),
  constraint goal_milestones_status_check check (status in ('open', 'done'))
);

create index if not exists goal_milestones_user_id_idx on public.goal_milestones (user_id);
create index if not exists goal_milestones_goal_id_idx on public.goal_milestones (goal_id);

create table if not exists public.goal_progress_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  goal_id uuid not null references public.goals (id) on delete cascade,
  logged_on date not null default current_date,
  value numeric not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  constraint goal_progress_log_value_range check (abs(value) <= 1000000000),
  constraint goal_progress_log_note_length check (char_length(note) <= 500)
);

create index if not exists goal_progress_log_user_id_idx on public.goal_progress_log (user_id);
create index if not exists goal_progress_log_goal_idx on public.goal_progress_log (goal_id, logged_on);

alter table public.goals enable row level security;
alter table public.goal_milestones enable row level security;
alter table public.goal_progress_log enable row level security;

do $$
declare
  tbl text;
begin
  foreach tbl in array array['goals', 'goal_milestones', 'goal_progress_log'] loop
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

drop trigger if exists goals_space_owned on public.goals;
create trigger goals_space_owned
  before insert or update of space_id on public.goals
  for each row execute function public.v3_assert_owned_ref('spaces', 'space_id');

drop trigger if exists goal_milestones_goal_owned on public.goal_milestones;
create trigger goal_milestones_goal_owned
  before insert or update of goal_id on public.goal_milestones
  for each row execute function public.v3_assert_owned_ref('goals', 'goal_id');

drop trigger if exists goal_progress_log_goal_owned on public.goal_progress_log;
create trigger goal_progress_log_goal_owned
  before insert or update of goal_id on public.goal_progress_log
  for each row execute function public.v3_assert_owned_ref('goals', 'goal_id');

-- ---------------- links (nullable) ----------------
alter table public.study_subjects add column if not exists goal_id uuid references public.goals (id) on delete set null;
alter table public.projects add column if not exists goal_id uuid references public.goals (id) on delete set null;

create index if not exists study_subjects_goal_id_idx on public.study_subjects (goal_id);
create index if not exists projects_goal_id_idx on public.projects (goal_id);

drop trigger if exists study_subjects_goal_owned on public.study_subjects;
create trigger study_subjects_goal_owned
  before insert or update of goal_id on public.study_subjects
  for each row execute function public.v3_assert_owned_ref('goals', 'goal_id');

drop trigger if exists projects_goal_owned on public.projects;
create trigger projects_goal_owned
  before insert or update of goal_id on public.projects
  for each row execute function public.v3_assert_owned_ref('goals', 'goal_id');
