-- ===========================================================================
-- 0229: SMS-CAMPAIGN-BINDING-01 (HON-50 G4a): the RECORDED binding between a
-- studio sender's Messaging Service and an approved US A2P 10DLC campaign.
-- ===========================================================================
--
-- WHY. 0217 records support's registration evidence per sender and number.
-- Nothing recorded WHICH Messaging Service the approved campaign is linked to.
-- A number sitting in a service without the campaign reads as registered and
-- is filtered by US carriers. This table records what a provider check
-- OBSERVED (the service checked, its campaign, that campaign's status), when
-- evidence is recorded and again at cutover.
--
-- NO PROVIDER CALL AT SEND TIME. The send path reads this record inside the
-- same one-statement snapshot as the sender (get_live_studio_sms_sender_
-- registration_state, redefined here ADDITIVELY) and decides with a pure
-- function (lib/sms/campaign-binding.ts, campaignBindingVerdict).
--
-- WHAT THIS MIGRATION DOES
--   1. studio_sms_sender_campaign_bindings: ONE current row per sender.
--   2. record_studio_sms_campaign_binding(...): the only writer. It locks the
--      sender, refuses one that is released, another studio's, or no longer
--      holding the number the caller saw, validates the observation, and
--      upserts. verified_at is set only for a verified campaign.
--      COMPARE-AND-SET (Codex P1 4301502260): the provider check runs BEFORE
--      the write, so two overlapping checks could land out of order and a
--      delayed `verified` overwrite a newer `failed`. The caller passes the
--      checked_at it read before its provider call (null = it saw no row), and
--      the write is refused (`binding_changed`) if the row has moved since.
--      Only the database clock is compared, so app/database skew cannot matter.
--   3. get_live_studio_sms_sender_registration_state(uuid): the 0217 snapshot
--      plus `provisioned_at` per sender and a `campaign_bindings` array (the
--      bindings of the listed senders). Every 0217 key is unchanged.
--
-- PRIVILEGES. Table and functions are revoked from public, anon,
-- authenticated AND service_role by name; only EXECUTE on the two functions
-- is granted back to service_role (the 0217 precedent). Nothing reads the
-- table directly.
--
-- Records evidence only: it calls no provider, activates nothing, and
-- changes no sender row.
-- ===========================================================================

begin;
set local lock_timeout = '5s';

create table public.studio_sms_sender_campaign_bindings (
  id                    uuid        primary key default gen_random_uuid(),
  studio_id             uuid        not null references public.studios (id) on delete cascade,
  sender_id             uuid        not null references public.studio_sms_senders (id) on delete cascade,
  -- The number the sender held when the check ran, canonical E.164 (+1 NANP),
  -- the same shape 0217 stores.
  phone_number          text        not null,
  -- What the provider check OBSERVED. It may differ from the sender's service;
  -- the verdict then reads `mismatch`.
  messaging_service_sid text        not null,
  campaign_sid          text,
  campaign_status       text        not null,
  context               text        not null,
  checked_at            timestamptz not null default now(),
  verified_at           timestamptz,
  constraint studio_sms_sender_campaign_bindings_one_per_sender unique (sender_id),
  constraint studio_sms_sender_campaign_bindings_phone_e164
    check (phone_number ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$'),
  constraint studio_sms_sender_campaign_bindings_service_sid
    check (messaging_service_sid ~ '^MG[0-9a-fA-F]{32}$'),
  constraint studio_sms_sender_campaign_bindings_campaign_sid
    check (campaign_sid is null or campaign_sid ~ '^QE[0-9a-fA-F]{32}$'),
  constraint studio_sms_sender_campaign_bindings_status
    check (campaign_status in ('verified', 'pending', 'in_progress', 'failed', 'none')),
  -- A service with no campaign is `none`, and only `none` has no campaign.
  constraint studio_sms_sender_campaign_bindings_none_iff_no_campaign
    check ((campaign_status = 'none') = (campaign_sid is null)),
  -- verified_at exists exactly when the campaign was observed verified.
  constraint studio_sms_sender_campaign_bindings_verified_at
    check ((campaign_status = 'verified') = (verified_at is not null)),
  constraint studio_sms_sender_campaign_bindings_context
    check (context in ('evidence', 'cutover'))
);

create index studio_sms_sender_campaign_bindings_studio
  on public.studio_sms_sender_campaign_bindings (studio_id);

alter table public.studio_sms_sender_campaign_bindings enable row level security;

-- ---------------------------------------------------------------------------
-- The only writer
-- ---------------------------------------------------------------------------
create or replace function public.record_studio_sms_campaign_binding(
  p_studio_id             uuid,
  p_expected_sender_id    uuid,
  p_expected_phone        text,
  p_messaging_service_sid text,
  p_campaign_sid          text,
  p_campaign_status       text,
  p_context               text,
  p_expected_checked_at   timestamptz
) returns table (result text, binding_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_sender  public.studio_sms_senders%rowtype;
  v_current timestamptz;
  v_id      uuid;
begin
  if p_studio_id is null or p_expected_sender_id is null
     or p_expected_phone is null or p_expected_phone !~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$'
     or p_messaging_service_sid is null or p_messaging_service_sid !~ '^MG[0-9a-fA-F]{32}$'
     or p_campaign_status is null
     or p_campaign_status not in ('verified', 'pending', 'in_progress', 'failed', 'none')
     or (p_campaign_status = 'none') <> (p_campaign_sid is null)
     or (p_campaign_sid is not null and p_campaign_sid !~ '^QE[0-9a-fA-F]{32}$')
     or p_context is null or p_context not in ('evidence', 'cutover') then
    return query select 'invalid_input'::text, null::uuid;
    return;
  end if;

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

  -- The sender row lock above serialises every writer for this sender, so
  -- this read and the upsert below see the same current row.
  select b.checked_at into v_current
    from public.studio_sms_sender_campaign_bindings b
   where b.sender_id = p_expected_sender_id;
  if v_current is distinct from p_expected_checked_at then
    return query select 'binding_changed'::text, null::uuid;
    return;
  end if;

  insert into public.studio_sms_sender_campaign_bindings as b
    (studio_id, sender_id, phone_number, messaging_service_sid, campaign_sid,
     campaign_status, context, checked_at, verified_at)
  values
    (p_studio_id, p_expected_sender_id, p_expected_phone, p_messaging_service_sid,
     p_campaign_sid, p_campaign_status, p_context, now(),
     case when p_campaign_status = 'verified' then now() end)
  on conflict (sender_id) do update
     set phone_number          = excluded.phone_number,
         messaging_service_sid = excluded.messaging_service_sid,
         campaign_sid          = excluded.campaign_sid,
         campaign_status       = excluded.campaign_status,
         context               = excluded.context,
         checked_at            = excluded.checked_at,
         verified_at           = excluded.verified_at
  returning b.id into v_id;

  return query select 'recorded'::text, v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- The 0217 snapshot, ADDITIVELY: provisioned_at per sender, campaign_bindings.
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
       where b.studio_id = p_studio_id), '[]'::jsonb)
  );
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on table public.studio_sms_sender_campaign_bindings from public;
revoke all on table public.studio_sms_sender_campaign_bindings from anon;
revoke all on table public.studio_sms_sender_campaign_bindings from authenticated;
revoke all on table public.studio_sms_sender_campaign_bindings from service_role;

revoke execute on function public.record_studio_sms_campaign_binding(uuid, uuid, text, text, text, text, text, timestamptz) from public;
revoke execute on function public.record_studio_sms_campaign_binding(uuid, uuid, text, text, text, text, text, timestamptz) from anon;
revoke execute on function public.record_studio_sms_campaign_binding(uuid, uuid, text, text, text, text, text, timestamptz) from authenticated;
revoke execute on function public.record_studio_sms_campaign_binding(uuid, uuid, text, text, text, text, text, timestamptz) from service_role;
grant execute on function public.record_studio_sms_campaign_binding(uuid, uuid, text, text, text, text, text, timestamptz) to service_role;

-- CREATE OR REPLACE keeps the 0217 grants, but they are restated so this
-- migration alone determines who may call the snapshot.
revoke execute on function public.get_live_studio_sms_sender_registration_state(uuid) from public;
revoke execute on function public.get_live_studio_sms_sender_registration_state(uuid) from anon;
revoke execute on function public.get_live_studio_sms_sender_registration_state(uuid) from authenticated;
revoke execute on function public.get_live_studio_sms_sender_registration_state(uuid) from service_role;
grant execute on function public.get_live_studio_sms_sender_registration_state(uuid) to service_role;

comment on table public.studio_sms_sender_campaign_bindings is
  'SMS-CAMPAIGN-BINDING-01 (0229, HON-50 G4a): what a provider check observed about a sender''s Messaging Service and its US A2P campaign, one current row per sender. Evidence only; written only by record_studio_sms_campaign_binding; read only through get_live_studio_sms_sender_registration_state.';
comment on function public.record_studio_sms_campaign_binding(uuid, uuid, text, text, text, text, text, timestamptz) is
  'SMS-CAMPAIGN-BINDING-01 (0229): record a campaign-binding observation for the live sender the caller saw (refused if released, another studio''s, or no longer holding that number), compare-and-set on the checked_at the caller read before its provider check (binding_changed otherwise). service_role only.';

commit;
