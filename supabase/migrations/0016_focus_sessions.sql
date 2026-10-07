-- 0016 — Focus session history (V3-K). Requires 0011.
--
-- ADDITIVE ONLY: one new table with RLS. Each finished Focus Mode session
-- writes one row (planned vs actual minutes, how it ended, an optional
-- note). Cancelled sessions write nothing. The study block's own
-- completed / completed_minutes columns are still updated exactly as in V2;
-- this table is the history used for "planned vs actual" and estimate
-- accuracy insights.
--
-- References are ON DELETE SET NULL so deleting a task, block or course
-- never deletes study history.

create table if not exists public.focus_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  schedule_item_id uuid references public.schedule_items (id) on delete set null,
  task_id uuid references public.study_subjects (id) on delete set null,
  course_id uuid references public.courses (id) on delete set null,
  started_at timestamptz not null,
  ended_at timestamptz,
  planned_minutes int not null default 0,
  actual_minutes int not null default 0,
  outcome text not null default 'completed',
  notes text not null default '',
  created_at timestamptz not null default now(),
  constraint focus_sessions_planned_range check (planned_minutes between 0 and 1440),
  constraint focus_sessions_actual_range check (actual_minutes between 0 and 1440),
  constraint focus_sessions_outcome_check check (outcome in ('completed', 'finished_early', 'stopped')),
  constraint focus_sessions_notes_length check (char_length(notes) <= 2000),
  constraint focus_sessions_time_order check (ended_at is null or ended_at >= started_at)
);

create index if not exists focus_sessions_user_started_idx on public.focus_sessions (user_id, started_at desc);
create index if not exists focus_sessions_task_id_idx on public.focus_sessions (task_id);
create index if not exists focus_sessions_course_id_idx on public.focus_sessions (course_id);
create index if not exists focus_sessions_schedule_item_id_idx on public.focus_sessions (schedule_item_id);

alter table public.focus_sessions enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'focus_sessions' and policyname = 'focus_sessions: select own') then
    create policy "focus_sessions: select own" on public.focus_sessions for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'focus_sessions' and policyname = 'focus_sessions: insert own') then
    create policy "focus_sessions: insert own" on public.focus_sessions for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'focus_sessions' and policyname = 'focus_sessions: update own') then
    create policy "focus_sessions: update own" on public.focus_sessions for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'focus_sessions' and policyname = 'focus_sessions: delete own') then
    create policy "focus_sessions: delete own" on public.focus_sessions for delete using (auth.uid() = user_id);
  end if;
end $$;

drop trigger if exists focus_sessions_task_owned on public.focus_sessions;
create trigger focus_sessions_task_owned
  before insert or update of task_id on public.focus_sessions
  for each row execute function public.v3_assert_owned_ref('study_subjects', 'task_id');

drop trigger if exists focus_sessions_course_owned on public.focus_sessions;
create trigger focus_sessions_course_owned
  before insert or update of course_id on public.focus_sessions
  for each row execute function public.v3_assert_owned_ref('courses', 'course_id');

drop trigger if exists focus_sessions_item_owned on public.focus_sessions;
create trigger focus_sessions_item_owned
  before insert or update of schedule_item_id on public.focus_sessions
  for each row execute function public.v3_assert_owned_ref('schedule_items', 'schedule_item_id');
