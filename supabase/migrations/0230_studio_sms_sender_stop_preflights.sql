-- ===========================================================================
-- 0230: SMS-STOP-PREFLIGHT-RECORD-01 (HON-50 G6): the RECORDED result of the
-- inbound STOP preflight (#873) for one studio sender, the precondition a
-- listed studio must meet before any message leaves from its own number.
-- ===========================================================================
--
-- WHY. Per-studio routing sends from the studio's own Messaging Service. A
-- client replying STOP reaches Hone only if that service forwards inbound to
-- Hone's route, signed with the account whose token Hone holds; otherwise the
-- route answers 403, nothing is written, and the person stays subscribed.
-- lib/sms/inbound-stop-preflight.ts decides that from facts gathered
-- read-only. This table records the decision, so the send path can refuse a
-- studio-routed message whose STOP path was never proven.
--
-- NO PROVIDER CALL AT SEND TIME. The send path reads this record inside the
-- same one-statement snapshot as the sender and decides with a pure function
-- (lib/sms/stop-preflight-record.ts, stopPreflightVerdict).
--
-- WHAT THIS MIGRATION DOES
--   1. studio_sms_sender_stop_preflights: ONE current row per sender. It stores
--      check ids and pass/fail/unknown ONLY (never a detail string, which can
--      carry a URL), the webhook base it was evaluated against (a non-secret
--      URL, no query or userinfo), and an optional non-secret credentials
--      epoch. `ready` is DERIVED by the writer (every check passed), never
--      taken from the caller. No secret and no token fingerprint is stored.
--   2. record_studio_sms_stop_preflight(...): the only writer, the 0229
--      pattern exactly: locks the sender, refuses one that is released,
--      another studio's, or no longer holding the number the caller saw, and
--      compare-and-sets on the checked_at the caller read before gathering its
--      facts (preflight_changed otherwise). Only the database clock is compared.
--   3. get_live_studio_sms_sender_registration_state(uuid): 0229's body
--      EXACTLY, plus ONE key, `stop_preflights`. Every 0217 and 0229 key is
--      unchanged. THIS REPLACES 0229's FUNCTION BODY: it must stay a superset
--      of it (pinned by tests/migrations/0230-*).
--
-- PRIVILEGES. Table and functions are revoked from public, anon,
-- authenticated AND service_role by name; only EXECUTE on the two functions
-- is granted back to service_role (the 0217/0229 precedent).
--
-- Records evidence only: it calls no provider, activates nothing, and
-- changes no sender row.
-- ===========================================================================

begin;
set local lock_timeout = '5s';

create table public.studio_sms_sender_stop_preflights (
  id                       uuid        primary key default gen_random_uuid(),
  studio_id                uuid        not null references public.studios (id) on delete cascade,
  sender_id                uuid        not null references public.studio_sms_senders (id) on delete cascade,
  -- The number the sender held when the facts were gathered, canonical E.164.
  phone_number             text        not null,
  -- The service whose inbound configuration was read.
  messaging_service_sid    text        not null,
  -- [{ "id": "<check id>", "status": "pass" | "fail" | "unknown" }, ...]
  checks                   jsonb       not null,
  -- Derived by the writer: at least one check, and every check passed.
  ready                    boolean     not null,
  -- TWILIO_WEBHOOK_BASE_URL as evaluated, without trailing slash.
  webhook_base             text        not null,
  -- Optional, non-secret, bumped on credential rotation (HON-50 open question;
  -- unused by the verdict until that option is chosen).
  credentials_epoch        text,
  -- When the current token and base became active (#873 signatureProof), audit only.
  credentials_active_since timestamptz,
  context                  text        not null,
  checked_at               timestamptz not null default now(),
  constraint studio_sms_sender_stop_preflights_one_per_sender unique (sender_id),
  constraint studio_sms_sender_stop_preflights_phone_e164
    check (phone_number ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$'),
  constraint studio_sms_sender_stop_preflights_service_sid
    check (messaging_service_sid ~ '^MG[0-9a-fA-F]{32}$'),
  constraint studio_sms_sender_stop_preflights_checks_array
    check (jsonb_typeof(checks) = 'array'),
  constraint studio_sms_sender_stop_preflights_webhook_base
    check (webhook_base ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-])?$'),
  constraint studio_sms_sender_stop_preflights_epoch
    check (credentials_epoch is null or credentials_epoch ~ '^[A-Za-z0-9._-]{1,64}$'),
  constraint studio_sms_sender_stop_preflights_context
    check (context in ('evidence', 'cutover'))
);

create index studio_sms_sender_stop_preflights_studio
  on public.studio_sms_sender_stop_preflights (studio_id);

alter table public.studio_sms_sender_stop_preflights enable row level security;

-- ---------------------------------------------------------------------------
-- The only writer
-- ---------------------------------------------------------------------------
create or replace function public.record_studio_sms_stop_preflight(
  p_studio_id                uuid,
  p_expected_sender_id       uuid,
  p_expected_phone           text,
  p_messaging_service_sid    text,
  p_checks                   jsonb,
  p_webhook_base             text,
  p_credentials_epoch        text,
  p_credentials_active_since timestamptz,
  p_context                  text,
  p_expected_checked_at      timestamptz
) returns table (result text, preflight_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_sender  public.studio_sms_senders%rowtype;
  v_current timestamptz;
  v_ready   boolean;
  v_id      uuid;
begin
  if p_studio_id is null or p_expected_sender_id is null
     or p_expected_phone is null or p_expected_phone !~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$'
     or p_messaging_service_sid is null or p_messaging_service_sid !~ '^MG[0-9a-fA-F]{32}$'
     or p_checks is null or jsonb_typeof(p_checks) <> 'array'
     or p_webhook_base is null
     or p_webhook_base !~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-])?$'
     or (p_credentials_epoch is not null and p_credentials_epoch !~ '^[A-Za-z0-9._-]{1,64}$')
     or p_context is null or p_context not in ('evidence', 'cutover') then
    return query select 'invalid_input'::text, null::uuid;
    return;
  end if;

  -- Every check is exactly { id, status }: no detail text (it can carry a URL),
  -- a short identifier id, and one of the three statuses.
  if exists (
    select 1 from jsonb_array_elements(p_checks) c
     where jsonb_typeof(c) <> 'object'
        or (select count(*) from jsonb_object_keys(c)) <> 2
        or jsonb_typeof(c -> 'id') <> 'string'
        or (c ->> 'id') !~ '^[a-z][a-z0-9_]{0,63}$'
        or (c ->> 'status') is null
        or (c ->> 'status') not in ('pass', 'fail', 'unknown')
  ) then
    return query select 'invalid_input'::text, null::uuid;
    return;
  end if;
  -- Duplicate check ids are an answer the verdict could not trust.
  if (select count(distinct c ->> 'id') from jsonb_array_elements(p_checks) c)
     <> jsonb_array_length(p_checks) then
    return query select 'invalid_input'::text, null::uuid;
    return;
  end if;

  v_ready := jsonb_array_length(p_checks) > 0
             and not exists (
               select 1 from jsonb_array_elements(p_checks) c where (c ->> 'status') <> 'pass');

  -- The sender the caller saw, locked so the number cannot move under us.
  select s.* into v_sender
    from public.studio_sms_senders s
   where s.id = p_expected_sender_id
     and s.studio_id = p_studio_id
     and s.status <> 'released'
   for update;
  if not found then
    return query select 'no_live_sender'::text, null::uuid;
    return;
  end if;
  if v_sender.phone_number is distinct from p_expected_phone then
    return query select 'sender_changed'::text, null::uuid;
    return;
  end if;

  select p.checked_at into v_current
    from public.studio_sms_sender_stop_preflights p
   where p.sender_id = p_expected_sender_id;
  if v_current is distinct from p_expected_checked_at then
    return query select 'preflight_changed'::text, null::uuid;
    return;
  end if;

  insert into public.studio_sms_sender_stop_preflights as p
    (studio_id, sender_id, phone_number, messaging_service_sid, checks, ready,
     webhook_base, credentials_epoch, credentials_active_since, context, checked_at)
  values
    (p_studio_id, p_expected_sender_id, p_expected_phone, p_messaging_service_sid,
     p_checks, v_ready, p_webhook_base, p_credentials_epoch, p_credentials_active_since,
     p_context, now())
  on conflict (sender_id) do update
     set phone_number             = excluded.phone_number,
         messaging_service_sid    = excluded.messaging_service_sid,
         checks                   = excluded.checks,
         ready                    = excluded.ready,
         webhook_base             = excluded.webhook_base,
         credentials_epoch        = excluded.credentials_epoch,
         credentials_active_since = excluded.credentials_active_since,
         context                  = excluded.context,
         checked_at               = excluded.checked_at
  returning p.id into v_id;

  return query select 'recorded'::text, v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- The snapshot: 0229's body EXACTLY, plus `stop_preflights`. This replaces
-- 0229's function body; keep it a superset of 0229 (and of 0217).
-- ---------------------------------------------------------------------------
create or replace function public.get_live_studio_sms_sender_registration_state(
  p_studio_id uuid
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  with live as (
    select s.id, s.studio_id, s.status, s.phone_number, s.messaging_service_sid,
           s.provisioned_at, s.created_at
      from public.studio_sms_senders s
     where s.studio_id = p_studio_id
       and s.status <> 'released'
  )
  select jsonb_build_object(
    'senders', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'studio_id', l.studio_id, 'status', l.status,
               'phone_number', l.phone_number,
               'messaging_service_sid', l.messaging_service_sid,
               'provisioned_at', l.provisioned_at)
             order by l.created_at)
        from live l), '[]'::jsonb),
    'registrations', coalesce((
      select jsonb_agg(jsonb_build_object(
               'sender_id', r.sender_id, 'studio_id', r.studio_id,
               'phone_number', r.phone_number, 'kind', r.kind,
               'status', r.status, 'missing_information', r.missing_information,
               'provider_reference', r.provider_reference, 'updated_at', r.updated_at)
             order by r.sender_id, r.kind)
        from public.studio_sms_sender_registrations r
        join live l on l.id = r.sender_id and l.phone_number = r.phone_number
       where r.studio_id = p_studio_id), '[]'::jsonb),
    -- Every binding of a LISTED sender, whatever number it was checked for:
    -- the verdict, not this read, decides that a different number is a mismatch.
    'campaign_bindings', coalesce((
      select jsonb_agg(jsonb_build_object(
               'sender_id', b.sender_id, 'studio_id', b.studio_id,
               'phone_number', b.phone_number,
               'messaging_service_sid', b.messaging_service_sid,
               'campaign_sid', b.campaign_sid, 'campaign_status', b.campaign_status,
               'checked_at', b.checked_at, 'verified_at', b.verified_at)
             order by b.sender_id)
        from public.studio_sms_sender_campaign_bindings b
        join live l on l.id = b.sender_id
       where b.studio_id = p_studio_id), '[]'::jsonb),
    -- 0230 (HON-50 G6), the ONE added key: the recorded STOP preflight of each
    -- LISTED sender, whatever number it was checked for (the verdict decides).
    'stop_preflights', coalesce((
      select jsonb_agg(jsonb_build_object(
               'sender_id', p.sender_id, 'studio_id', p.studio_id,
               'phone_number', p.phone_number,
               'messaging_service_sid', p.messaging_service_sid,
               'ready', p.ready, 'checks', p.checks,
               'webhook_base', p.webhook_base,
               'credentials_epoch', p.credentials_epoch,
               'checked_at', p.checked_at)
             order by p.sender_id)
        from public.studio_sms_sender_stop_preflights p
        join live l on l.id = p.sender_id
       where p.studio_id = p_studio_id), '[]'::jsonb)
  );
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on table public.studio_sms_sender_stop_preflights from public;
revoke all on table public.studio_sms_sender_stop_preflights from anon;
revoke all on table public.studio_sms_sender_stop_preflights from authenticated;
revoke all on table public.studio_sms_sender_stop_preflights from service_role;

revoke execute on function public.record_studio_sms_stop_preflight(uuid, uuid, text, text, jsonb, text, text, timestamptz, text, timestamptz) from public;
revoke execute on function public.record_studio_sms_stop_preflight(uuid, uuid, text, text, jsonb, text, text, timestamptz, text, timestamptz) from anon;
revoke execute on function public.record_studio_sms_stop_preflight(uuid, uuid, text, text, jsonb, text, text, timestamptz, text, timestamptz) from authenticated;
revoke execute on function public.record_studio_sms_stop_preflight(uuid, uuid, text, text, jsonb, text, text, timestamptz, text, timestamptz) from service_role;
grant execute on function public.record_studio_sms_stop_preflight(uuid, uuid, text, text, jsonb, text, text, timestamptz, text, timestamptz) to service_role;

-- CREATE OR REPLACE keeps the earlier grants, but they are restated so this
-- migration alone determines who may call the snapshot.
revoke execute on function public.get_live_studio_sms_sender_registration_state(uuid) from public;
revoke execute on function public.get_live_studio_sms_sender_registration_state(uuid) from anon;
revoke execute on function public.get_live_studio_sms_sender_registration_state(uuid) from authenticated;
revoke execute on function public.get_live_studio_sms_sender_registration_state(uuid) from service_role;
grant execute on function public.get_live_studio_sms_sender_registration_state(uuid) to service_role;

comment on table public.studio_sms_sender_stop_preflights is
  'SMS-STOP-PREFLIGHT-RECORD-01 (0230, HON-50 G6): the recorded inbound STOP preflight of a sender, one current row per sender. Check ids and statuses only, no secrets; ready is derived. Written only by record_studio_sms_stop_preflight; read only through get_live_studio_sms_sender_registration_state.';
comment on function public.record_studio_sms_stop_preflight(uuid, uuid, text, text, jsonb, text, text, timestamptz, text, timestamptz) is
  'SMS-STOP-PREFLIGHT-RECORD-01 (0230): record the STOP preflight for the live sender the caller saw (refused if released, another studio''s, or no longer holding that number), compare-and-set on the checked_at the caller read first (preflight_changed otherwise). service_role only.';

commit;
