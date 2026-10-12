-- ===========================================================================
-- 0217 — SMS-SENDER-REG-01 (#824): US REGISTRATION EVIDENCE FOR A STUDIO SENDER
-- ===========================================================================
--
-- A studio's own number texting US recipients needs registration that is a
-- separate fact from the number existing or passing one test: 10DLC brand,
-- campaign and number association for a US local number, or toll-free
-- verification for a toll-free number. Hone has never recorded either, so
-- every studio's US readiness reads "Requires information" (SMS-SENDER-READY-01).
--
-- This migration gives that evidence a home, and nothing more:
--
--   1. public.studio_sms_sender_registrations -- the CURRENT registration
--      state of ONE kind for ONE studio sender: pending, requires_information
--      (with what is missing), approved, rejected or suspended. One row per
--      sender per kind.
--   2. record_studio_sms_sender_registration(studio, kind, status, missing,
--      reference) -- the ONLY writer, service_role only. It is called by the
--      platform operator's console after support has checked the provider
--      account; it resolves the studio's LIVE sender itself, so evidence can
--      never be attached to another studio's sender or to a released one.
--   3. The studio OWNER reads their own rows (status, kind, what is missing),
--      exactly as 0191 lets them read their sender. The provider reference
--      (a brand or campaign identifier) is not granted to them.
--
-- WHAT THIS IS NOT. It calls no provider, registers nothing, and changes no
-- send path: recording "approved" is evidence for the readiness view, not an
-- activation. Nothing is backfilled; with no row, readiness stays "Requires
-- information".
--
-- NUMBERING: 0217, reserved after a fresh census on 2026-10-12 (0211 #827,
-- 0212 #832, 0213 #831, 0214 PAY-CCY, 0215 DELIVERY-VISIBILITY-01, 0216
-- receptionist foundation). Applies after 0216.
-- ===========================================================================

begin;
set local lock_timeout = '5s';

create table public.studio_sms_sender_registrations (
  id                  uuid        primary key default gen_random_uuid(),
  studio_id           uuid        not null references public.studios (id) on delete cascade,
  sender_id           uuid        not null references public.studio_sms_senders (id) on delete cascade,
  kind                text        not null,
  status              text        not null,
  missing_information text,
  provider_reference  text,
  recorded_at         timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint studio_sms_sender_registrations_one_per_kind unique (sender_id, kind),
  constraint studio_sms_sender_registrations_kind_ck
    check (kind in ('us_10dlc', 'toll_free_verification')),
  constraint studio_sms_sender_registrations_status_ck
    check (status in ('pending', 'requires_information', 'approved', 'rejected', 'suspended')),
  -- What is missing is said exactly when, and only when, something is.
  constraint studio_sms_sender_registrations_missing_ck
    check ((status = 'requires_information') = (missing_information is not null)
           and (missing_information is null or length(btrim(missing_information)) between 1 and 300)),
  -- An opaque identifier, never free text.
  constraint studio_sms_sender_registrations_reference_ck
    check (provider_reference is null or provider_reference ~ '^[A-Za-z0-9_-]{1,64}$')
);

alter table public.studio_sms_sender_registrations enable row level security;

create policy "studio_sms_sender_registrations_owner_select"
  on public.studio_sms_sender_registrations for select to authenticated
  using (public.is_studio_owner(studio_sms_sender_registrations.studio_id));

-- ---------------------------------------------------------------------------
-- The only writer
-- ---------------------------------------------------------------------------
create or replace function public.record_studio_sms_sender_registration(
  p_studio_id          uuid,
  p_kind               text,
  p_status             text,
  p_missing            text,
  p_provider_reference text
) returns table (result text, registration_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_sender  uuid;
  v_count   integer;
  v_missing text := nullif(btrim(p_missing), '');
  v_id      uuid;
begin
  if p_studio_id is null
     or p_kind is null or p_kind not in ('us_10dlc', 'toll_free_verification')
     or p_status is null or p_status not in ('pending', 'requires_information', 'approved', 'rejected', 'suspended')
     or ((p_status = 'requires_information') <> (v_missing is not null))
     or (v_missing is not null and length(v_missing) > 300)
     or (p_provider_reference is not null and p_provider_reference !~ '^[A-Za-z0-9_-]{1,64}$') then
    return query select 'invalid_input'::text, null::uuid;
    return;
  end if;

  -- The studio's LIVE sender, resolved here: evidence is never attached to a
  -- sender the caller names, so it cannot land on another studio's number.
  select count(*), min(s.id::text)::uuid
    into v_count, v_sender
    from public.studio_sms_senders s
   where s.studio_id = p_studio_id
     and s.status <> 'released';
  if v_count = 0 then
    return query select 'no_live_sender'::text, null::uuid;
    return;
  end if;
  if v_count > 1 then
    -- 0191's one-live-sender index makes this impossible; refuse, never guess.
    return query select 'ambiguous_live_sender'::text, null::uuid;
    return;
  end if;

  insert into public.studio_sms_sender_registrations as r
    (studio_id, sender_id, kind, status, missing_information, provider_reference)
  values
    (p_studio_id, v_sender, p_kind, p_status, v_missing, p_provider_reference)
  on conflict (sender_id, kind) do update
    set status              = excluded.status,
        missing_information = excluded.missing_information,
        provider_reference  = coalesce(excluded.provider_reference, r.provider_reference),
        updated_at          = now()
  returning r.id into v_id;

  return query select 'recorded'::text, v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on table public.studio_sms_sender_registrations from public;
revoke all on table public.studio_sms_sender_registrations from anon;
revoke all on table public.studio_sms_sender_registrations from authenticated;
revoke all on table public.studio_sms_sender_registrations from service_role;
-- The owner's view: everything except the provider reference.
grant select (id, studio_id, sender_id, kind, status, missing_information, recorded_at, updated_at)
  on public.studio_sms_sender_registrations to authenticated;
-- The operator console reads through service_role; it writes only through the command.
grant select on table public.studio_sms_sender_registrations to service_role;

revoke execute on function public.record_studio_sms_sender_registration(uuid, text, text, text, text) from public;
revoke execute on function public.record_studio_sms_sender_registration(uuid, text, text, text, text) from anon;
revoke execute on function public.record_studio_sms_sender_registration(uuid, text, text, text, text) from authenticated;
revoke execute on function public.record_studio_sms_sender_registration(uuid, text, text, text, text) from service_role;
grant execute on function public.record_studio_sms_sender_registration(uuid, text, text, text, text) to service_role;

comment on table public.studio_sms_sender_registrations is
  'SMS-SENDER-REG-01 (0217): support-recorded US registration evidence (10DLC or toll-free verification) for a studio''s live sender. Evidence for readiness only: recording it calls no provider and activates nothing. Owner reads own rows (no provider_reference); written only by record_studio_sms_sender_registration.';
comment on function public.record_studio_sms_sender_registration(uuid, text, text, text, text) is
  'SMS-SENDER-REG-01 (0217): records the current registration state of one kind for the studio''s live sender (resolved here, never named by the caller). service_role only.';

commit;
