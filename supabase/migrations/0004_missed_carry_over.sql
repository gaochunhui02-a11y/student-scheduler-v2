-- Migration 0004 — Missed Task + Auto Carry Over (Phase 14)
--
-- Run once in your Supabase project: SQL Editor -> New query -> paste this
-- whole file -> Run. Adds three nullable-free, defaulted columns to
-- schedule_items only — nothing existing is dropped, renamed, or has its
-- type changed, and every existing row is unaffected (defaults mean an old
-- row reads exactly as it always has: 0 minutes completed via this new
-- column, not missed, nothing carried over yet).
--
-- What's new:
--   schedule_items.completed_minutes    — minutes actually done, tracked
--     separately from the existing `completed` boolean so a block can be
--     PARTIALLY done without being (mis)reported as fully completed. The
--     existing `completed` column is untouched and keeps meaning exactly
--     what it always has: "every planned minute of this block is done."
--   schedule_items.missed               — an explicit, student-set flag
--     for "this didn't happen" — kept as a permanent audit/history marker,
--     never auto-set by the app and never cleared by anything but the
--     student themselves.
--   schedule_items.carried_over_minutes — running total of how much of
--     THIS block's shortfall has already been pushed into a future day via
--     Carry Over / Re-plan Remaining, so re-running that action never
--     re-carries (duplicates) minutes already moved forward.

alter table public.schedule_items
  add column if not exists completed_minutes int not null default 0,
  add column if not exists missed boolean not null default false,
  add column if not exists carried_over_minutes int not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'schedule_items_completed_minutes_check'
  ) then
    alter table public.schedule_items
      add constraint schedule_items_completed_minutes_check
      check (completed_minutes >= 0);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'schedule_items_carried_over_minutes_check'
  ) then
    alter table public.schedule_items
      add constraint schedule_items_carried_over_minutes_check
      check (carried_over_minutes >= 0);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Row Level Security — no changes needed. schedule_items already has RLS
-- scoped to auth.uid() = user_id, which covers these new columns exactly
-- like every other column on the row.
-- ---------------------------------------------------------------------------
