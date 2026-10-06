-- OPTIONAL — NOT A MIGRATION. DO NOT RUN AS PART OF A DEPLOY.
--
-- One-time backfill for migration 0009 (profiles.onboarding_completed_at).
-- Kept out of supabase/migrations/ on purpose so it is never run by
-- accident alongside the schema change.
--
-- What it does: marks every profile that existed before 0009 as having
-- completed onboarding. This is a WRITE ACROSS EVERY EXISTING USER ROW.
--
-- Why it is not needed: the app already skips onboarding for any account
-- that has classes or study tasks (see migration 0009's header). Without
-- this script, the only accounts that could still see onboarding are
-- existing accounts with no planning data at all — and for those, the
-- setup flow is arguably helpful rather than harmful.
--
-- Only consider running it if you explicitly decide that NO pre-existing
-- account should ever see onboarding, including empty ones. Requires
-- migration 0009 to be applied first. Re-running it is harmless (it only
-- touches rows that are still null).

update public.profiles
  set onboarding_completed_at = coalesce(created_at, now())
  where onboarding_completed_at is null;
