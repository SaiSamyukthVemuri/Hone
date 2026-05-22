-- Migration 0025: complete email reminder, confirmation, reschedule,
-- and no-show automation system.
--
-- Adds tracking columns + tokens to appointments, studio-level toggles,
-- and pre-care text per service. Backfills cancellation tokens for any
-- confirmed appointments that exist today so they can be cancelled via
-- email link if needed.
--
-- Single paste block, additive only, safe to re-run.

-- Track when each automated email went out + a per-appointment opaque
-- token used in cancellation and reschedule links. The token is random
-- bytes, not an HMAC. The existing HMAC-based /cancel/[hmac-token] route
-- continues to work for emails already in flight; new emails use the
-- column-based token.
alter table public.appointments
  add column if not exists confirmation_sent_at timestamptz,
  add column if not exists reminder_24h_sent_at timestamptz,
  add column if not exists reminder_2h_sent_at timestamptz,
  add column if not exists no_show_email_sent_at timestamptz,
  add column if not exists confirmation_send_attempts integer not null default 0,
  add column if not exists reminder_24h_send_attempts integer not null default 0,
  add column if not exists reminder_2h_send_attempts integer not null default 0,
  add column if not exists cancellation_token text;

alter table public.appointments
  drop constraint if exists appointments_cancellation_token_unique;
alter table public.appointments
  add constraint appointments_cancellation_token_unique unique (cancellation_token);

create index if not exists appointments_24h_reminder_window_idx
  on public.appointments (starts_at)
  where reminder_24h_sent_at is null
    and status = 'confirmed'
    and reminder_24h_send_attempts < 3;

create index if not exists appointments_2h_reminder_window_idx
  on public.appointments (starts_at)
  where reminder_2h_sent_at is null
    and status = 'confirmed'
    and reminder_2h_send_attempts < 3;

create index if not exists appointments_no_show_check_idx
  on public.appointments (status, starts_at)
  where status = 'confirmed';

create index if not exists appointments_cancellation_token_idx
  on public.appointments (cancellation_token)
  where cancellation_token is not null;

-- Studio-level toggles. Defaults match the most common practitioner
-- preference: send confirmation + 24h + 2h reminders, auto mark no shows,
-- but do NOT send the follow-up email (it's opt-in because some
-- practitioners prefer no contact after a no-show).
alter table public.studios
  add column if not exists send_confirmation_emails boolean not null default true,
  add column if not exists send_24h_reminders boolean not null default true,
  add column if not exists send_2h_reminders boolean not null default true,
  add column if not exists auto_mark_no_shows boolean not null default true,
  add column if not exists send_no_show_followup boolean not null default false;

-- Service-level pre-care instructions, rendered in confirmation + reminder
-- emails for appointments of that service.
alter table public.services
  add column if not exists pre_care_instructions text;

-- Backfill tokens on existing confirmed appointments so any in-flight
-- session can be cancelled or rescheduled via the new column-based path.
update public.appointments
  set cancellation_token = encode(gen_random_bytes(24), 'base64')
  where cancellation_token is null and status = 'confirmed';
