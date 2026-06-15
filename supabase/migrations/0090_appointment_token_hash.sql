-- ---------------------------------------------------------------------------
-- PR #260. Appointment cancel/reschedule token hash-at-rest.
-- ---------------------------------------------------------------------------
--
-- Today `appointments.cancellation_token` (migration 0025) holds the RAW
-- high-entropy bearer token that the public /cancel, /reschedule, and
-- /manage routes read as their only credential. The same raw value is
-- stored AND looked up directly, so a DB compromise would expose every
-- live cancel/reschedule link. The portal session and calendar-feed
-- tokens are already hashed at rest (migrations 0052 / 0079); appointment
-- tokens follow the same pattern here.
--
-- This migration mirrors the calendar-feed hash-at-rest playbook
-- (migration 0079) applied to appointments:
--
--   * NEW column: appointments.cancellation_token_hash text (nullable).
--   * NEW CHECK : 64 lowercase hex chars or NULL.
--   * NEW partial unique on the hash WHERE NOT NULL.
--   * BACKFILL  : every row whose cancellation_token IS NOT NULL gets its
--                  SHA-256 hex hash computed via pgcrypto digest.
--   * NEW trigger: BEFORE INSERT/UPDATE auto-populates the hash from the
--                  raw token whenever the hash is null and a raw token is
--                  present. This is the compatibility net for the deploy
--                  window: an OLD app instance (still running between this
--                  migration applying and the app code deploying) inserts
--                  rows with the raw column set and NO hash; the trigger
--                  hashes them so the NEW app's hash-only lookup finds
--                  them. After the deploy window the new app writes the
--                  hash directly and the trigger is a no-op.
--   * REPLACE both token-verifying RPCs so they match the HASH the app
--     now passes, while ALSO matching the raw column during the deploy
--     window (an in-flight OLD-app request passes the raw token).
--
-- The raw column appointments.cancellation_token is KEPT (not nulled, not
-- dropped) so already-emitted /cancel/<raw> links in client inboxes keep
-- resolving through the deploy. A later safe PR nulls + drops the raw
-- column once no in-flight raw links remain. Decision recorded in docs/13
-- (PR #260 entry).
--
-- pgcrypto note: Supabase installs pgcrypto in the `extensions` schema.
-- The schema-qualified `extensions.digest(...)` call follows the
-- precedent from migrations 0032 and 0079 and is safe under the hardened
-- search_path. pgcrypto is created in migration 0001, so this migration
-- does NOT re-create it.
--
-- Safety:
--   * NO destructive DML. The backfill UPDATE only writes the hash where
--     it is null; the raw token is read but never modified or cleared.
--   * NO RLS change. The public token routes already use the service-role
--     admin client; the RPCs stay SECURITY DEFINER, service_role-only.
--   * NO payment table touched. paymentIntents.create / refunds.create
--     gates remain unchanged (lib/billing/*).
--   * NO live-mode CHECK relaxed. Live payments remain disabled.
--   * Re-runnable: add column IF NOT EXISTS; CHECK + trigger DROP+ADD;
--     unique index IF NOT EXISTS; backfill filters on hash IS NULL;
--     RPC bodies use CREATE OR REPLACE on unchanged signatures.
--
-- Migration ledger: latest in tree was 0089 (PR #259 was docs-only; the
-- last schema migration was 0089 imported treatment memory). This is 0090.
-- ---------------------------------------------------------------------------

-- ============================================================
-- 1) Column.
-- ============================================================
alter table public.appointments
  add column if not exists cancellation_token_hash text;

-- ============================================================
-- 2) Backfill from existing raw tokens. SHA-256 hex via pgcrypto digest
--    in the extensions schema (Supabase default install). encode(...)
--    yields lowercase hex. Idempotent via the hash-is-null filter.
-- ============================================================
update public.appointments
   set cancellation_token_hash =
       encode(extensions.digest(cancellation_token, 'sha256'), 'hex')
 where cancellation_token is not null
   and cancellation_token_hash is null;

-- ============================================================
-- 3) Format CHECK. 64 lowercase hex characters or NULL. DROP+ADD keeps
--    the migration re-runnable.
-- ============================================================
alter table public.appointments
  drop constraint if exists appointments_cancellation_token_hash_check;
alter table public.appointments
  add constraint appointments_cancellation_token_hash_check
    check (
      cancellation_token_hash is null
      or cancellation_token_hash ~ '^[a-f0-9]{64}$'
    );

-- ============================================================
-- 4) Partial unique on the hash. Mirrors the existing
--    appointments_cancellation_token_unique on the raw column (0025).
--    The runtime cancel/reschedule/manage lookups query this column
--    after the PR #260 app code merges.
-- ============================================================
create unique index if not exists appointments_cancellation_token_hash_uniq
  on public.appointments (cancellation_token_hash)
  where cancellation_token_hash is not null;

-- ============================================================
-- 5) Deploy-window + compatibility trigger. Auto-hash the raw token
--    whenever the hash is absent. This keeps every row hash-lookupable
--    regardless of which app version wrote it, so the app resolvers can
--    be purely hash-based and no row is ever orphaned during the deploy.
--    A no-op for new-app writes (hash already set) and for updates that
--    do not touch the token columns.
-- ============================================================
create or replace function public.appointments_hash_cancellation_token()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.cancellation_token is not null
     and new.cancellation_token_hash is null then
    new.cancellation_token_hash :=
      encode(extensions.digest(new.cancellation_token, 'sha256'), 'hex');
  end if;
  return new;
end;
$$;

drop trigger if exists appointments_hash_cancellation_token_trg
  on public.appointments;
create trigger appointments_hash_cancellation_token_trg
  before insert or update on public.appointments
  for each row
  execute function public.appointments_hash_cancellation_token();

-- ============================================================
-- 6) Cancel RPC. Re-create public_cancel_appointment_with_token (5-arg,
--    migration 0063) so it matches by HASH. The application now passes
--    the SHA-256 hash of the URL token as p_token. The OR raw branch
--    keeps an in-flight OLD-app request (which still passes the raw
--    token) working through the deploy window; a later PR drops it.
--    The two branches are mutually exclusive in practice (a 32-char
--    base64url raw token can never equal a 64-hex hash), so there is no
--    cross-matching. Body is otherwise byte-for-byte the 0063 logic.
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
      or a.cancellation_token = p_token
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
-- 7) Reschedule RPC. Re-create public.reschedule_appointment (migration
--    0066) so it matches the ORIGINAL by hash (OR raw, deploy window) and
--    stores the NEW token as a hash. The application passes the hash of
--    the submitted token as p_current_cancellation_token and the hash of
--    the freshly-generated new token as p_new_cancellation_token.
--
--    The new-token INSERT routes by shape so the deploy window is safe:
--    a 64-hex value (the new app's hash) goes straight into
--    cancellation_token_hash with the raw column NULL; any other value
--    (an in-flight OLD-app request still passing a raw token) goes into
--    the raw column and the trigger above hashes it. New-app rows are
--    therefore hash-only (no raw token at rest). All other behavior
--    (future guards, atomic cancel-original + insert-new + twin audit
--    rows, 23P01 bubbling) is the 0066 logic unchanged.
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
    and (cancellation_token_hash = p_current_cancellation_token
         or cancellation_token = p_current_cancellation_token)
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
    cancellation_token,
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
    case when p_new_cancellation_token ~ '^[a-f0-9]{64}$'
         then null else p_new_cancellation_token end,
    case when p_new_cancellation_token ~ '^[a-f0-9]{64}$'
         then p_new_cancellation_token else null end
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
