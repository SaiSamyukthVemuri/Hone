-- 0080: Atomic claim for appointment email sends (PR #189, pilot safety).
--
-- Problem: the email reminder cron used select -> send -> record
-- (record_email_attempt, migration 0028). Two overlapping cron runs
-- could both select the same not-yet-sent row and both send, because
-- nothing reserved the row between the select and the send. The SMS
-- path already solved this with claim_sms_send / record_sms_result
-- (migration 0049); this migration adds the email equivalent.
--
-- Model (mirrors 0049 exactly):
--   * claim_email_send(appointment, type) -> boolean
--       Atomically increments the matching _send_attempts column and
--       stamps the matching _claimed_at, but ONLY when the row is
--       still unsent, under the 3-attempt cap, and not freshly
--       claimed by another process. Returns true when the caller won
--       the claim and should proceed with the Resend HTTP call.
--   * record_email_result(appointment, type, success)
--       Called after the send returns. Success stamps _sent_at and
--       clears _claimed_at; failure just clears _claimed_at so the
--       next cron pass can retry (up to the cap enforced by the
--       claim). Does NOT increment attempts; the claim already did.
--   * A claim older than 5 minutes is stale (the claiming process
--     crashed before recording a result) and can be reclaimed.
--
-- record_email_attempt (0028) is intentionally untouched: it still
-- serves the unclaimed one-shot paths (booking confirmation,
-- reschedule notices, calendar actions, no-show cron), which run
-- inside a single user request and do not race a scheduler. Only the
-- reminder cron switches to the claim + result pair in PR #189.
--
-- Grants: service_role ONLY. Every claimed send runs in the cron
-- route through the admin client. Default PUBLIC execute is revoked.

-- Step 1: claim columns for the three claimable email types.
-- ---------------------------------------------------------------------------
alter table public.appointments
  add column if not exists confirmation_claimed_at timestamptz,
  add column if not exists reminder_24h_claimed_at timestamptz,
  add column if not exists reminder_2h_claimed_at timestamptz;

comment on column public.appointments.reminder_24h_claimed_at is
  'Held by claim_email_send before the Resend call; cleared by record_email_result. Stale after 5 minutes.';
comment on column public.appointments.reminder_2h_claimed_at is
  'Held by claim_email_send before the Resend call; cleared by record_email_result. Stale after 5 minutes.';
comment on column public.appointments.confirmation_claimed_at is
  'Reserved for a future claimed confirmation path; the claim RPC supports it from day one.';

-- Step 2: claim_email_send RPC.
-- ---------------------------------------------------------------------------
-- Unknown p_email_type raises so a caller bug fails loudly. no_show
-- and postcare are deliberately NOT claimable here: no_show keeps its
-- 0028 path, postcare has its own conditional-UPDATE claim (0043).
create or replace function public.claim_email_send(
  p_appointment_id uuid,
  p_email_type text
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
  if p_email_type = 'confirmation' then
    update public.appointments
      set confirmation_send_attempts = confirmation_send_attempts + 1,
          confirmation_claimed_at    = v_now
      where id = p_appointment_id
        and confirmation_sent_at is null
        and confirmation_send_attempts < 3
        and (confirmation_claimed_at is null
             or confirmation_claimed_at < v_stale_cutoff);
    get diagnostics v_updated = row_count;
  elsif p_email_type = 'reminder_24h' then
    update public.appointments
      set reminder_24h_send_attempts = reminder_24h_send_attempts + 1,
          reminder_24h_claimed_at    = v_now
      where id = p_appointment_id
        and reminder_24h_sent_at is null
        and reminder_24h_send_attempts < 3
        and (reminder_24h_claimed_at is null
             or reminder_24h_claimed_at < v_stale_cutoff);
    get diagnostics v_updated = row_count;
  elsif p_email_type = 'reminder_2h' then
    update public.appointments
      set reminder_2h_send_attempts = reminder_2h_send_attempts + 1,
          reminder_2h_claimed_at    = v_now
      where id = p_appointment_id
        and reminder_2h_sent_at is null
        and reminder_2h_send_attempts < 3
        and (reminder_2h_claimed_at is null
             or reminder_2h_claimed_at < v_stale_cutoff);
    get diagnostics v_updated = row_count;
  else
    raise exception 'Unknown email_type: %', p_email_type;
  end if;

  return v_updated = 1;
end;
$$;

-- Step 3: record_email_result RPC.
-- ---------------------------------------------------------------------------
create or replace function public.record_email_result(
  p_appointment_id uuid,
  p_email_type text,
  p_success boolean
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_email_type = 'confirmation' then
    update public.appointments
      set confirmation_sent_at    = case when p_success then now() else confirmation_sent_at end,
          confirmation_claimed_at = null
      where id = p_appointment_id;
  elsif p_email_type = 'reminder_24h' then
    update public.appointments
      set reminder_24h_sent_at    = case when p_success then now() else reminder_24h_sent_at end,
          reminder_24h_claimed_at = null
      where id = p_appointment_id;
  elsif p_email_type = 'reminder_2h' then
    update public.appointments
      set reminder_2h_sent_at    = case when p_success then now() else reminder_2h_sent_at end,
          reminder_2h_claimed_at = null
      where id = p_appointment_id;
  else
    raise exception 'Unknown email_type: %', p_email_type;
  end if;
end;
$$;

-- Step 4: grants. service_role only; revoke the default PUBLIC execute.
-- ---------------------------------------------------------------------------
revoke all on function public.claim_email_send(uuid, text) from public, anon, authenticated;
revoke all on function public.record_email_result(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.claim_email_send(uuid, text) to service_role;
grant execute on function public.record_email_result(uuid, text, boolean) to service_role;
