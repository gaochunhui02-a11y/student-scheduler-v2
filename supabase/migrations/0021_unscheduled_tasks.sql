-- 0021 — Unscheduled (backlog) tasks (V4-B.1). Requires 0010 (v3_assert_owned_ref).
--
-- Until now every task (study_subjects row) had to sit on a planned day:
-- schedule_id was NOT NULL. V4 needs a backlog: a task with a due date (or
-- none) that nobody has scheduled yet.
--
-- WHAT CHANGES
--   1. study_subjects.schedule_id may be NULL.  NULL = unscheduled.
--      This only RELAXES a constraint: every existing row keeps its
--      schedule_id, nothing is rewritten, and every insert that was valid
--      before is still valid. The foreign key (ON DELETE CASCADE to the
--      day's schedule) is unchanged for scheduled tasks.
--   2. New nullable study_subjects.planned_by: who gave the task its day —
--      'user' (picked a date) or 'planner' (Plan my backlog). NULL for every
--      existing task and for unscheduled ones.
--   3. Ownership guard on study_subjects.schedule_id (pre-existing V2 gap):
--      a task can only be placed on the same user's schedule. RLS already
--      limited tasks to their owner; this stops a row pointing at another
--      user's schedule id. Existing rows are not re-checked.
--
-- RLS is unchanged: study_subjects policies are user_id-based and never
-- depended on schedule_id.
--
-- ROLLBACK NOTE: the V3 app reads unscheduled tasks without errors (they
-- show with no planned date); it cannot create them.

alter table public.study_subjects alter column schedule_id drop not null;

alter table public.study_subjects add column if not exists planned_by text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'study_subjects_planned_by_check') then
    alter table public.study_subjects
      add constraint study_subjects_planned_by_check check (planned_by is null or planned_by in ('user', 'planner'));
  end if;
end $$;

-- The backlog query ("my unscheduled tasks") stays an index lookup.
create index if not exists study_subjects_unscheduled_idx on public.study_subjects (user_id) where schedule_id is null;

drop trigger if exists study_subjects_schedule_owned on public.study_subjects;
create trigger study_subjects_schedule_owned
  before insert or update of schedule_id on public.study_subjects
  for each row execute function public.v3_assert_owned_ref('schedules', 'schedule_id');
