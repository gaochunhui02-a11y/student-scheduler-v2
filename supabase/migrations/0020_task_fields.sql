-- 0020 — Universal task fields (V4-B). Requires 0014.
--
-- ADDITIVE ONLY — four columns on study_subjects (tasks), nullable or defaulted:
--   due_time         time  — optional time on the due date ("due 23:59")
--   start_time       time  — optional preferred start on the task's planned
--                            day; the app pins a study block there
--   status_override  text  — an explicit status the student set:
--                            'in_progress' or 'deferred'. NULL = derived as
--                            in V3 (from the task's blocks / completed_at).
--   project_sort     int   — order of the task inside its project (default 0)
--
-- Every existing task keeps NULLs / 0 and therefore behaves exactly as in
-- V3: To Do / In progress / Done / Missed are still derived from blocks and
-- completed_at. Done is still completed_at; it is never stored here.

alter table public.study_subjects add column if not exists due_time time;
alter table public.study_subjects add column if not exists start_time time;
alter table public.study_subjects add column if not exists status_override text;
alter table public.study_subjects add column if not exists project_sort int not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'study_subjects_status_override_check') then
    alter table public.study_subjects
      add constraint study_subjects_status_override_check check (status_override is null or status_override in ('in_progress', 'deferred'));
  end if;
end $$;
