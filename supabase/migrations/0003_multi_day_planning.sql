-- Migration 0003 — Smart Multi-Day Planning (Phase 13)
--
-- Run once in your Supabase project: SQL Editor -> New query -> paste this
-- whole file -> Run. Adds a single nullable, self-referencing column to
-- study_subjects — nothing existing is dropped, renamed, or has its type
-- changed, and every existing row is unaffected (the column defaults to
-- null, meaning "not part of a multi-day plan").
--
-- What's new:
--   study_subjects.origin_subject_id — links a study task's per-date
--     "chunk" rows (created when its minutes are spread across several
--     days) back to the original task row a student actually typed in.
--     Null on the original/root row and on any task never multi-day
--     planned. Distinct from schedule_items.source_subject_id (which links
--     a generated TIMELINE BLOCK to the study_subjects row it came from) —
--     this instead links one study_subjects row to another.

alter table public.study_subjects
  add column if not exists origin_subject_id uuid references public.study_subjects (id) on delete set null;

create index if not exists study_subjects_origin_subject_id_idx
  on public.study_subjects (origin_subject_id);

-- ---------------------------------------------------------------------------
-- Row Level Security — no changes needed. study_subjects already has RLS
-- scoped to auth.uid() = user_id, which covers the new column exactly like
-- every other column on the row.
-- ---------------------------------------------------------------------------
