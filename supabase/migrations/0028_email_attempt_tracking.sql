-- Migration 0028: atomic email attempt tracking.
--
-- The pre-existing code path stamped *_sent_at unconditionally after
-- calling safeSend(), which swallowed Resend errors. Result: the DB
-- said an email was sent when it wasn't, and the 3-attempt retry cap
-- never recovered because *_sent_at was already populated.
--
-- This migration adds:
--   1. no_show_email_send_attempts column for parity with the other email
--      types (the column was missing; the no-show route only stamped
--      _sent_at without an attempts counter).
--   2. record_email_attempt(): a single SQL function that atomically
--      increments the right attempts column AND stamps _sent_at only on
--      success. Replaces the broken read-then-write pattern in app code.
--
-- The optional backfill at the bottom resets attempt counters for any
-- appointments that hit 3 attempts before the fix shipped (so they're
-- not permanently stuck). Run the diagnostic first; uncomment + run the
-- backfill only if it returns nonzero counts.

-- Step 1: parity column for the no-show flow.
alter table public.appointments
  add column if not exists no_show_email_send_attempts integer not null default 0;

-- Step 2: atomic recorder.
-- email_type accepts one of four known values; anything else raises.
-- success=true stamps the matching _sent_at to now(); success=false
-- leaves it alone. Attempts increment in either case.
create or replace function public.record_email_attempt(
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
      set confirmation_send_attempts = confirmation_send_attempts + 1,
          confirmation_sent_at = case when p_success then now() else confirmation_sent_at end
      where id = p_appointment_id;
  elsif p_email_type = 'reminder_24h' then
    update public.appointments
      set reminder_24h_send_attempts = reminder_24h_send_attempts + 1,
          reminder_24h_sent_at = case when p_success then now() else reminder_24h_sent_at end
      where id = p_appointment_id;
  elsif p_email_type = 'reminder_2h' then
    update public.appointments
      set reminder_2h_send_attempts = reminder_2h_send_attempts + 1,
          reminder_2h_sent_at = case when p_success then now() else reminder_2h_sent_at end
      where id = p_appointment_id;
  elsif p_email_type = 'no_show' then
    update public.appointments
      set no_show_email_send_attempts = no_show_email_send_attempts + 1,
          no_show_email_sent_at = case when p_success then now() else no_show_email_sent_at end
      where id = p_appointment_id;
  else
    raise exception 'Unknown email type: %', p_email_type;
  end if;
end;
$$;

-- Step 3 (optional, after running diagnostic): reset attempt counters
-- for future-dated appointments that got stuck at 3 attempts before the
-- bug was fixed.
--
-- DIAGNOSTIC FIRST. Run this query:
--
--   select
--     count(*) filter (where confirmation_send_attempts >= 3 and confirmation_sent_at is null
--                       and status = 'confirmed' and starts_at > now()) as confirm_stuck,
--     count(*) filter (where reminder_24h_send_attempts >= 3 and reminder_24h_sent_at is null
--                       and status = 'confirmed' and starts_at > now()) as r24h_stuck,
--     count(*) filter (where reminder_2h_send_attempts >= 3 and reminder_2h_sent_at is null
--                       and status = 'confirmed' and starts_at > now()) as r2h_stuck
--   from public.appointments;
--
-- If any count is greater than 0 and reasonably small (< 10 per type),
-- uncomment and run the matching UPDATE below. Only future-dated
-- appointments are worth retrying.
--
-- update public.appointments
--   set confirmation_send_attempts = 0
--   where confirmation_send_attempts >= 3
--     and confirmation_sent_at is null
--     and status = 'confirmed'
--     and starts_at > now();
--
-- update public.appointments
--   set reminder_24h_send_attempts = 0
--   where reminder_24h_send_attempts >= 3
--     and reminder_24h_sent_at is null
--     and status = 'confirmed'
--     and starts_at > now();
--
-- update public.appointments
--   set reminder_2h_send_attempts = 0
--   where reminder_2h_send_attempts >= 3
--     and reminder_2h_sent_at is null
--     and status = 'confirmed'
--     and starts_at > now();
