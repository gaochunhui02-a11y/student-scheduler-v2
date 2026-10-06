-- Migration 0009 — First-run onboarding flag (V2-F)
--
-- Run once in your Supabase project: SQL Editor -> New query -> paste this
-- whole file -> Run. Safe to run on a database that already has schema.sql
-- and migrations 0001-0008 applied.
--
-- What's new:
--   profiles.onboarding_completed_at — when this user finished or skipped
--     the first-run setup. null = never shown/finished.
--
-- !! READ BEFORE RUNNING: this file also contains a one-time BACKFILL that
-- writes to EVERY existing profiles row (sets onboarding_completed_at for
-- users who existed before this migration, so no current user is ever
-- sent through onboarding). It only fills a brand-new, previously-empty
-- column and touches nothing else, but it IS a data write across all
-- users — do not run it against production without a deliberate sign-off.
--
-- The app does not depend on this backfill for safety: it already skips
-- onboarding for anyone who has any classes or study tasks saved, and
-- remembers a finish/skip in the browser too. The backfill just makes the
-- server-side record match.

alter table public.profiles
  add column if not exists onboarding_completed_at timestamptz;

-- One-time backfill for users who existed before this migration.
update public.profiles
  set onboarding_completed_at = coalesce(created_at, now())
  where onboarding_completed_at is null;

-- ---------------------------------------------------------------------------
-- Row Level Security — no changes needed. schema.sql's "profiles: read
-- own" / "profiles: update own" policies already scope this column to the
-- user's own row.
-- ---------------------------------------------------------------------------
