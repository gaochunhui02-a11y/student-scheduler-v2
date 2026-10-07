-- 0018 — Spaces (V4-A). Requires 0010 (v3_assert_owned_ref) and 0011.
--
-- A space is an area of someone's life: School, Work, Personal, Japanese…
--
-- ADDITIVE ONLY:
--   * new table public.spaces (+ RLS: each user reads/writes only their own)
--   * new NULLABLE space_id on courses, study_subjects (tasks) and boards.
--     Every existing row gets NULL = "no space", which is exactly how V3
--     shows it today; nothing is moved into a space automatically.
--   * ON DELETE SET NULL: deleting a space never deletes a course, task or
--     board — they just return to "no space". (The app archives spaces
--     instead of deleting them; delete exists for completeness.)
--   * ownership triggers so a row can only point at the same user's space.
--
-- The V3 app never reads these columns, so it keeps working unchanged on a
-- database that has this migration.

create table if not exists public.spaces (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  icon text not null default 'circle',
  color text,
  archived boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint spaces_name_length check (char_length(btrim(name)) between 1 and 60),
  constraint spaces_icon_key check (icon ~ '^[a-z][a-z0-9-]{0,23}$'),
  constraint spaces_color_hex check (color is null or color ~ '^#[0-9A-Fa-f]{6}$')
);

create index if not exists spaces_user_id_idx on public.spaces (user_id);

alter table public.spaces enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'spaces' and policyname = 'spaces: select own') then
    create policy "spaces: select own" on public.spaces for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'spaces' and policyname = 'spaces: insert own') then
    create policy "spaces: insert own" on public.spaces for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'spaces' and policyname = 'spaces: update own') then
    create policy "spaces: update own" on public.spaces for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'spaces' and policyname = 'spaces: delete own') then
    create policy "spaces: delete own" on public.spaces for delete using (auth.uid() = user_id);
  end if;
end $$;

-- ---------------- space links on existing tables (nullable) ----------------
alter table public.courses add column if not exists space_id uuid references public.spaces (id) on delete set null;
alter table public.study_subjects add column if not exists space_id uuid references public.spaces (id) on delete set null;
alter table public.boards add column if not exists space_id uuid references public.spaces (id) on delete set null;

create index if not exists courses_space_id_idx on public.courses (space_id);
create index if not exists study_subjects_space_id_idx on public.study_subjects (space_id);
create index if not exists boards_space_id_idx on public.boards (space_id);

drop trigger if exists courses_space_owned on public.courses;
create trigger courses_space_owned
  before insert or update of space_id on public.courses
  for each row execute function public.v3_assert_owned_ref('spaces', 'space_id');

drop trigger if exists study_subjects_space_owned on public.study_subjects;
create trigger study_subjects_space_owned
  before insert or update of space_id on public.study_subjects
  for each row execute function public.v3_assert_owned_ref('spaces', 'space_id');

drop trigger if exists boards_space_owned on public.boards;
create trigger boards_space_owned
  before insert or update of space_id on public.boards
  for each row execute function public.v3_assert_owned_ref('spaces', 'space_id');
