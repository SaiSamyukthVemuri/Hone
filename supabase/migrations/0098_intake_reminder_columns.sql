-- Migration 0098: intake-reminder idempotency columns + claim/record RPC
-- branches (PR #306). Adds a 7-day and a 3-day "please complete your intake
-- form" reminder to the existing appointment-reminder cron, using the SAME
-- column-based, claim-before-send idempotency model as the 24h/2h reminders
-- (migrations 0025 + 0080).
--
-- Additive / backfill-safe: new columns are nullable timestamptz + an integer
-- NOT NULL DEFAULT 0 (existing rows read 0). NO RLS change, NO enum change, NO
-- destructive DDL. The claim_email_send / record_email_result functions are
-- re-created with their EXISTING branches byte-for-byte plus two new branches,
-- so confirmation / reminder_24h / reminder_2h behavior is unchanged.

-- Step 1: per-appointment idempotency columns (mirror reminder_24h/2h).
-- ---------------------------------------------------------------------------
alter table public.appointments
  add column if not exists intake_reminder_7d_sent_at timestamptz,
  add column if not exists intake_reminder_7d_send_attempts integer not null default 0,
  add column if not exists intake_reminder_7d_claimed_at timestamptz,
  add column if not exists intake_reminder_3d_sent_at timestamptz,
  add column if not exists intake_reminder_3d_send_attempts integer not null default 0,
  add column if not exists intake_reminder_3d_claimed_at timestamptz;

comment on column public.appointments.intake_reminder_7d_claimed_at is
  'Held by claim_email_send before the Resend call; cleared by record_email_result. Stale after 5 minutes.';
comment on column public.appointments.intake_reminder_3d_claimed_at is
  'Held by claim_email_send before the Resend call; cleared by record_email_result. Stale after 5 minutes.';

-- Step 2: partial indexes for the due-window query (mirror 0025 email idxs).
-- ---------------------------------------------------------------------------
create index if not exists appointments_intake_reminder_7d_window_idx
  on public.appointments (starts_at)
  where intake_reminder_7d_sent_at is null
    and status = 'confirmed'
    and intake_reminder_7d_send_attempts < 3;

create index if not exists appointments_intake_reminder_3d_window_idx
  on public.appointments (starts_at)
  where intake_reminder_3d_sent_at is null
    and status = 'confirmed'
    and intake_reminder_3d_send_attempts < 3;

-- Step 3: extend claim_email_send. Existing branches reproduced verbatim; two
-- new branches added for intake_reminder_7d / intake_reminder_3d.
-- ---------------------------------------------------------------------------
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
  elsif p_email_type = 'intake_reminder_7d' then
    update public.appointments
      set intake_reminder_7d_send_attempts = intake_reminder_7d_send_attempts + 1,
          intake_reminder_7d_claimed_at    = v_now
      where id = p_appointment_id
        and intake_reminder_7d_sent_at is null
        and intake_reminder_7d_send_attempts < 3
        and (intake_reminder_7d_claimed_at is null
             or intake_reminder_7d_claimed_at < v_stale_cutoff);
    get diagnostics v_updated = row_count;
  elsif p_email_type = 'intake_reminder_3d' then
    update public.appointments
      set intake_reminder_3d_send_attempts = intake_reminder_3d_send_attempts + 1,
          intake_reminder_3d_claimed_at    = v_now
      where id = p_appointment_id
        and intake_reminder_3d_sent_at is null
        and intake_reminder_3d_send_attempts < 3
        and (intake_reminder_3d_claimed_at is null
             or intake_reminder_3d_claimed_at < v_stale_cutoff);
    get diagnostics v_updated = row_count;
  else
    raise exception 'Unknown email_type: %', p_email_type;
  end if;

  return v_updated = 1;
end;
$$;

-- Step 4: extend record_email_result. Existing branches verbatim + two new.
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
  elsif p_email_type = 'intake_reminder_7d' then
    update public.appointments
      set intake_reminder_7d_sent_at    = case when p_success then now() else intake_reminder_7d_sent_at end,
          intake_reminder_7d_claimed_at = null
      where id = p_appointment_id;
  elsif p_email_type = 'intake_reminder_3d' then
    update public.appointments
      set intake_reminder_3d_sent_at    = case when p_success then now() else intake_reminder_3d_sent_at end,
          intake_reminder_3d_claimed_at = null
      where id = p_appointment_id;
  else
    raise exception 'Unknown email_type: %', p_email_type;
  end if;
end;
$$;

-- Step 5: grants (unchanged signatures; re-assert service_role-only, idempotent).
-- ---------------------------------------------------------------------------
revoke all on function public.claim_email_send(uuid, text) from public, anon, authenticated;
revoke all on function public.record_email_result(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.claim_email_send(uuid, text) to service_role;
grant execute on function public.record_email_result(uuid, text, boolean) to service_role;
