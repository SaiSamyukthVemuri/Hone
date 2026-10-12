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
--      state of ONE NUMBER held by ONE studio sender: pending,
--      requires_information (with what is missing), approved, rejected or
--      suspended. EVIDENCE IS PER (sender, number, kind): the number support
--      verified is stored on the row, and the kind is the one that number is
--      held to (toll-free verification for 8XX, A2P 10DLC for any other +1
--      long code), enforced by a check, never chosen.
--   2. record_studio_sms_sender_registration(studio, expected sender,
--      expected number, status, missing, reference) -- the ONLY writer,
--      service_role only, called by the operator console after support has
--      checked the provider account. COMPARE-AND-SET: it locks the studio's
--      live sender and writes only if that is still the sender AND the number
--      the operator was shown and verified (`sender_changed` otherwise). A
--      sender with no number yet is refused (`sender_has_no_number`): there
--      is nothing support could have verified. The KIND IS DERIVED from the
--      number here, so a toll-free number can never carry 10DLC evidence or
--      the reverse (Codex P2 4244484021, 4244484022).
--   3. get_live_studio_sms_sender_registration_state(studio) -- ONE snapshot,
--      service_role only: the studio's live sender(s) (id, number, status,
--      messaging service) and THEIR registrations, empty or not. The console
--      shows the number before any record exists; a send-time route reads
--      sender and evidence in one statement, never across a replacement. A
--      released sender's rows, and rows for a number the sender no longer
--      holds, stay as history and are never returned as current state.
--   4. The studio OWNER reads their own rows (status, kind, what is missing),
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
  -- The number support verified. Evidence never follows a sender row to a
  -- number assigned after it was recorded.
  phone_number        text        not null,
  kind                text        not null,
  status              text        not null,
  missing_information text,
  provider_reference  text,
  recorded_at         timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint studio_sms_sender_registrations_one_per_number_kind unique (sender_id, phone_number, kind),
  -- A +1 number only (the CA/US scope of #824).
  constraint studio_sms_sender_registrations_phone_ck
    check (phone_number ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$'),
  -- THE KIND IS THE NUMBER'S: 8XX toll-free (lib/sms/nanp.ts
  -- TOLL_FREE_AREA_CODES) is held to toll-free verification, every other +1
  -- long code to A2P 10DLC. No other pairing can be stored.
  constraint studio_sms_sender_registrations_kind_ck
    check (kind = case when phone_number ~ '^\+1(800|833|844|855|866|877|888)'
                       then 'toll_free_verification' else 'us_10dlc' end),
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
  p_expected_sender_id uuid,
  p_expected_phone     text,
  p_status             text,
  p_missing            text,
  p_provider_reference text
) returns table (result text, registration_id uuid, kind text)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '5s'
as $$
-- The output column `kind` shares its name with the table's: SQL names mean columns.
#variable_conflict use_column
declare
  v_live    uuid[];
  v_phones  text[];
  v_kind    text;
  v_missing text := nullif(btrim(p_missing), '');
  v_id      uuid;
begin
  if p_studio_id is null or p_expected_sender_id is null
     or p_expected_phone is null or p_expected_phone !~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$'
     or p_status is null or p_status not in ('pending', 'requires_information', 'approved', 'rejected', 'suspended')
     or ((p_status = 'requires_information') <> (v_missing is not null))
     or (v_missing is not null and length(v_missing) > 300)
     or (p_provider_reference is not null and p_provider_reference !~ '^[A-Za-z0-9_-]{1,64}$') then
    return query select 'invalid_input'::text, null::uuid, null::text;
    return;
  end if;

  -- The studio's LIVE sender, LOCKED until this transaction ends: a release
  -- or replacement waits for this write, or this write sees it and refuses.
  select array_agg(l.id), array_agg(l.phone_number)
    into v_live, v_phones
    from (select s.id, s.phone_number
            from public.studio_sms_senders s
           where s.studio_id = p_studio_id
             and s.status <> 'released'
             for share) l;
  if v_live is null then
    return query select 'no_live_sender'::text, null::uuid, null::text;
    return;
  end if;
  if cardinality(v_live) > 1 then
    -- 0191's one-live-sender index makes this impossible; refuse, never guess.
    return query select 'ambiguous_live_sender'::text, null::uuid, null::text;
    return;
  end if;
  -- COMPARE-AND-SET: only the sender the operator verified.
  if v_live[1] <> p_expected_sender_id then
    return query select 'sender_changed'::text, null::uuid, null::text;
    return;
  end if;
  -- No number yet (off, selecting, provisioning): nothing has been verified.
  if v_phones[1] is null then
    return query select 'sender_has_no_number'::text, null::uuid, null::text;
    return;
  end if;
  -- ... and only the NUMBER the operator verified, on that same sender.
  if v_phones[1] <> p_expected_phone then
    return query select 'sender_changed'::text, null::uuid, null::text;
    return;
  end if;

  -- The kind is the number's, never the caller's.
  v_kind := case when v_phones[1] ~ '^\+1(800|833|844|855|866|877|888)'
                 then 'toll_free_verification' else 'us_10dlc' end;

  insert into public.studio_sms_sender_registrations as r
    (studio_id, sender_id, phone_number, kind, status, missing_information, provider_reference)
  values
    (p_studio_id, v_live[1], v_phones[1], v_kind, p_status, v_missing, p_provider_reference)
  on conflict (sender_id, phone_number, kind) do update
    set status              = excluded.status,
        missing_information = excluded.missing_information,
        provider_reference  = coalesce(excluded.provider_reference, r.provider_reference),
        updated_at          = now()
  returning r.id into v_id;

  return query select 'recorded'::text, v_id, v_kind;
end;
$$;

-- ---------------------------------------------------------------------------
-- ONE snapshot: the live sender and its evidence
-- ---------------------------------------------------------------------------
-- service_role cannot read studio_sms_senders (0191 revokes it). This read
-- returns, in ONE statement and so one snapshot, the studio's non-released
-- sender(s) and exactly the registrations of the number each holds NOW, as
--   { "senders": [ {id, studio_id, status, phone_number, messaging_service_sid} ],
--     "registrations": [ {sender_id, studio_id, phone_number, kind, status,
--                         missing_information, provider_reference, updated_at} ] }
-- Empty arrays, never null. More than one sender is returned as it is, for the
-- caller to refuse.
create or replace function public.get_live_studio_sms_sender_registration_state(
  p_studio_id uuid
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  with live as (
    select s.id, s.studio_id, s.status, s.phone_number, s.messaging_service_sid, s.created_at
      from public.studio_sms_senders s
     where s.studio_id = p_studio_id
       and s.status <> 'released'
  )
  select jsonb_build_object(
    'senders', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'studio_id', l.studio_id, 'status', l.status,
               'phone_number', l.phone_number,
               'messaging_service_sid', l.messaging_service_sid)
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
       where r.studio_id = p_studio_id), '[]'::jsonb)
  );
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on table public.studio_sms_sender_registrations from public;
revoke all on table public.studio_sms_sender_registrations from anon;
revoke all on table public.studio_sms_sender_registrations from authenticated;
revoke all on table public.studio_sms_sender_registrations from service_role;
-- The owner's view: everything except the provider reference.
grant select (id, studio_id, sender_id, phone_number, kind, status, missing_information, recorded_at, updated_at)
  on public.studio_sms_sender_registrations to authenticated;
-- The operator console reads through service_role; it writes only through the command.
grant select on table public.studio_sms_sender_registrations to service_role;

revoke execute on function public.record_studio_sms_sender_registration(uuid, uuid, text, text, text, text) from public;
revoke execute on function public.record_studio_sms_sender_registration(uuid, uuid, text, text, text, text) from anon;
revoke execute on function public.record_studio_sms_sender_registration(uuid, uuid, text, text, text, text) from authenticated;
revoke execute on function public.record_studio_sms_sender_registration(uuid, uuid, text, text, text, text) from service_role;
grant execute on function public.record_studio_sms_sender_registration(uuid, uuid, text, text, text, text) to service_role;

revoke execute on function public.get_live_studio_sms_sender_registration_state(uuid) from public;
revoke execute on function public.get_live_studio_sms_sender_registration_state(uuid) from anon;
revoke execute on function public.get_live_studio_sms_sender_registration_state(uuid) from authenticated;
revoke execute on function public.get_live_studio_sms_sender_registration_state(uuid) from service_role;
grant execute on function public.get_live_studio_sms_sender_registration_state(uuid) to service_role;

comment on table public.studio_sms_sender_registrations is
  'SMS-SENDER-REG-01 (0217): support-recorded US registration evidence (10DLC or toll-free verification) for the number a studio''s sender holds; the kind is the number''s. Evidence for readiness only: recording it calls no provider and activates nothing. Owner reads own rows (no provider_reference); written only by record_studio_sms_sender_registration.';
comment on function public.get_live_studio_sms_sender_registration_state(uuid) is
  'SMS-SENDER-REG-01 (0217): one snapshot of the studio''s non-released sender(s), including the messaging service, and exactly the registrations of the number each holds now (a released or replaced number''s rows are history, never current state). service_role only.';
comment on function public.record_studio_sms_sender_registration(uuid, uuid, text, text, text, text) is
  'SMS-SENDER-REG-01 (0217): records the registration state of the studio''s live sender''s number, compare-and-set on the sender AND number the operator verified (sender_changed otherwise; sender_has_no_number before one is assigned), with the sender row locked; the kind is derived from the number. service_role only.';

commit;
