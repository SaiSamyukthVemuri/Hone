-- Migration 0099: per-photo practitioner note/caption (PR #307).
--
-- Adds one nullable free-text column to treatment_images so a practitioner can
-- add/edit a short note under each treatment photo. Additive / backfill-safe:
-- existing rows read NULL. NO RLS change (the existing "treatment_images:
-- members update" policy already permits studio members to UPDATE the row; the
-- server action scopes by id + studio_id + client_id + deleted_at IS NULL with
-- a row-affected check). NO trigger change (enforce_treatment_image_integrity,
-- migration 0093, freezes only the identity columns — studio/client/bucket/
-- path/session/block — so a practitioner_note UPDATE passes untouched). NO
-- enum change, NO destructive DDL, NO storage/token/sanitizer change.

alter table public.treatment_images
  add column if not exists practitioner_note text;

comment on column public.treatment_images.practitioner_note is
  'Optional practitioner-authored note/caption shown under the photo. Free text, capped at 1000 chars by the server action. NULL = no note.';
