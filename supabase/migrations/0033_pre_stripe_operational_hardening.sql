-- ===========================================================================
-- Migration 0033: pre-Stripe operational hardening
-- ===========================================================================
--
-- Scope (P0-2 + P0-3 of the pre-Stripe hardening pass):
--
--   1. Re-create public.record_email_attempt with hardened search_path,
--      schema-qualified table references, and execute restricted to
--      service_role only.
--
--   2. Add three new SECURITY DEFINER RPCs that own all appointment
--      state transitions away from `confirmed`. The application MUST
--      route every status mutation through these RPCs and stop using
--      direct UPDATE on appointments.status.
--
--        public_cancel_appointment_with_token(p_token, p_reason)
--        practitioner_cancel_appointment(p_appointment_id, p_studio_id,
--                                        p_practitioner_id, p_reason)
--        mark_appointment_no_show(p_appointment_id, p_studio_id,
--                                 p_practitioner_id)
--
--   3. Terminal-safety: every RPC refuses transitions away from any
--      non-`confirmed` row, so a completed / cancelled / no_show
--      appointment can NEVER be silently rewritten as cancelled by a
--      misrouted client action. Audit rows are written atomically with
--      the status flip.
--
--   4. The existing public.mark_appointment_complete RPC (migration 0032)
--      is left intact; this migration ensures its EXECUTE grant remains
--      service_role only and adds a small wrapper test in Block 2 below.
--
-- Migration 0032 is NOT modified. The 14 payment tables, RLS and
-- 45+ payment RPCs installed there remain unchanged.
--
-- Application contract:
--   * No application code may issue
--       update appointments set status = '<terminal>' ...
--     directly. The four RPCs in this file (plus mark_appointment_complete
--     from 0032) are the only authorized paths.
--   * The legacy no-show cron MUST be made non-mutating before this
--     migration is deployed; see app/api/cron/no-show-check/route.ts.
--
-- ===========================================================================

begin;

-- ===========================================================================
-- Section 1: re-secure record_email_attempt (P0-2).
-- ===========================================================================
-- The 0028 definition runs under set search_path = public, has no
-- explicit revoke, and the function is reachable from any role that
-- happens to have EXECUTE granted via the implicit public grant. Even
-- though no application code today calls it as anon/authenticated, the
-- function mutates appointments and must be locked down before
-- payments touch the same email-attempt fields.
--
-- Hardened version:
--   * search_path = pg_catalog, pg_temp (no public)
--   * every reference schema-qualified as public.appointments
--   * EXECUTE revoked from public, anon, authenticated
--   * EXECUTE granted to service_role
-- ===========================================================================
create or replace function public.record_email_attempt(
  p_appointment_id uuid,
  p_email_type     text,
  p_success        boolean
) returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if p_email_type = 'confirmation' then
    update public.appointments
       set confirmation_send_attempts = confirmation_send_attempts + 1,
           confirmation_sent_at = case
                                    when p_success then now()
                                    else confirmation_sent_at
                                  end
     where id = p_appointment_id;
  elsif p_email_type = 'reminder_24h' then
    update public.appointments
       set reminder_24h_send_attempts = reminder_24h_send_attempts + 1,
           reminder_24h_sent_at = case
                                    when p_success then now()
                                    else reminder_24h_sent_at
                                  end
     where id = p_appointment_id;
  elsif p_email_type = 'reminder_2h' then
    update public.appointments
       set reminder_2h_send_attempts = reminder_2h_send_attempts + 1,
           reminder_2h_sent_at = case
                                    when p_success then now()
                                    else reminder_2h_sent_at
                                  end
     where id = p_appointment_id;
  elsif p_email_type = 'no_show' then
    update public.appointments
       set no_show_email_send_attempts = no_show_email_send_attempts + 1,
           no_show_email_sent_at = case
                                     when p_success then now()
                                     else no_show_email_sent_at
                                   end
     where id = p_appointment_id;
  else
    raise exception 'Unknown email type: %', p_email_type;
  end if;
end;
$$;

revoke execute on function public.record_email_attempt(uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.record_email_attempt(uuid, text, boolean)
  to service_role;

-- ===========================================================================
-- Section 2: public token-based cancellation (P0-3).
-- ===========================================================================
-- Replaces the direct UPDATE in app/cancel/[token]/actions.ts.
--
-- Inputs:
--   p_token  - the cancellation_token persisted on the appointment row
--              (column-based token; the HMAC fallback is the caller's
--              responsibility before this RPC is invoked).
--   p_reason - free-form reason text supplied by the client.
--
-- Result table contract:
--   result IN ('cancelled', 'already_cancelled', 'not_cancelable',
--              'invalid_token')
--   appointment_id - the cancelled appointment id, or NULL when
--                    result='invalid_token'.
--   studio_id      - the studio that owns the appointment, or NULL when
--                    result='invalid_token'.
--
-- Application MUST present the same end-user message for
-- 'invalid_token' and 'not_cancelable' so the existence of a real
-- appointment row cannot be probed via token-shape comparisons.
--
-- Invariants:
--   * Cancellation is permitted ONLY from status='confirmed'.
--   * A past-start appointment cannot be cancelled via this path
--     (cancellations of in-progress / past appointments are operational
--     work, not client self-service).
--   * The appointment row is locked FOR UPDATE before mutation.
--   * Audit row is written in the same transaction.
-- ===========================================================================
create or replace function public.public_cancel_appointment_with_token(
  p_token  text,
  p_reason text
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
   where a.cancellation_token = p_token
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
    -- completed / no_show: refuse silently with neutral result; client
    -- cannot use this surface to flip terminal status.
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
         cancellation_reason = p_reason,
         updated_at          = now()
   where id = v_appt.id;

  insert into public.appointment_audit (
    appointment_id, actor_type, actor_id, action, details
  ) values (
    v_appt.id, 'client', null, 'cancelled',
    jsonb_build_object(
      'reason', coalesce(p_reason, ''),
      'source', 'public_token'
    )
  );

  return query select 'cancelled'::text, v_appt.id, v_appt.studio_id;
end;
$$;

revoke execute on function public.public_cancel_appointment_with_token(text, text)
  from public, anon, authenticated;
grant execute on function public.public_cancel_appointment_with_token(text, text)
  to service_role;

-- ===========================================================================
-- Section 3: practitioner-initiated cancellation (P0-3).
-- ===========================================================================
-- Replaces the direct UPDATE in app/(app)/calendar/actions.ts.
--
-- Inputs:
--   p_appointment_id, p_studio_id - the appointment scope.
--   p_practitioner_id             - the in-session practitioner; MUST
--                                   be active in the studio.
--   p_reason                      - free-form reason text.
--
-- Returns one of:
--   'cancelled' | 'already_cancelled' | 'not_cancelable' | 'not_authorized'
--
-- cancelled_by is derived from public.practitioners.role at the moment
-- of cancellation, so a non-owner practitioner cancellation is
-- attributed to 'practitioner' and an owner cancellation to 'owner'.
-- The application MUST NOT pass actor identity from the browser; the
-- server-side session supplies p_practitioner_id and this RPC reads
-- the role from the source-of-truth practitioner row.
-- ===========================================================================
create or replace function public.practitioner_cancel_appointment(
  p_appointment_id  uuid,
  p_studio_id       uuid,
  p_practitioner_id uuid,
  p_reason          text
) returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_role text;
  v_appt public.appointments%rowtype;
begin
  select pr.role into v_role
    from public.practitioners pr
   where pr.id = p_practitioner_id
     and pr.studio_id = p_studio_id
     and pr.active = true;
  if not found then
    return 'not_authorized';
  end if;

  select * into v_appt
    from public.appointments a
   where a.id = p_appointment_id
     and a.studio_id = p_studio_id
   for update;
  if not found then
    return 'not_cancelable';
  end if;

  if v_appt.status = 'cancelled' then
    return 'already_cancelled';
  end if;

  if v_appt.status <> 'confirmed' then
    return 'not_cancelable';
  end if;

  -- Terminal-safe guard: once an appointment has started, the legitimate
  -- practitioner outcomes are Mark Complete or Mark No-Show. Cancellation
  -- is no longer correct because the treatment either happened or did
  -- not happen; either way the row's outcome should not be 'cancelled'.
  -- This refuses both an in-progress appointment and one that ended in
  -- the past but was never marked complete / no-show.
  if v_appt.starts_at <= now() then
    return 'not_cancelable';
  end if;

  update public.appointments
     set status              = 'cancelled',
         cancelled_at        = now(),
         cancelled_by        = v_role,
         cancellation_reason = p_reason,
         updated_at          = now()
   where id = p_appointment_id;

  insert into public.appointment_audit (
    appointment_id, actor_type, actor_id, action, details
  ) values (
    p_appointment_id, 'practitioner', p_practitioner_id, 'cancelled',
    jsonb_build_object(
      'reason', coalesce(p_reason, ''),
      'role',   v_role,
      'source', 'practitioner_action'
    )
  );

  return 'cancelled';
end;
$$;

revoke execute on function public.practitioner_cancel_appointment(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.practitioner_cancel_appointment(uuid, uuid, uuid, text)
  to service_role;

-- ===========================================================================
-- Section 4: manual mark no-show (P0-3 + P0-1).
-- ===========================================================================
-- The first safe no-show transition: practitioner-initiated, AFTER
-- ends_at has passed, and only from status='confirmed'. Replaces the
-- automatic cron-mutating path (which is being disabled in this
-- branch).
--
-- Returns one of:
--   'marked' | 'too_early' | 'not_authorized' | 'wrong_status'
--
-- 'too_early' is returned when now() <= ends_at: the appointment may
-- still be running. The application MUST surface a clear UX label that
-- mark-no-show becomes available only after the appointment end time.
-- ===========================================================================
create or replace function public.mark_appointment_no_show(
  p_appointment_id  uuid,
  p_studio_id       uuid,
  p_practitioner_id uuid
) returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_appt public.appointments%rowtype;
begin
  if not exists (
    select 1
      from public.practitioners pr
     where pr.id = p_practitioner_id
       and pr.studio_id = p_studio_id
       and pr.active = true
  ) then
    return 'not_authorized';
  end if;

  select * into v_appt
    from public.appointments a
   where a.id = p_appointment_id
     and a.studio_id = p_studio_id
   for update;
  if not found then
    return 'wrong_status';
  end if;

  if v_appt.status <> 'confirmed' then
    return 'wrong_status';
  end if;

  if v_appt.ends_at > now() then
    return 'too_early';
  end if;

  update public.appointments
     set status     = 'no_show',
         updated_at = now()
   where id = p_appointment_id;

  insert into public.appointment_audit (
    appointment_id, actor_type, actor_id, action, details
  ) values (
    p_appointment_id, 'practitioner', p_practitioner_id, 'marked_no_show',
    jsonb_build_object(
      'marked_at', now(),
      'source',    'manual'
    )
  );

  return 'marked';
end;
$$;

revoke execute on function public.mark_appointment_no_show(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.mark_appointment_no_show(uuid, uuid, uuid)
  to service_role;

-- ===========================================================================
-- Section 5: ensure existing mark_appointment_complete grant is
-- service_role only (defensive re-revoke; already revoked from
-- public/anon/authenticated in migration 0032).
-- ===========================================================================
revoke execute on function public.mark_appointment_complete(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.mark_appointment_complete(uuid, uuid, uuid)
  to service_role;

-- ===========================================================================
-- Block 2: structural smoke tests (run inside install transaction).
-- ===========================================================================
do $block2_0033$
declare
  v_def text;
begin
  -- record_email_attempt body must reference pg_catalog/pg_temp search_path
  -- and schema-qualify public.appointments.
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'record_email_attempt';
  if v_def is null then
    raise exception '0033 Block 2: record_email_attempt missing'
      using errcode = '42883';
  end if;
  if v_def !~* 'search_path[[:space:]]+to[[:space:]]+''pg_catalog'',[[:space:]]*''pg_temp''' then
    raise exception '0033 Block 2: record_email_attempt search_path is not pg_catalog/pg_temp'
      using errcode = '23514';
  end if;
  if v_def !~* '\mpublic\.appointments\M' then
    raise exception '0033 Block 2: record_email_attempt must schema-qualify public.appointments'
      using errcode = '23514';
  end if;

  -- Each new RPC must exist with the expected signature and be revoked
  -- from public/anon/authenticated. We check has_function_privilege.
  if has_function_privilege('anon', 'public.public_cancel_appointment_with_token(text, text)', 'execute') then
    raise exception '0033 Block 2: anon must NOT have execute on public_cancel_appointment_with_token'
      using errcode = '42501';
  end if;
  if has_function_privilege('authenticated', 'public.public_cancel_appointment_with_token(text, text)', 'execute') then
    raise exception '0033 Block 2: authenticated must NOT have execute on public_cancel_appointment_with_token'
      using errcode = '42501';
  end if;
  if not has_function_privilege('service_role', 'public.public_cancel_appointment_with_token(text, text)', 'execute') then
    raise exception '0033 Block 2: service_role MUST have execute on public_cancel_appointment_with_token'
      using errcode = '42501';
  end if;

  if has_function_privilege('anon', 'public.practitioner_cancel_appointment(uuid, uuid, uuid, text)', 'execute') then
    raise exception '0033 Block 2: anon must NOT have execute on practitioner_cancel_appointment'
      using errcode = '42501';
  end if;
  if has_function_privilege('authenticated', 'public.practitioner_cancel_appointment(uuid, uuid, uuid, text)', 'execute') then
    raise exception '0033 Block 2: authenticated must NOT have execute on practitioner_cancel_appointment'
      using errcode = '42501';
  end if;
  if not has_function_privilege('service_role', 'public.practitioner_cancel_appointment(uuid, uuid, uuid, text)', 'execute') then
    raise exception '0033 Block 2: service_role MUST have execute on practitioner_cancel_appointment'
      using errcode = '42501';
  end if;

  if has_function_privilege('anon', 'public.mark_appointment_no_show(uuid, uuid, uuid)', 'execute') then
    raise exception '0033 Block 2: anon must NOT have execute on mark_appointment_no_show'
      using errcode = '42501';
  end if;
  if has_function_privilege('authenticated', 'public.mark_appointment_no_show(uuid, uuid, uuid)', 'execute') then
    raise exception '0033 Block 2: authenticated must NOT have execute on mark_appointment_no_show'
      using errcode = '42501';
  end if;
  if not has_function_privilege('service_role', 'public.mark_appointment_no_show(uuid, uuid, uuid)', 'execute') then
    raise exception '0033 Block 2: service_role MUST have execute on mark_appointment_no_show'
      using errcode = '42501';
  end if;

  if has_function_privilege('anon', 'public.record_email_attempt(uuid, text, boolean)', 'execute') then
    raise exception '0033 Block 2: anon must NOT have execute on record_email_attempt'
      using errcode = '42501';
  end if;
  if has_function_privilege('authenticated', 'public.record_email_attempt(uuid, text, boolean)', 'execute') then
    raise exception '0033 Block 2: authenticated must NOT have execute on record_email_attempt'
      using errcode = '42501';
  end if;
  if not has_function_privilege('service_role', 'public.record_email_attempt(uuid, text, boolean)', 'execute') then
    raise exception '0033 Block 2: service_role MUST have execute on record_email_attempt'
      using errcode = '42501';
  end if;

  if has_function_privilege('anon', 'public.mark_appointment_complete(uuid, uuid, uuid)', 'execute') then
    raise exception '0033 Block 2: anon must NOT have execute on mark_appointment_complete'
      using errcode = '42501';
  end if;
  if has_function_privilege('authenticated', 'public.mark_appointment_complete(uuid, uuid, uuid)', 'execute') then
    raise exception '0033 Block 2: authenticated must NOT have execute on mark_appointment_complete'
      using errcode = '42501';
  end if;

  raise notice '0033 Block 2: hardened record_email_attempt and new cancellation/no-show RPCs verified service_role-only.';
end
$block2_0033$;

-- ===========================================================================
-- Section 6: production-data backfill for missing cancellation_token.
-- ===========================================================================
-- Pre-deploy preflight (Section 1.3 of the rollout runbook) identified
-- at least one future `confirmed` appointment whose `cancellation_token`
-- is NULL. Those rows pre-date the column-based token rollout and would
-- otherwise need a manual remediation step before app deploy. We
-- handle the case in the migration itself so a fresh `supabase db push`
-- against any environment leaves the invariant
--   for every confirmed future appointment, cancellation_token is set
-- TRUE.
--
-- Properties:
--   * Idempotent. WHERE filter targets only NULL / blank tokens; a
--     re-apply against a clean DB updates zero rows. Local DB resets
--     (which have no real data) consequently log "backfilled 0".
--   * URL-safe token: gen_random_uuid()::text with the four hyphens
--     stripped. The resulting 32-character hex string is base16,
--     therefore URL-safe and free of '+' / '/' characters that
--     base64-derived tokens previously carried.
--   * Server-side data only is logged. The notice prints the count;
--     it does NOT print any actual token values, so the log is safe
--     to retain in CI / migration history.
--   * Fail-closed. The post-update SELECT re-runs the same predicate
--     and raises 23514 if any row remains. The transaction therefore
--     refuses to commit a state where a future confirmed appointment
--     still lacks a token.
-- ===========================================================================
do $backfill_missing_cancellation_tokens_0033$
declare
  v_count integer;
  v_remaining integer;
begin
  update public.appointments
     set cancellation_token = replace(gen_random_uuid()::text, '-', ''),
         updated_at = now()
   where status = 'confirmed'
     and starts_at > now()
     and (
       cancellation_token is null
       or length(btrim(cancellation_token)) = 0
     );

  get diagnostics v_count = row_count;

  select count(*) into v_remaining
    from public.appointments
   where status = 'confirmed'
     and starts_at > now()
     and (
       cancellation_token is null
       or length(btrim(cancellation_token)) = 0
     );

  if v_remaining > 0 then
    raise exception '0033: future confirmed appointments still missing cancellation_token after backfill: %', v_remaining
      using errcode = '23514';
  end if;

  raise notice '0033: backfilled % future confirmed appointments missing cancellation_token', v_count;
end
$backfill_missing_cancellation_tokens_0033$;

commit;
