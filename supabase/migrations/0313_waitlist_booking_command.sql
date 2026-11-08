-- 0313 — waitlist booking command (HON-7). DRAFT: not applied, not reviewed.
--
-- WHAT THIS FIXES. An invitation used to be REDEEMED in its own transaction
-- (0192 redeem_new_client_waitlist_invitation_verified) and the appointment
-- booked in a SECOND one (0195 / 0228). A slot lost between the two left the
-- invitation spent, the entry still `invited`, no appointment, and no way back
-- (release answers `already_redeemed`). The reproduction is
-- tests/db/waitlist-conflict-recovery.db.test.ts.
--
-- WHAT THIS DOES. One command redeems AND books inside ONE exception block:
--
--   redeem_and_book_waitlist_invitation(token, capability, booking args)
--
-- Any refusal raises a private SQLSTATE (WA313), which rolls back the redeem and
-- everything the inner booking wrote. The command then RETURNS the refusal, and
-- the invitation is exactly as live as before the attempt. Success returns the
-- inner command's own row (`created_and_converted`), so 0195's atomic
-- book + audit + conversion is unchanged.
--
-- THE REFUSAL TEST IS "NO APPOINTMENT" (appointment_id is null), the same
-- delegate-agnostic test 0228 settled on after enumerating success strings
-- broke an invited booking once. 0192, 0195 and 0228 are NOT edited.
--
-- ALSO IN THIS FILE
--   * waitlist_invitation_followups: one durable row per invitation that needs the
--     owner (idempotent: unique on invitation_id), written only through a
--     command, read by no list query beyond its reason.
--   * waitlist_invitation_booking_state(token): the EXISTING-APPOINTMENT CHECK a
--     caller runs before it believes an uncertain booking failed.
--   * record_/resolve_waitlist_invitation_followup: write and clear the item.
--
-- LOCK ORDER (documented against every writer that can touch the same rows).
--   this command    studios FOR NO KEY UPDATE -> admission round FOR UPDATE ->
--                   entry FOR UPDATE -> (redeem) round, invitation FOR UPDATE ->
--                   (0195) client FOR SHARE -> the booking chain's own studios lock,
--                   which is FOR NO KEY UPDATE (0204:403) and so already held in a
--                   compatible mode by this command's first statement.
--   0193 admit      studios FOR NO KEY UPDATE (:1612) -> round FOR UPDATE
--                   (:1645-1648) -> entry FOR UPDATE (:1655). SAME ORDER.
--   0192 redeem     round FOR UPDATE (:1114) -> invitation FOR UPDATE (:1122), no
--                   studio and no entry. A prefix of this order: it holds nothing
--                   this command waits for after it asks for the round.
--   0195 booking    studios FOR NO KEY UPDATE (:356) -> entry (:367) -> client
--                   FOR SHARE (:384). This command reaches the same sequence after
--                   its own round lock, which 0195 does not take.
--   0192 conversion entry FOR UPDATE (:1810) -> invitation (:1849).
--   0192 release    entry FOR UPDATE (:1708), invitation (:1728).
--   0200 close/requeue  entry FOR UPDATE (:393, :465) after the owner check.
--   record_waitlist_invitation_followup  entry FOR UPDATE only, so it cannot read an
--                   entry's status while a conversion is in flight (the conversion
--                   holds the entry); it takes nothing else.
-- STUDIOS FOR NO KEY UPDATE conflicts with itself, so every writer above that
-- takes it first (this command, admit, 0195) is SERIALISED at the studio before
-- it can interleave on round or entry. The writers that do not take it (redeem,
-- conversion, release, close) never hold an entry and then ask for a round, so
-- no cycle exists. tests/db/waitlist-booking-command.db.test.ts exercises the
-- redeem/close/release interleavings with waitUntilBlocked.
--
-- THE FOLLOW-UPS TABLE IS EVIDENCE ONLY. The owner's real surface is the list
-- DERIVED from entry and invitation state (an `invited` entry whose invitation
-- was redeemed), which clears by itself when the entry converts or is closed. A
-- follow-up row is therefore read as RESOLVED whenever its entry is no longer
-- `invited`, whatever resolved_at says; resolved_at is a courtesy stamp written
-- by the owner's close action. The redeem is spent once, so no later booking can
-- succeed for the same invitation: a closed or converted entry is how a row ends.
--
-- NOT IN THIS FILE: "These times don't work" storage, capacity, notifications.

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. The durable owner item.
-- ---------------------------------------------------------------------------
create table if not exists public.waitlist_invitation_followups (
  id            uuid primary key default gen_random_uuid(),
  studio_id     uuid not null references public.studios(id) on delete cascade,
  entry_id      uuid not null,
  invitation_id uuid not null,
  reason        text not null
    constraint waitlist_invitation_followups_reason_check
    check (reason in ('booking_outcome_unknown', 'booking_not_completed')),
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz,
  constraint waitlist_invitation_followups_invitation_key unique (invitation_id),
  constraint waitlist_invitation_followups_entry_same_studio_fk
    foreign key (entry_id, studio_id)
    references public.new_client_waitlist_entries (id, studio_id) on delete cascade
);

create index if not exists waitlist_invitation_followups_open_idx
  on public.waitlist_invitation_followups (studio_id, created_at)
  where resolved_at is null;

alter table public.waitlist_invitation_followups enable row level security;
-- No policy and no grant: the table is reached only through the commands below.
revoke all on public.waitlist_invitation_followups from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The booking command.
-- ---------------------------------------------------------------------------
create or replace function public.redeem_and_book_waitlist_invitation(
  p_raw_token               text,
  p_raw_capability          text,
  p_studio_id               uuid,
  p_client_id               uuid,
  p_client_name             text,
  p_client_email            text,
  p_client_phone            text,
  p_sms_consent_at          timestamptz,
  p_service_id              uuid,
  p_starts_at               timestamptz,
  p_cancellation_token_hash text,
  p_legacy_bridge_waitlist  boolean,
  p_notes                   text default null,
  p_referral_source         text default null
)
returns table (
  result           text,
  appointment_id   uuid,
  starts_at        timestamptz,
  ends_at          timestamptz,
  duration_minutes integer,
  practitioner_id  uuid,
  created_at       timestamptz,
  client_id        uuid,
  client_name            text,
  client_phone           text,
  client_sms_consent_at  timestamptz,
  client_sms_opted_out_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_hash   text;
  v_studio uuid;
  v_entry  uuid;
  v_round  uuid;
  v_red    record;
  v_row    record;
begin
  if p_raw_token is null or p_raw_token !~ '^[a-f0-9]{64}$'
     or p_raw_capability is null or p_raw_capability !~ '^[a-f0-9]{64}$'
     or p_studio_id is null then
    return query select 'invalid_input'::text, null::uuid, null::timestamptz,
      null::timestamptz, null::integer, null::uuid, null::timestamptz,
      null::uuid, null::text, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  v_hash := encode(extensions.digest(p_raw_token, 'sha256'), 'hex');

  -- DISCOVERY ONLY. Used to learn WHICH rows to lock; every fact is re-read under
  -- the locks (by redeem and by the inner commands).
  select i.studio_id, i.entry_id, i.admission_round_id
    into v_studio, v_entry, v_round
    from public.new_client_waitlist_invitations i
   where i.token_hash = v_hash;

  if v_studio is null or v_studio is distinct from p_studio_id then
    return query select 'invalid_token'::text, null::uuid, null::timestamptz,
      null::timestamptz, null::integer, null::uuid, null::timestamptz,
      null::uuid, null::text, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  perform 1 from public.studios where id = p_studio_id for no key update;
  if v_round is not null then
    perform 1 from public.studio_waitlist_admission_rounds ar
     where ar.id = v_round for update;
  end if;
  perform 1 from public.new_client_waitlist_entries e
   where e.id = v_entry and e.studio_id = p_studio_id for update;

  begin
    select * into v_red
      from public.redeem_new_client_waitlist_invitation_verified(p_raw_token, p_raw_capability);

    if v_red.result is distinct from 'redeemed' then
      raise exception 'refused:redeem_%', coalesce(v_red.result, 'unavailable') using errcode = 'WA313';
    end if;
    if v_red.entry_id is distinct from v_entry then
      raise exception 'refused:redeem_entry_mismatch' using errcode = 'WA313';
    end if;

    select * into v_row
      from public.create_public_appointment_for_new_client(
        p_studio_id, p_client_id, p_client_name, p_client_email, p_client_phone,
        p_sms_consent_at, p_service_id, p_starts_at, p_cancellation_token_hash,
        p_legacy_bridge_waitlist, p_notes, p_referral_source, v_entry);

    if v_row.appointment_id is null then
      raise exception 'refused:%', coalesce(v_row.result, 'no_result') using errcode = 'WA313';
    end if;
  exception
    when sqlstate 'WA313' then
      -- The redeem and anything the inner command wrote are rolled back. The
      -- invitation is as live as it was before this call.
      return query select substr(sqlerrm, pg_catalog.strpos(sqlerrm, ':') + 1)::text,
        null::uuid, null::timestamptz, null::timestamptz, null::integer,
        null::uuid, null::timestamptz, null::uuid, null::text, null::text,
        null::timestamptz, null::timestamptz;
      return;
  end;

  return query select v_row.result, v_row.appointment_id, v_row.starts_at,
    v_row.ends_at, v_row.duration_minutes, v_row.practitioner_id, v_row.created_at,
    v_row.client_id, v_row.client_name, v_row.client_phone,
    v_row.client_sms_consent_at, v_row.client_sms_opted_out_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The existing-appointment check.
-- ---------------------------------------------------------------------------
create or replace function public.waitlist_invitation_booking_state(p_raw_token text)
returns table (state text, starts_at timestamptz)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_inv    record;
  v_entry  record;
  v_start  timestamptz;
  v_n      integer;
begin
  if p_raw_token is null or p_raw_token !~ '^[a-f0-9]{64}$' then
    return query select 'invalid_token'::text, null::timestamptz; return;
  end if;
  select i.entry_id, i.studio_id, i.redeemed_at, i.expired_at, i.released_at, i.declined_at, i.expires_at
    into v_inv
    from public.new_client_waitlist_invitations i
   where i.token_hash = encode(extensions.digest(p_raw_token, 'sha256'), 'hex');
  if v_inv.entry_id is null then
    return query select 'invalid_token'::text, null::timestamptz; return;
  end if;
  select e.status, e.converted_client_id, e.converted_at into v_entry
    from public.new_client_waitlist_entries e
   where e.id = v_inv.entry_id and e.studio_id = v_inv.studio_id;
  if v_entry.status = 'converted' then
    -- THE TIME OF THE APPOINTMENT THIS CONVERSION CREATED, or NULL.
    --
    -- 0195 commits the appointment and the conversion in ONE transaction but
    -- stores no appointment id on the entry, so the link is by time and client.
    -- The appointment's created_at is the transaction START (now()) and the
    -- conversion is stamped later in the same transaction (clock_timestamp()),
    -- so the appointment lies a few milliseconds BEFORE converted_at. The
    -- window is therefore [converted_at - 60 seconds, converted_at + 1 second],
    -- cancelled bookings excluded.
    --
    -- EXACTLY ONE CANDIDATE, otherwise NULL. A later appointment for the same
    -- client is outside the window; a cancelled booking is excluded; two
    -- candidates are ambiguous. In each of those cases the caller gets NULL and
    -- shows the "couldn't confirm" copy rather than a time that might be wrong.
    select count(*)::int, min(a.starts_at) into v_n, v_start
      from public.appointments a
     where a.studio_id = v_inv.studio_id
       and a.client_id = v_entry.converted_client_id
       and a.status is distinct from 'cancelled'
       and a.created_at >= v_entry.converted_at - interval '60 seconds'
       and a.created_at <= v_entry.converted_at + interval '1 second';
    if v_n is distinct from 1 then v_start := null; end if;
    return query select 'booked'::text, v_start; return;
  end if;
  if v_inv.redeemed_at is not null then
    return query select 'redeemed_unbooked'::text, null::timestamptz; return;
  end if;
  if v_inv.expired_at is not null or v_inv.released_at is not null
     or v_inv.declined_at is not null or v_inv.expires_at <= clock_timestamp() then
    return query select 'closed'::text, null::timestamptz; return;
  end if;
  return query select 'live'::text, null::timestamptz;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Write and clear the durable item.
-- ---------------------------------------------------------------------------
create or replace function public.record_waitlist_invitation_followup(
  p_raw_token text,
  p_reason    text
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_inv record;
  v_status text;
  v_n int;
begin
  if p_raw_token is null or p_raw_token !~ '^[a-f0-9]{64}$'
     or p_reason not in ('booking_outcome_unknown', 'booking_not_completed') then
    return 'invalid_input';
  end if;
  select i.id, i.entry_id, i.studio_id, i.redeemed_at into v_inv
    from public.new_client_waitlist_invitations i
   where i.token_hash = encode(extensions.digest(p_raw_token, 'sha256'), 'hex');
  if v_inv.id is null or v_inv.redeemed_at is null then return 'not_redeemed'; end if;
  -- LOCKED, so a conversion in flight is waited for and the status read here is
  -- the committed one: an item cannot be written for an entry that converts a
  -- moment later.
  select e.status into v_status
    from public.new_client_waitlist_entries e
   where e.id = v_inv.entry_id and e.studio_id = v_inv.studio_id
     for update;
  if v_status is distinct from 'invited' then return 'not_invited'; end if;
  insert into public.waitlist_invitation_followups (studio_id, entry_id, invitation_id, reason)
  values (v_inv.studio_id, v_inv.entry_id, v_inv.id, p_reason)
  on conflict (invitation_id) do nothing;
  get diagnostics v_n = row_count;
  return case when v_n = 1 then 'recorded' else 'already_recorded' end;
end;
$$;

create or replace function public.resolve_waitlist_invitation_followup(
  p_studio_id     uuid,
  p_entry_id      uuid,
  p_actor_user_id uuid
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid;
  v_code  text;
  v_n     int;
begin
  select r.practitioner_id, r.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) r;
  if v_code <> 'ok' then return v_code; end if;
  if p_entry_id is null then return 'invalid_input'; end if;
  update public.waitlist_invitation_followups f
     set resolved_at = now()
   where f.studio_id = p_studio_id and f.entry_id = p_entry_id and f.resolved_at is null;
  get diagnostics v_n = row_count;
  return case when v_n > 0 then 'resolved' else 'not_found' end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Grants, restated BY NAME for all three default grantees.
-- ---------------------------------------------------------------------------
revoke all on function public.redeem_and_book_waitlist_invitation(text, text, uuid, uuid, text, text, text, timestamptz, uuid, timestamptz, text, boolean, text, text) from public, anon, authenticated, service_role;
revoke all on function public.waitlist_invitation_booking_state(text) from public, anon, authenticated, service_role;
revoke all on function public.record_waitlist_invitation_followup(text, text) from public, anon, authenticated, service_role;
revoke all on function public.resolve_waitlist_invitation_followup(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.redeem_and_book_waitlist_invitation(text, text, uuid, uuid, text, text, text, timestamptz, uuid, timestamptz, text, boolean, text, text) to service_role;
grant execute on function public.waitlist_invitation_booking_state(text) to service_role;
grant execute on function public.record_waitlist_invitation_followup(text, text) to service_role;
grant execute on function public.resolve_waitlist_invitation_followup(uuid, uuid, uuid) to service_role;

commit;
