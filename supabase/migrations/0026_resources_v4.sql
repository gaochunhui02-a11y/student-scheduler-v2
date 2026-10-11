-- 0026 — Resources everywhere (V4-H). Requires 0013 (exams), 0015
-- (resources), 0018 (spaces), 0019 (projects), 0022 (goals).
--
-- ADDITIVE, with two reviewed widenings:
--   * new NULLABLE / defaulted columns on public.resources:
--       project_id, goal_id, exam_id  — more things a link can belong to
--       space_id                      — for the space filter
--       in_library                    — a general link saved to "My library"
--                                       without belonging to anything
--       favorite                      — starred
--       tags                          — up to 20 short labels
--   * resources_kind_check is re-created with MORE kinds (video, article,
--     tool, book, other) — every existing value stays valid
--   * resources_has_parent is re-created to also accept the new parents or
--     in_library — every existing row (course or task) stays valid
-- No existing row is changed.
--
-- DELETION: same rule as V3 — a resource is deleted with whatever it belongs
-- to (project / goal / exam: CASCADE, like course / task). Deleting a space
-- only clears space_id (it never counts as a parent, so that SET NULL can
-- never break resources_has_parent).

alter table public.resources add column if not exists project_id uuid references public.projects (id) on delete cascade;
alter table public.resources add column if not exists goal_id uuid references public.goals (id) on delete cascade;
alter table public.resources add column if not exists exam_id uuid references public.exams (id) on delete cascade;
alter table public.resources add column if not exists space_id uuid references public.spaces (id) on delete set null;
alter table public.resources add column if not exists in_library boolean not null default false;
alter table public.resources add column if not exists favorite boolean not null default false;
alter table public.resources add column if not exists tags jsonb not null default '[]'::jsonb;

alter table public.resources drop constraint if exists resources_kind_check;
alter table public.resources add constraint resources_kind_check
  check (kind in ('link', 'document', 'lecture', 'syllabus', 'reference', 'video', 'article', 'tool', 'book', 'other'));

alter table public.resources drop constraint if exists resources_has_parent;
alter table public.resources add constraint resources_has_parent
  check (course_id is not null or task_id is not null or project_id is not null or goal_id is not null or exam_id is not null or in_library);

alter table public.resources drop constraint if exists resources_tags_array;
alter table public.resources add constraint resources_tags_array
  check (jsonb_typeof(tags) = 'array' and jsonb_array_length(tags) <= 20);

create index if not exists resources_project_id_idx on public.resources (project_id);
create index if not exists resources_goal_id_idx on public.resources (goal_id);
create index if not exists resources_exam_id_idx on public.resources (exam_id);
create index if not exists resources_space_id_idx on public.resources (space_id);

drop trigger if exists resources_project_owned on public.resources;
create trigger resources_project_owned before insert or update of project_id on public.resources
  for each row execute function public.v3_assert_owned_ref('projects', 'project_id');
drop trigger if exists resources_goal_owned on public.resources;
create trigger resources_goal_owned before insert or update of goal_id on public.resources
  for each row execute function public.v3_assert_owned_ref('goals', 'goal_id');
drop trigger if exists resources_exam_owned on public.resources;
create trigger resources_exam_owned before insert or update of exam_id on public.resources
  for each row execute function public.v3_assert_owned_ref('exams', 'exam_id');
drop trigger if exists resources_space_owned on public.resources;
create trigger resources_space_owned before insert or update of space_id on public.resources
  for each row execute function public.v3_assert_owned_ref('spaces', 'space_id');
