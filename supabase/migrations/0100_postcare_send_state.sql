-- Migration 0100: postcare send-state correctness (PR #311).
--
-- Fixes a P1 overclaim: sendPostcareEmailAction used postcare_email_sent_at as
-- BOTH the atomic first-send claim AND the "sent" indicator, stamping it BEFORE
-- the Resend call. A provider failure left sent_at set, so the UI showed
-- "Postcare sent" even though the send failed.
--
-- These four nullable columns let the send path claim WITHOUT stamping sent_at,
-- and stamp sent_at ONLY after the provider confirms success:
--   * postcare_email_claimed_at    — atomic claim marker (frees sent_at from
--                                     claim duty; stale-reclaimable ~5 min)
--   * postcare_email_failed_at      — provider-failure timestamp
--   * postcare_email_last_error     — SAFE/GENERIC failure category only (never
--                                     the raw provider payload, client email/
--                                     name, health data, or exception details)
--   * postcare_email_last_attempt_at— when the last send attempt started
--
-- Additive / backfill-safe: all nullable, existing rows read NULL and their
-- historical postcare_email_sent_at is unchanged (a legacy send stays "sent";
-- we do not rewrite history). NO RLS change (the action uses the service-role
-- admin client), NO enum change, NO trigger change, NO destructive DDL.

alter table public.appointments
  add column if not exists postcare_email_claimed_at     timestamptz,
  add column if not exists postcare_email_failed_at       timestamptz,
  add column if not exists postcare_email_last_error       text,
  add column if not exists postcare_email_last_attempt_at  timestamptz;

comment on column public.appointments.postcare_email_claimed_at is
  'PR #311: atomic first-send claim marker. Set when a send is in flight, cleared on success/failure; stale-reclaimable after ~5 min. sent_at is stamped ONLY after provider success.';
comment on column public.appointments.postcare_email_failed_at is
  'PR #311: timestamp of the last postcare provider-send failure (sent_at stays NULL on a first-send failure).';
comment on column public.appointments.postcare_email_last_error is
  'PR #311: SAFE/GENERIC postcare failure category only — never the raw provider payload, client PII, health data, or exception details.';
comment on column public.appointments.postcare_email_last_attempt_at is
  'PR #311: when the last postcare send attempt started (first send or resend).';
