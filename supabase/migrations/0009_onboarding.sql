-- Migration 0009 — First-run onboarding flag (V2-F)
--
-- Run once in your Supabase project: SQL Editor -> New query -> paste this
-- whole file -> Run. Safe to run on a database that already has schema.sql
-- and migrations 0001-0008 applied.
--
-- ADDITIVE ONLY. Adds one nullable column with no default. It does not
-- write to any existing row, rename anything, drop anything, or change any
-- existing column/constraint/policy. The production v1.x app never reads
-- or writes this column (it only selects profiles.name), so it is
-- unaffected.
--
-- What's new:
--   profiles.onboarding_completed_at — when this user finished or skipped
--     the first-run setup. null = not recorded.
--
-- Existing users are NOT backfilled. They don't need to be: the app only
-- shows onboarding when (a) this column is null/unreadable AND (b) the
-- account has no classes or study tasks at all AND (c) this browser hasn't
-- recorded a finish/skip. Any existing user with planning data is skipped
-- by (b) — the same fallback the app uses when this column doesn't exist.
-- The only thing this column adds is remembering a finish/skip across
-- devices for accounts that have no data yet.
--
-- An optional, separate backfill script lives at
-- supabase/optional/0009b_onboarding_backfill_OPTIONAL.sql. It is not part
-- of this migration and is not needed for correct behavior.

alter table public.profiles
  add column if not exists onboarding_completed_at timestamptz;

-- ---------------------------------------------------------------------------
-- Row Level Security — no changes needed. schema.sql's "profiles: read
-- own" / "profiles: update own" policies already scope this column to the
-- user's own row.
-- ---------------------------------------------------------------------------
