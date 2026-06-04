-- Migration 0060: photo-consent allow/deny response.
--
-- PR #137. PR #134's client_consent_signatures table modelled
-- "signed" or "unsigned" only. For form_type='photo_consent' the
-- practitioner needs a third state: client explicitly declined.
-- This migration adds two columns to record the response without
-- changing the immutable / append-only posture of the table.
--
-- Design choices.
--   * response text NOT NULL DEFAULT 'accepted'. The default makes
--     every existing signature row a positive consent (which is
--     the only kind of row that could have been written before
--     this migration). New rows from the portal sign action will
--     write the explicit choice for photo_consent forms and
--     'accepted' for every other form_type.
--   * response_label_snapshot text NULL. Captures the human-readable
--     label the client tapped at sign time, e.g.
--     'I consent to photo use as described above.' OR
--     'I do not consent to photo use.' Useful for future audit
--     surfaces and email-summary work; nullable so legacy rows
--     stay valid.
--   * CHECK (response in ('accepted', 'denied')) is the only two
--     legal values for v1. A future declination-with-reason or
--     re-negotiation surface would widen the enum behind a new
--     migration.
--   * template_hash is INTENTIONALLY NOT WIDENED. The hash stays a
--     template-only fingerprint so a re-signing after an edit
--     produces a fresh hash and a re-signing of the SAME template
--     version reproduces the same hash. The response is captured as
--     its own column so old hashes remain meaningful and a future
--     audit query can read response separately without re-hashing.
--   * Append-only posture preserved. The table still has no
--     INSERT / UPDATE / DELETE policy; writes are service-role-
--     only via signConsentFormAction.
--
-- Strictly additive + idempotent. The NOT NULL DEFAULT on the new
-- response column makes the column-add a single-pass operation
-- against existing rows (Postgres back-fills the literal default).

alter table public.client_consent_signatures
  add column if not exists response text not null default 'accepted';

alter table public.client_consent_signatures
  add column if not exists response_label_snapshot text;

alter table public.client_consent_signatures
  drop constraint if exists client_consent_signatures_response_check;
alter table public.client_consent_signatures
  add constraint client_consent_signatures_response_check
  check (response in ('accepted', 'denied'));

comment on column public.client_consent_signatures.response is
  'Client response to a consent template. accepted or denied. Defaults to accepted for backward compatibility with rows inserted before migration 0060; new portal-side inserts always write the explicit choice. PR #137.';

comment on column public.client_consent_signatures.response_label_snapshot is
  'Optional snapshot of the human-readable label the client chose at sign time, e.g. "I consent to photo use as described above." or "I do not consent to photo use." Nullable for legacy rows. PR #137.';
