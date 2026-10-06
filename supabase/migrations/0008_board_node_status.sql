-- Migration 0008 — Board node status, due date, estimate + Milestone type (V2-D)
--
-- Run once in your Supabase project: SQL Editor -> New query -> paste this
-- whole file -> Run. Safe to run on a database that already has schema.sql
-- and migrations 0001-0007 applied. Adds three columns with safe defaults
-- and WIDENS one check constraint — nothing is dropped, renamed, or has its
-- type changed. Every existing board_nodes row reads back as status
-- 'planned' with no due date and no estimate, and keeps its node_type.
--
-- What's new:
--   board_nodes.status            — 'planned' | 'in_progress' | 'done'. Set
--     by the student only. A node linked to a Planner study task SHOWS a
--     status derived from that task's schedule_items, but nothing ever
--     writes that derived status back here — so Planner -> Board is a
--     read-only reflection and there's no sync loop to get wrong.
--   board_nodes.due_date          — optional.
--   board_nodes.estimated_minutes — optional, positive.
--   node_type 'milestone'         — added to the allowed set alongside
--     goal/subject/task/note. The constraint is dropped and re-created with
--     a strictly larger set, so every existing row still satisfies it.

alter table public.board_nodes
  add column if not exists status text not null default 'planned',
  add column if not exists due_date date,
  add column if not exists estimated_minutes int;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'board_nodes_status_check') then
    alter table public.board_nodes
      add constraint board_nodes_status_check
      check (status in ('planned', 'in_progress', 'done'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'board_nodes_estimated_minutes_check') then
    alter table public.board_nodes
      add constraint board_nodes_estimated_minutes_check
      check (estimated_minutes is null or estimated_minutes > 0);
  end if;
end $$;

alter table public.board_nodes drop constraint if exists board_nodes_node_type_check;
alter table public.board_nodes
  add constraint board_nodes_node_type_check
  check (node_type in ('goal', 'subject', 'task', 'note', 'milestone'));

-- ---------------------------------------------------------------------------
-- Row Level Security — no changes needed. board_nodes already has RLS
-- scoped to auth.uid() = user_id, which covers these columns like every
-- other column on the row.
-- ---------------------------------------------------------------------------
