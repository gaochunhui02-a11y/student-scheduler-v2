-- 0012 — Grade tracking (V3-C). Requires 0010 + 0011.
--
-- ADDITIVE ONLY: two new tables with RLS. No existing table is touched.
--
-- grade_categories: weighted buckets per course (e.g. Exams 40%).
-- grade_items: individual graded (or not-yet-graded) pieces of work.
--   * earned_points NULL  = not graded yet (never treated as zero)
--   * counts = false      = optional / practice item, excluded from the grade
--   * category_id NULL    = uncategorised (only meaningful for courses that
--                           don't use categories)
-- Deleting a course deletes its categories and items (they have no meaning
-- without the course). Deleting a category keeps its items, uncategorised.

create table if not exists public.grade_categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  course_id uuid not null references public.courses (id) on delete cascade,
  name text not null,
  weight numeric(6, 3) not null default 0,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint grade_categories_name_length check (char_length(name) between 1 and 80),
  constraint grade_categories_weight_range check (weight >= 0 and weight <= 100)
);

create index if not exists grade_categories_user_id_idx on public.grade_categories (user_id);
create index if not exists grade_categories_course_id_idx on public.grade_categories (course_id);

create table if not exists public.grade_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  course_id uuid not null references public.courses (id) on delete cascade,
  category_id uuid references public.grade_categories (id) on delete set null,
  name text not null,
  earned_points numeric(8, 2),
  possible_points numeric(8, 2) not null,
  due_date date,
  counts boolean not null default true,
  notes text not null default '',
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint grade_items_name_length check (char_length(name) between 1 and 120),
  constraint grade_items_possible_positive check (possible_points > 0 and possible_points <= 100000),
  -- earned may exceed possible (extra credit) but not absurdly
  constraint grade_items_earned_range check (earned_points is null or (earned_points >= 0 and earned_points <= possible_points * 2)),
  constraint grade_items_notes_length check (char_length(notes) <= 2000)
);

create index if not exists grade_items_user_id_idx on public.grade_items (user_id);
create index if not exists grade_items_course_id_idx on public.grade_items (course_id);
create index if not exists grade_items_category_id_idx on public.grade_items (category_id);

alter table public.grade_categories enable row level security;
alter table public.grade_items enable row level security;

do $$
declare
  tbl text;
begin
  foreach tbl in array array['grade_categories', 'grade_items'] loop
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

drop trigger if exists grade_categories_course_owned on public.grade_categories;
create trigger grade_categories_course_owned
  before insert or update of course_id on public.grade_categories
  for each row execute function public.v3_assert_owned_ref('courses', 'course_id');

drop trigger if exists grade_items_course_owned on public.grade_items;
create trigger grade_items_course_owned
  before insert or update of course_id on public.grade_items
  for each row execute function public.v3_assert_owned_ref('courses', 'course_id');

-- An item's category must belong to the same course as the item.
create or replace function public.v3_grade_item_category_matches()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.category_id is not null and not exists (
    select 1 from public.grade_categories c
    where c.id = new.category_id and c.course_id = new.course_id and c.user_id = new.user_id
  ) then
    raise exception 'Grade category must belong to the same course' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists grade_items_category_matches on public.grade_items;
create trigger grade_items_category_matches
  before insert or update of category_id, course_id on public.grade_items
  for each row execute function public.v3_grade_item_category_matches();
