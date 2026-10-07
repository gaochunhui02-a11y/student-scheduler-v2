-- 0014 — Advanced tasks (V3-H): completion, actual time, dependencies,
-- recurring academic tasks, revision links. Requires 0010, 0011, 0013.
--
-- ADDITIVE ONLY:
--   * new tables task_recurrence_rules, task_dependencies (+ RLS)
--   * new NULLABLE / defaulted columns on study_subjects; every existing
--     row keeps behaving exactly as before (no completed_at = not
--     explicitly completed; dependency_override false; links null)
--   * a partial unique index so a recurring rule can never create two
--     tasks for the same occurrence date (duplicate-generation guard)
--   * a trigger that rejects dependency cycles (A waits on B waits on A)

-- ---------------- recurring task rules ----------------
create table if not exists public.task_recurrence_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  course_id uuid references public.courses (id) on delete set null,
  name text not null,
  minutes int not null default 60,
  priority text not null default 'medium',
  tags jsonb not null default '[]'::jsonb,
  days_of_week jsonb not null default '[]'::jsonb,
  start_date date not null,
  end_date date not null,
  due_offset_days int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint task_recurrence_rules_name_length check (char_length(name) between 1 and 200),
  constraint task_recurrence_rules_minutes_range check (minutes between 5 and 1440),
  constraint task_recurrence_rules_priority_check check (priority in ('low', 'medium', 'high')),
  constraint task_recurrence_rules_tags_is_array check (jsonb_typeof(tags) = 'array'),
  constraint task_recurrence_rules_days_is_array check (jsonb_typeof(days_of_week) = 'array'),
  constraint task_recurrence_rules_date_order check (end_date >= start_date),
  constraint task_recurrence_rules_span check (end_date - start_date <= 400),
  constraint task_recurrence_rules_offset_range check (due_offset_days between 0 and 30)
);

create index if not exists task_recurrence_rules_user_id_idx on public.task_recurrence_rules (user_id);
create index if not exists task_recurrence_rules_course_id_idx on public.task_recurrence_rules (course_id);

-- ---------------- study_subjects extensions ----------------
alter table public.study_subjects
  add column if not exists completed_at timestamptz,
  add column if not exists actual_minutes int,
  add column if not exists dependency_override boolean not null default false,
  add column if not exists exam_topic_id uuid references public.exam_topics (id) on delete set null,
  add column if not exists recurrence_rule_id uuid references public.task_recurrence_rules (id) on delete set null,
  add column if not exists recurrence_date date;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'study_subjects_actual_minutes_range') then
    alter table public.study_subjects
      add constraint study_subjects_actual_minutes_range
      check (actual_minutes is null or (actual_minutes >= 0 and actual_minutes <= 10000));
  end if;
end $$;

create index if not exists study_subjects_exam_topic_id_idx on public.study_subjects (exam_topic_id);
create index if not exists study_subjects_recurrence_rule_id_idx on public.study_subjects (recurrence_rule_id);
create index if not exists study_subjects_due_date_idx on public.study_subjects (user_id, due_date);

-- One generated task per rule per occurrence date.
create unique index if not exists study_subjects_one_task_per_occurrence
  on public.study_subjects (recurrence_rule_id, recurrence_date)
  where recurrence_rule_id is not null;

-- ---------------- task dependencies ----------------
-- task_id waits on depends_on_id ("Draft" depends on "Outline").
create table if not exists public.task_dependencies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  task_id uuid not null references public.study_subjects (id) on delete cascade,
  depends_on_id uuid not null references public.study_subjects (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint task_dependencies_no_self check (task_id <> depends_on_id),
  constraint task_dependencies_unique_pair unique (task_id, depends_on_id)
);

create index if not exists task_dependencies_user_id_idx on public.task_dependencies (user_id);
create index if not exists task_dependencies_task_id_idx on public.task_dependencies (task_id);
create index if not exists task_dependencies_depends_on_id_idx on public.task_dependencies (depends_on_id);

alter table public.task_recurrence_rules enable row level security;
alter table public.task_dependencies enable row level security;

do $$
declare
  tbl text;
begin
  foreach tbl in array array['task_recurrence_rules', 'task_dependencies'] loop
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

-- ---------------- ownership guards ----------------
drop trigger if exists task_recurrence_rules_course_owned on public.task_recurrence_rules;
create trigger task_recurrence_rules_course_owned
  before insert or update of course_id on public.task_recurrence_rules
  for each row execute function public.v3_assert_owned_ref('courses', 'course_id');

drop trigger if exists study_subjects_exam_topic_owned on public.study_subjects;
create trigger study_subjects_exam_topic_owned
  before insert or update of exam_topic_id on public.study_subjects
  for each row execute function public.v3_assert_owned_ref('exam_topics', 'exam_topic_id');

drop trigger if exists study_subjects_recurrence_rule_owned on public.study_subjects;
create trigger study_subjects_recurrence_rule_owned
  before insert or update of recurrence_rule_id on public.study_subjects
  for each row execute function public.v3_assert_owned_ref('task_recurrence_rules', 'recurrence_rule_id');

drop trigger if exists task_dependencies_task_owned on public.task_dependencies;
create trigger task_dependencies_task_owned
  before insert or update of task_id on public.task_dependencies
  for each row execute function public.v3_assert_owned_ref('study_subjects', 'task_id');

drop trigger if exists task_dependencies_prereq_owned on public.task_dependencies;
create trigger task_dependencies_prereq_owned
  before insert or update of depends_on_id on public.task_dependencies
  for each row execute function public.v3_assert_owned_ref('study_subjects', 'depends_on_id');

-- ---------------- cycle guard ----------------
-- Rejects an edge task_id -> depends_on_id when depends_on_id already
-- (directly or indirectly) waits on task_id. The app checks this first and
-- explains it; this is the database-level backstop.
create or replace function public.v3_task_dependency_no_cycle()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if exists (
    with recursive chain(id, depth) as (
      select d.depends_on_id, 1 from public.task_dependencies d
      where d.task_id = new.depends_on_id and d.user_id = new.user_id
      union
      select d.depends_on_id, c.depth + 1 from public.task_dependencies d
      join chain c on d.task_id = c.id
      where d.user_id = new.user_id and c.depth < 200
    )
    select 1 from chain where id = new.task_id
  ) then
    raise exception 'This dependency would create a loop' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists task_dependencies_no_cycle on public.task_dependencies;
create trigger task_dependencies_no_cycle
  before insert or update on public.task_dependencies
  for each row execute function public.v3_task_dependency_no_cycle();
