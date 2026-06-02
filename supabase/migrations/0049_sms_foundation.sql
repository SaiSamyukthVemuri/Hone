-- ===========================================================================
-- Migration 0049: SMS foundation (Twilio v1)
-- ===========================================================================
--
-- Adds the data layer for transactional SMS confirmations and
-- reminders through Twilio. Nothing here enables SMS by itself: every
-- studio toggle defaults FALSE, every client SMS field defaults NULL,
-- and the send helpers in app code refuse to call Twilio unless the
-- per-studio toggle is on AND the client has explicit consent AND the
-- client is not opted out AND Twilio is configured.
--
-- Three column groups + two RPCs:
--
--   1. public.clients gains four fields recording explicit SMS consent
--      and an explicit opt-out signal (set by the Twilio inbound STOP
--      webhook or by a practitioner). These are scoped per-client; the
--      phone column itself is unchanged. STOP applies phone-wide via
--      app-code matching at webhook time.
--
--   2. public.studios gains three boolean toggles, one per SMS type
--      (confirmation, 24h reminder, 2h reminder). All default FALSE so
--      no SMS goes out until the studio operator (currently Sam, for
--      the Willow pilot) flips a toggle by SQL after Twilio is wired.
--
--   3. public.appointments gains nine columns mirroring the existing
--      email-tracking pattern (PR 0028) but with a new piece: a
--      claimed_at column per SMS type. The claim column exists because
--      SMS is more expensive than email and we want concurrent cron
--      runs to be mutually exclusive on a single send -- the
--      record_email_attempt pattern increments the counter and stamps
--      _sent_at after the send, which is fine for email idempotency
--      because Resend is fast and email duplication is mostly cosmetic.
--      SMS double-sends are user-visible and money, so we add an
--      explicit claim-then-send-then-record cycle.
--
--   4. Two RPCs:
--        claim_sms_send(p_appointment_id, p_sms_type) -> boolean
--          Atomically increments the matching attempts column AND
--          stamps the matching _claimed_at to now(), but only if the
--          matching _sent_at is null AND attempts are < 3 AND the
--          claim is either fresh (_claimed_at is null) or stale (more
--          than 5 minutes old, indicating a crashed process). Returns
--          true if exactly one row was claimed; false otherwise.
--        record_sms_result(p_appointment_id, p_sms_type, p_success) -> void
--          On success, stamps the matching _sent_at to now() and
--          clears _claimed_at. On failure, clears _claimed_at but
--          leaves _sent_at null. Does NOT increment attempts; the
--          claim already did. Unknown p_sms_type raises.
--
-- Indexes: two partial indexes on appointments for the two reminder
-- windows so the cron query is selective. Confirmation is sent inline
-- from the booking action and does not need a cron-time index.
--
-- This migration is ADDITIVE only:
--   * clients gains FOUR nullable columns with a CHECK on each *_source
--   * studios gains THREE boolean columns (default false, not null)
--   * appointments gains NINE columns (sent_at nullable, send_attempts
--     and claimed_at with sensible defaults / nulls)
--   * two partial indexes on appointments
--   * two new RPCs (security definer)
--
-- It does NOT:
--   * change any existing email column, RPC, or behaviour
--   * touch Stripe / payment / require_card_on_file
--   * touch RLS
--   * write any rows; existing rows take the column defaults
--
-- Re-runnable: ADD COLUMN uses IF NOT EXISTS, CREATE INDEX uses
-- IF NOT EXISTS, CREATE OR REPLACE FUNCTION for the RPCs, and CHECK
-- constraints use the conditional add pattern at the bottom so a
-- second run is a no-op.
-- ---------------------------------------------------------------------------

-- Step 1: client SMS consent and opt-out columns.
-- ---------------------------------------------------------------------------
alter table public.clients
  add column if not exists sms_consent_at      timestamptz,
  add column if not exists sms_consent_source  text,
  add column if not exists sms_opted_out_at    timestamptz,
  add column if not exists sms_opt_out_source  text;

-- Conditional CHECK adds so a re-run does not error.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'clients_sms_consent_source_check'
  ) then
    alter table public.clients
      add constraint clients_sms_consent_source_check
      check (
        sms_consent_source is null
        or sms_consent_source in ('public_booking', 'practitioner', 'import')
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'clients_sms_opt_out_source_check'
  ) then
    alter table public.clients
      add constraint clients_sms_opt_out_source_check
      check (
        sms_opt_out_source is null
        or sms_opt_out_source in ('twilio_stop', 'practitioner')
      );
  end if;
end
$$;

-- Step 2: studio SMS toggles. All default FALSE; SMS only goes out
-- after Sam flips a toggle by SQL during Willow rollout.
-- ---------------------------------------------------------------------------
alter table public.studios
  add column if not exists send_confirmation_sms     boolean not null default false,
  add column if not exists send_24h_sms_reminders    boolean not null default false,
  add column if not exists send_2h_sms_reminders     boolean not null default false;

-- Step 3: appointment SMS tracking columns (mirrors email tracking
-- from migration 0028 with an extra claimed_at per SMS type).
-- ---------------------------------------------------------------------------
alter table public.appointments
  add column if not exists sms_confirmation_sent_at            timestamptz,
  add column if not exists sms_confirmation_send_attempts      integer not null default 0,
  add column if not exists sms_confirmation_claimed_at         timestamptz,
  add column if not exists sms_reminder_24h_sent_at            timestamptz,
  add column if not exists sms_reminder_24h_send_attempts      integer not null default 0,
  add column if not exists sms_reminder_24h_claimed_at         timestamptz,
  add column if not exists sms_reminder_2h_sent_at             timestamptz,
  add column if not exists sms_reminder_2h_send_attempts       integer not null default 0,
  add column if not exists sms_reminder_2h_claimed_at          timestamptz;

-- Step 4: partial indexes for the two reminder windows. The cron pass
-- filters on (status = 'confirmed' AND sms_*_sent_at IS NULL AND
-- sms_*_send_attempts < 3) and orders by starts_at; a partial index on
-- starts_at with those predicates keeps the scan small even when the
-- appointments table grows. Confirmation is fired inline from the
-- booking action, not from cron, so it needs no index here.
-- ---------------------------------------------------------------------------
create index if not exists idx_appts_sms_reminder_24h_due
  on public.appointments (starts_at)
  where sms_reminder_24h_sent_at is null
    and status = 'confirmed'
    and sms_reminder_24h_send_attempts < 3;

create index if not exists idx_appts_sms_reminder_2h_due
  on public.appointments (starts_at)
  where sms_reminder_2h_sent_at is null
    and status = 'confirmed'
    and sms_reminder_2h_send_attempts < 3;

-- Step 5: claim_sms_send RPC.
-- ---------------------------------------------------------------------------
-- Atomically reserves the right to send one SMS of the given type for
-- the given appointment. Returns true if the row was claimed and the
-- caller should proceed with the Twilio HTTP call; false otherwise
-- (already sent, exceeded attempts, or another process holds a fresh
-- claim).
--
-- "Fresh claim" is defined as a non-null _claimed_at within the last
-- 5 minutes. After 5 minutes the claim is considered stale (the
-- caller process likely crashed before recording a result), and a new
-- claim can take over. The 5-minute window is intentionally generous;
-- a successful Twilio POST + recordSmsResult round-trip is on the
-- order of single-digit seconds.
--
-- Unknown p_sms_type raises so a caller bug fails loudly.
create or replace function public.claim_sms_send(
  p_appointment_id uuid,
  p_sms_type text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_stale_cutoff timestamptz := v_now - interval '5 minutes';
  v_updated integer := 0;
begin
  if p_sms_type = 'confirmation' then
    update public.appointments
      set sms_confirmation_send_attempts = sms_confirmation_send_attempts + 1,
          sms_confirmation_claimed_at    = v_now
      where id = p_appointment_id
        and sms_confirmation_sent_at is null
        and sms_confirmation_send_attempts < 3
        and (sms_confirmation_claimed_at is null
             or sms_confirmation_claimed_at < v_stale_cutoff);
    get diagnostics v_updated = row_count;
  elsif p_sms_type = 'reminder_24h' then
    update public.appointments
      set sms_reminder_24h_send_attempts = sms_reminder_24h_send_attempts + 1,
          sms_reminder_24h_claimed_at    = v_now
      where id = p_appointment_id
        and sms_reminder_24h_sent_at is null
        and sms_reminder_24h_send_attempts < 3
        and (sms_reminder_24h_claimed_at is null
             or sms_reminder_24h_claimed_at < v_stale_cutoff);
    get diagnostics v_updated = row_count;
  elsif p_sms_type = 'reminder_2h' then
    update public.appointments
      set sms_reminder_2h_send_attempts = sms_reminder_2h_send_attempts + 1,
          sms_reminder_2h_claimed_at    = v_now
      where id = p_appointment_id
        and sms_reminder_2h_sent_at is null
        and sms_reminder_2h_send_attempts < 3
        and (sms_reminder_2h_claimed_at is null
             or sms_reminder_2h_claimed_at < v_stale_cutoff);
    get diagnostics v_updated = row_count;
  else
    raise exception 'Unknown sms_type: %', p_sms_type;
  end if;

  return v_updated = 1;
end;
$$;

-- Step 6: record_sms_result RPC.
-- ---------------------------------------------------------------------------
-- Called after the Twilio HTTP call returns (success or failure).
-- On success: stamp _sent_at to now() and clear _claimed_at (so the
-- row leaves the reminder query partial index).
-- On failure: clear _claimed_at and leave _sent_at null (so the next
-- cron pass can retry, up to the 3-attempts cap enforced by
-- claim_sms_send).
-- Does NOT increment attempts; the claim function already did.
create or replace function public.record_sms_result(
  p_appointment_id uuid,
  p_sms_type text,
  p_success boolean
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_sms_type = 'confirmation' then
    update public.appointments
      set sms_confirmation_sent_at    = case when p_success then now() else sms_confirmation_sent_at end,
          sms_confirmation_claimed_at = null
      where id = p_appointment_id;
  elsif p_sms_type = 'reminder_24h' then
    update public.appointments
      set sms_reminder_24h_sent_at    = case when p_success then now() else sms_reminder_24h_sent_at end,
          sms_reminder_24h_claimed_at = null
      where id = p_appointment_id;
  elsif p_sms_type = 'reminder_2h' then
    update public.appointments
      set sms_reminder_2h_sent_at     = case when p_success then now() else sms_reminder_2h_sent_at end,
          sms_reminder_2h_claimed_at  = null
      where id = p_appointment_id;
  else
    raise exception 'Unknown sms_type: %', p_sms_type;
  end if;
end;
$$;

-- Step 7: grants. Mirror the email-attempt RPC grants from 0028; both
-- new functions are security definer + search_path locked, so granting
-- execute to authenticated and service_role is the same posture.
-- ---------------------------------------------------------------------------
grant execute on function public.claim_sms_send(uuid, text) to authenticated, service_role;
grant execute on function public.record_sms_result(uuid, text, boolean) to authenticated, service_role;
