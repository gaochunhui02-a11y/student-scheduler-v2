-- 0015 — Course and task resources (V3-N). Requires 0011 + 0014.
--
-- ADDITIVE ONLY: one new table with RLS. Stores LINKS ONLY (title + URL +
-- kind). No file uploads and no Supabase Storage bucket are created — file
-- storage would need its own private bucket and policies, prepared
-- separately if ever added.
--
-- URLs must be http(s); the app also validates and normalises them
-- (src/resources/resourceModel.js) and renders them with
-- rel="noopener noreferrer". A resource belongs to a course, a task, or
-- both, and is deleted with whichever it belongs to.

create table if not exists public.resources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  course_id uuid references public.courses (id) on delete cascade,
  task_id uuid references public.study_subjects (id) on delete cascade,
  title text not null,
  url text not null,
  kind text not null default 'link',
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint resources_title_length check (char_length(title) between 1 and 200),
  constraint resources_url_length check (char_length(url) between 10 and 2048),
  constraint resources_url_scheme check (url ~* '^https?://[^[:space:]]+$'),
  constraint resources_kind_check check (kind in ('link', 'document', 'lecture', 'syllabus', 'reference')),
  constraint resources_notes_length check (char_length(notes) <= 2000),
  constraint resources_has_parent check (course_id is not null or task_id is not null)
);

create index if not exists resources_user_id_idx on public.resources (user_id);
create index if not exists resources_course_id_idx on public.resources (course_id);
create index if not exists resources_task_id_idx on public.resources (task_id);

alter table public.resources enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'resources' and policyname = 'resources: select own') then
    create policy "resources: select own" on public.resources for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'resources' and policyname = 'resources: insert own') then
    create policy "resources: insert own" on public.resources for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'resources' and policyname = 'resources: update own') then
    create policy "resources: update own" on public.resources for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'resources' and policyname = 'resources: delete own') then
    create policy "resources: delete own" on public.resources for delete using (auth.uid() = user_id);
  end if;
end $$;

drop trigger if exists resources_course_owned on public.resources;
create trigger resources_course_owned
  before insert or update of course_id on public.resources
  for each row execute function public.v3_assert_owned_ref('courses', 'course_id');

drop trigger if exists resources_task_owned on public.resources;
create trigger resources_task_owned
  before insert or update of task_id on public.resources
  for each row execute function public.v3_assert_owned_ref('study_subjects', 'task_id');
