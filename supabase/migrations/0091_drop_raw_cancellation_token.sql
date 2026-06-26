-- ---------------------------------------------------------------------------
-- PR #264. Drop the legacy raw appointments.cancellation_token column.
-- ---------------------------------------------------------------------------
--
-- PR #260 (migration 0090) moved appointment cancel/reschedule/manage tokens
-- to hash-at-rest: it added appointments.cancellation_token_hash, backfilled
-- the hash for every row whose raw token was non-null, added a BEFORE
-- INSERT/UPDATE trigger that auto-hashed a raw token when the hash was
-- absent, and made the two token-verifying RPCs DUAL-MATCH
-- (cancellation_token_hash = $token OR cancellation_token = $token) so that
-- in-flight OLD-app requests passing a raw token kept working through the
-- deploy. The raw column appointments.cancellation_token was KEPT
-- temporarily for that deploy window (decision in docs/13, PR #260).
--
-- That deploy window is now closed:
--   * The app stores ONLY the hash at creation (app/book/[slug]/actions.ts,
--     app/(app)/calendar/actions.ts) and looks up tokens hash-only
--     (cancel/reschedule/manage actions hash the incoming URL token and
--     match cancellation_token_hash).
--   * Surfaces that rebuild a link after creation (reminder email/SMS via
--     cron, internal-booking confirmation) mint the stateless HMAC token;
--     they no longer read the raw column.
--   * Already-emitted raw /cancel/<raw> | /reschedule/<raw> | /manage/<raw>
--     links STILL resolve: the app hashes the incoming URL token and matches
--     the hash that 0090 backfilled for that row, so no stored raw value is
--     needed.
--
-- This migration removes the raw token from storage entirely:
--   1. Re-create public_cancel_appointment_with_token (5-arg) HASH-ONLY
--      (drop the `OR cancellation_token = p_token` deploy-window branch).
--   2. Re-create reschedule_appointment HASH-ONLY (drop the dual-match raw
--      branch in the lookup AND drop the raw-column INSERT + shape-routing;
--      the new token is stored only as cancellation_token_hash — the app
--      always passes a 64-hex hash, and the format CHECK is the backstop).
--   3. Drop the dead functions that still referenced the raw column and are
--      no longer called by anything: the 2-arg
--      public_cancel_appointment_with_token(text, text) (migration 0033) and
--      finalize_card_required_public_booking (migration 0032, the
--      never-completed card-required public-booking flow). Leaving them would
--      strand a SECURITY DEFINER body that INSERTs/reads a dropped column.
--   4. Drop the deploy-window hashing trigger + its function (they read the
--      raw column).
--   5. Drop the raw column appointments.cancellation_token, which also
--      removes its 0025 unique constraint (appointments_cancellation_token
--      _unique) and partial index (appointments_cancellation_token_idx).
--
-- Internal ordering is deliberate: the RPC bodies are re-created hash-only
-- BEFORE the column is dropped, because PostgreSQL does not dependency-check
-- plpgsql bodies and a remaining raw reference would otherwise fail at the
-- next cancel/reschedule/insert. The re-created RPCs stay compatible with
-- the already-running PR #260..#263 app (it already passes hashes), so there
-- is no deploy-order window in which the live app errors. App code that
-- removed the now-dead raw reads ships in the same PR.
--
-- Safety:
--   * cancellation_token_hash, its CHECK, and its partial unique index are
--     UNCHANGED — the canonical lookup column is untouched.
--   * NO RLS change. The public token routes use the service-role admin
--     client; the RPCs stay SECURITY DEFINER, service_role-only.
--   * NO payment table touched. paymentIntents.create / refunds.create gates
--     remain unchanged (lib/billing/*). NO live-mode CHECK relaxed. Live
--     payments remain disabled.
--   * NO pgcrypto re-create (created in 0001).
--   * Re-runnable: CREATE OR REPLACE on unchanged signatures; DROP ... IF
--     EXISTS for the trigger/function/2-arg RPC/constraint/index/column.
--
-- Migration ledger: latest in tree was 0090 (PR #260). This is 0091.
-- ---------------------------------------------------------------------------

-- ============================================================
-- 1) Cancel RPC (5-arg) -> HASH-ONLY. Byte-for-byte the 0090/0063 body
--    except the lookup drops the `OR a.cancellation_token = p_token`
--    deploy-window branch and matches cancellation_token_hash only.
-- ============================================================
create or replace function public.public_cancel_appointment_with_token(
  p_token              text,
  p_reason             text,
  p_reason_label       text,
  p_note               text,
  p_follow_up_allowed  boolean
) returns table (
  result          text,
  appointment_id  uuid,
  studio_id       uuid
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_appt public.appointments%rowtype;
begin
  if p_token is null or length(trim(p_token)) = 0 then
    return query select 'invalid_token'::text, null::uuid, null::uuid;
    return;
  end if;

  select * into v_appt
    from public.appointments a
   where a.cancellation_token_hash = p_token
   for update;
  if not found then
    return query select 'invalid_token'::text, null::uuid, null::uuid;
    return;
  end if;

  if v_appt.status = 'cancelled' then
    return query select 'already_cancelled'::text, v_appt.id, v_appt.studio_id;
    return;
  end if;

  if v_appt.status <> 'confirmed' then
    return query select 'not_cancelable'::text, v_appt.id, v_appt.studio_id;
    return;
  end if;

  if v_appt.starts_at <= now() then
    return query select 'not_cancelable'::text, v_appt.id, v_appt.studio_id;
    return;
  end if;

  update public.appointments
     set status              = 'cancelled',
         cancelled_at        = now(),
         cancelled_by        = 'client',
         cancellation_reason = nullif(p_reason_label, ''),
         updated_at          = now()
   where id = v_appt.id;

  insert into public.appointment_audit (
    appointment_id, actor_type, actor_id, action, details
  ) values (
    v_appt.id, 'client', null, 'cancelled',
    jsonb_build_object(
      'source',             'public_token',
      'reason',             coalesce(p_reason, ''),
      'reason_label',       coalesce(p_reason_label, ''),
      'note',               coalesce(p_note, ''),
      'follow_up_allowed',  coalesce(p_follow_up_allowed, false)
    )
  );

  return query select 'cancelled'::text, v_appt.id, v_appt.studio_id;
end;
$$;

revoke execute on function public.public_cancel_appointment_with_token(
  text, text, text, text, boolean
) from public;
revoke execute on function public.public_cancel_appointment_with_token(
  text, text, text, text, boolean
) from anon;
revoke execute on function public.public_cancel_appointment_with_token(
  text, text, text, text, boolean
) from authenticated;
grant execute on function public.public_cancel_appointment_with_token(
  text, text, text, text, boolean
) to service_role;

-- ============================================================
-- 2) Drop the dead 2-arg cancel RPC (migration 0033). It is no longer
--    called by the app and still matched the raw column
--    (where a.cancellation_token = p_token), which the column drop below
--    would leave dangling.
-- ============================================================
drop function if exists public.public_cancel_appointment_with_token(text, text);

-- Drop the dead finalize_card_required_public_booking (migration 0032,
-- SECURITY DEFINER). It belongs to the never-completed card-required public
-- booking flow (no caller anywhere in app/lib/tests/RPCs — only a comment
-- reference in 0064) and still INSERTs the raw cancellation_token column,
-- which the column drop below would otherwise leave dangling. If that flow is
-- ever revived it must store cancellation_token_hash only.
drop function if exists public.finalize_card_required_public_booking(
  text, uuid, text, text, text
);

-- ============================================================
-- 3) Reschedule RPC -> HASH-ONLY. Byte-for-byte the 0090/0066 body except:
--    the lookup drops the `OR cancellation_token = p_current_cancellation
--    _token` branch, and the new-appointment INSERT no longer writes the
--    raw column or shape-routes — it stores cancellation_token_hash only
--    (the app always passes a 64-hex hash; the format CHECK rejects a
--    malformed value).
-- ============================================================
create or replace function public.reschedule_appointment(
  p_original_appointment_id uuid,
  p_current_cancellation_token text,
  p_new_starts_at timestamptz,
  p_new_ends_at timestamptz,
  p_new_duration_minutes integer,
  p_new_cancellation_token text
) returns table (
  result text,
  new_appointment_id uuid,
  error_detail text
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_original public.appointments%rowtype;
  v_new_id uuid;
begin
  select * into v_original
  from public.appointments
  where id = p_original_appointment_id
    and cancellation_token_hash = p_current_cancellation_token
  for update;

  if not found then
    return query select 'appointment_not_found'::text, null::uuid, null::text;
    return;
  end if;

  if v_original.status <> 'confirmed' then
    return query select 'appointment_not_reschedulable'::text,
                        null::uuid,
                        format('current status: %s', v_original.status);
    return;
  end if;

  if v_original.starts_at <= now() then
    return query select 'appointment_not_reschedulable'::text,
                        null::uuid,
                        'original starts_at is not in the future';
    return;
  end if;

  if p_new_starts_at <= now() then
    return query select 'invalid_time_range'::text,
                        null::uuid,
                        'new starts_at must be in the future';
    return;
  end if;

  if p_new_ends_at <= p_new_starts_at then
    return query select 'invalid_time_range'::text,
                        null::uuid,
                        'new ends_at must be after new starts_at';
    return;
  end if;

  update public.appointments
    set status = 'cancelled',
        cancelled_at = now(),
        cancelled_by = 'client',
        cancellation_reason = 'Rescheduled via email link',
        updated_at = now()
    where id = p_original_appointment_id;

  insert into public.appointments (
    studio_id,
    practitioner_id,
    client_id,
    service_id,
    starts_at,
    ends_at,
    duration_minutes,
    status,
    notes,
    cancellation_token_hash
  )
  values (
    v_original.studio_id,
    v_original.practitioner_id,
    v_original.client_id,
    v_original.service_id,
    p_new_starts_at,
    p_new_ends_at,
    p_new_duration_minutes,
    'confirmed',
    v_original.notes,
    p_new_cancellation_token
  )
  returning id into v_new_id;

  insert into public.appointment_audit (
    appointment_id, actor_type, actor_id, action, details
  )
  values (
    p_original_appointment_id,
    'client',
    null,
    'cancelled',
    jsonb_build_object(
      'reason', 'rescheduled',
      'new_appointment_id', v_new_id
    )
  );

  insert into public.appointment_audit (
    appointment_id, actor_type, actor_id, action, details
  )
  values (
    v_new_id,
    'client',
    null,
    'created',
    jsonb_build_object(
      'source', 'reschedule_link',
      'original_appointment_id', p_original_appointment_id
    )
  );

  return query select 'success'::text, v_new_id, null::text;
end;
$$;

revoke execute on function public.reschedule_appointment(
  uuid, text, timestamptz, timestamptz, integer, text
) from public;
revoke execute on function public.reschedule_appointment(
  uuid, text, timestamptz, timestamptz, integer, text
) from anon;
revoke execute on function public.reschedule_appointment(
  uuid, text, timestamptz, timestamptz, integer, text
) from authenticated;
grant execute on function public.reschedule_appointment(
  uuid, text, timestamptz, timestamptz, integer, text
) to service_role;

-- ============================================================
-- 4) Drop the deploy-window hashing trigger + its function. They exist
--    only to auto-hash a raw token during the 0090 deploy window; with the
--    raw column gone they have nothing to read.
-- ============================================================
drop trigger if exists appointments_hash_cancellation_token_trg
  on public.appointments;
drop function if exists public.appointments_hash_cancellation_token();

-- ============================================================
-- 5) Drop the raw column. This also removes the 0025 unique constraint
--    (appointments_cancellation_token_unique) and partial index
--    (appointments_cancellation_token_idx), which depend on it. Explicit
--    drops first keep the migration re-runnable and self-documenting.
--    cancellation_token_hash + its CHECK + partial unique are untouched.
-- ============================================================
alter table public.appointments
  drop constraint if exists appointments_cancellation_token_unique;
drop index if exists public.appointments_cancellation_token_idx;
alter table public.appointments
  drop column if exists cancellation_token;
