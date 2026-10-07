-- ===========================================================================
-- 0206 — SMS DELIVERY FOUNDATION (SMS-00)
-- ===========================================================================
--
-- The shared server-side ground under two P0 features: SMS-01 (a waitlist
-- invitation also goes out by text) and SMS-02 (appointment reminder texts).
-- Three things, all additive:
--
--   1. public.sms_outbound_messages — ONE ROW PER OUTBOUND SMS ATTEMPT. It is
--      claimed BEFORE the provider is called, settled with what the provider
--      answered, and advanced by Twilio's delivery-status callbacks. It holds
--      no message body and no phone number: purpose, subject, status, the
--      provider message SID and a numeric provider error code, nothing else.
--
--   2. Four service_role-only commands, the table's ONLY writers:
--        begin_appointment_sms_message   claim a row for one appointment send
--        claim_waitlist_invitation_sms   the once-per-invitation claim
--        settle_sms_message              record what the provider answered
--        record_sms_delivery_status      apply a delivery-status callback
--
--   3. public.studios.send_waitlist_invitation_sms (default false), the
--      studio-level switch for SMS-01, beside the 0049 send_*_sms switches.
--
-- WHAT THIS IS NOT. No provider effect, no customer send, no trigger on any
-- existing table, no change to claim_sms_send / record_sms_result (0049) or
-- the email claim pair (0080), to any waitlist lifecycle command, or to any
-- existing grant. Nothing is backfilled. Until SMS-01 and SMS-02 call these
-- commands the table stays empty and the switch stays off.
--
-- DELIBERATELY NOT HERE: sending a fresh reminder after a practitioner moves
-- an appointment whose reminder already went out. Doing that safely needs the
-- claim/record pairs to be bound to the start they remind about (a reminder
-- generation), which changes the email path too. It is the specified
-- follow-up SMS-03 (docs/13_BACKLOG_AND_DECISIONS.md, "SMS-03").
--
-- WHY THE CLAIM PRECEDES THE PROVIDER CALL. Twilio's Messages API has no
-- idempotency key, so an ambiguous answer (a timeout, a dropped connection)
-- can still have sent the message. A row that exists before the call is what
-- lets a delivery-status callback land on the attempt even when it races the
-- settle, and what lets a later callback resolve an `unknown` settle into the
-- truth. The callback is addressed to the row by id (carried in the signed
-- StatusCallback URL), so it never depends on the SID having been written.
-- ===========================================================================

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. The studio switch for waitlist-invitation SMS
-- ---------------------------------------------------------------------------

alter table public.studios
  add column if not exists send_waitlist_invitation_sms boolean not null default false;

-- No `comment on column` here: the commented-column inventory of
-- public.studios is an approved set (tests/db/new-studio-admission-default),
-- and this switch is documented in docs/08 and the header above instead.
-- It authorises nothing on its own: claim_waitlist_invitation_sms checks it,
-- the prospect must still pass prospectMayReceiveSms, and the deployment must
-- be allowed to send.

-- ---------------------------------------------------------------------------
-- 2. The ledger
-- ---------------------------------------------------------------------------

create table if not exists public.sms_outbound_messages (
  id                     uuid primary key default gen_random_uuid(),
  studio_id              uuid not null references public.studios(id) on delete cascade,
  purpose                text not null,
  appointment_id         uuid,
  waitlist_invitation_id uuid references public.new_client_waitlist_invitations(id) on delete cascade,
  status                 text not null default 'claimed',
  skip_reason            text,
  provider_message_sid   text,
  provider_error_code    integer,
  claimed_at             timestamptz not null default now(),
  settled_at             timestamptz,
  provider_status_at     timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  -- Tenancy by construction: an appointment row can only be referenced
  -- together with the studio that owns it.
  constraint sms_outbound_messages_appointment_same_studio_fk
    foreign key (appointment_id, studio_id)
    references public.appointments (id, studio_id) on delete cascade,

  constraint sms_outbound_messages_purpose_ck check (purpose in (
    'appointment_confirmation',
    'appointment_reminder_24h',
    'appointment_reminder_2h',
    'waitlist_invitation'
  )),

  -- Exactly one subject, and the one the purpose names.
  constraint sms_outbound_messages_subject_ck check (
    case
      when purpose = 'waitlist_invitation'
        then waitlist_invitation_id is not null and appointment_id is null
      else appointment_id is not null and waitlist_invitation_id is null
    end
  ),

  constraint sms_outbound_messages_status_ck check (status in (
    -- Hone's own lifecycle.
    'claimed', 'skipped', 'refused', 'unknown', 'accepted',
    -- Twilio's delivery lifecycle, as normalised by lib/sms/delivery-ledger.ts.
    'queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed'
  )),

  -- A skip carries a reason and nothing else does. The reason is a slug from a
  -- closed application vocabulary; the shape check makes it structurally
  -- impossible to park a phone number or provider message here.
  constraint sms_outbound_messages_skip_reason_ck check (
    (status = 'skipped') = (skip_reason is not null)
    and (skip_reason is null or skip_reason ~ '^[a-z][a-z0-9_]{2,63}$')
  ),

  constraint sms_outbound_messages_sid_shape_ck check (
    provider_message_sid is null or provider_message_sid ~ '^(SM|MM)[0-9a-fA-F]{32}$'
  ),

  -- Every state that means "the provider has this message" names it.
  constraint sms_outbound_messages_sid_when_reached_ck check (
    status not in ('accepted', 'queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed')
    or provider_message_sid is not null
  ),

  constraint sms_outbound_messages_error_code_ck check (
    provider_error_code is null or provider_error_code between 1 and 99999999
  )
);

create unique index if not exists sms_outbound_messages_provider_sid_unique
  on public.sms_outbound_messages (provider_message_sid)
  where provider_message_sid is not null;

-- THE ONCE-PER-INVITATION RULE. A waitlist invitation's raw link token exists
-- only in the memory of the request that minted it, so there is no later
-- resend; this index is what makes "at most one text per invitation" a
-- database fact rather than a property of one code path.
create unique index if not exists sms_outbound_messages_one_per_invitation
  on public.sms_outbound_messages (waitlist_invitation_id)
  where waitlist_invitation_id is not null;

create index if not exists sms_outbound_messages_appointment_idx
  on public.sms_outbound_messages (appointment_id)
  where appointment_id is not null;

create index if not exists sms_outbound_messages_studio_created_idx
  on public.sms_outbound_messages (studio_id, created_at);

-- ---------------------------------------------------------------------------
-- Server-assigned timestamps and write-once identity
-- ---------------------------------------------------------------------------

create or replace function public.sms_outbound_messages_server_timestamps()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  new.claimed_at := now();
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists sms_outbound_messages_server_timestamps
  on public.sms_outbound_messages;
create trigger sms_outbound_messages_server_timestamps
  before insert on public.sms_outbound_messages
  for each row execute function public.sms_outbound_messages_server_timestamps();

create or replace function public.sms_outbound_messages_identity_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  -- What an attempt IS never changes: its studio, purpose, subject and claim
  -- instant. And a provider SID, once written, is the attempt's identity on
  -- the provider's side; overwriting it would point later callbacks at a
  -- different message.
  if new.studio_id is distinct from old.studio_id
     or new.purpose is distinct from old.purpose
     or new.appointment_id is distinct from old.appointment_id
     or new.waitlist_invitation_id is distinct from old.waitlist_invitation_id
     or new.claimed_at is distinct from old.claimed_at
     or new.created_at is distinct from old.created_at
     or (old.provider_message_sid is not null
         and new.provider_message_sid is distinct from old.provider_message_sid)
  then
    raise exception 'sms_outbound_messages identity is write-once'
      using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists sms_outbound_messages_identity_guard
  on public.sms_outbound_messages;
create trigger sms_outbound_messages_identity_guard
  before update on public.sms_outbound_messages
  for each row execute function public.sms_outbound_messages_identity_guard();

alter table public.sms_outbound_messages enable row level security;

-- No policies: no browser session reads or writes this table. The four
-- commands below are its only writers.

-- ---------------------------------------------------------------------------
-- 3. begin_appointment_sms_message — one row per appointment send attempt
-- ---------------------------------------------------------------------------
--
-- NOT the appointment SMS claim. claim_sms_send (0049) still decides whether
-- an attempt may happen at all, and still owns the attempt counter. This row
-- is created only after that claim succeeds, so a delivery-status callback
-- has an attempt to land on. One appointment can therefore own several rows:
-- one per real attempt.

create or replace function public.begin_appointment_sms_message(
  p_studio_id      uuid,
  p_appointment_id uuid,
  p_purpose        text
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_studio_id is null or p_appointment_id is null
     or p_purpose is null
     or p_purpose not in ('appointment_confirmation',
                          'appointment_reminder_24h',
                          'appointment_reminder_2h') then
    return null;
  end if;

  -- The appointment must belong to the studio named. The composite FK would
  -- refuse the insert anyway; checking first answers with null rather than an
  -- exception, so a caller's send is never broken by bookkeeping.
  if not exists (
    select 1 from public.appointments a
     where a.id = p_appointment_id and a.studio_id = p_studio_id
  ) then
    return null;
  end if;

  insert into public.sms_outbound_messages (studio_id, purpose, appointment_id)
  values (p_studio_id, p_purpose, p_appointment_id)
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. claim_waitlist_invitation_sms — at most one text per invitation
-- ---------------------------------------------------------------------------
--
-- The database owns WHO and WHETHER-AT-ALL: the invitation must belong to the
-- studio and still be live, and the studio must have switched waitlist SMS
-- on. Consent, mobile verification and opt-out are returned rather than
-- decided here: lib/waitlist/prospect-sms-consent.ts (prospectMayReceiveSms)
-- is the one authority on whether a prospect may be texted, and a second
-- predicate in SQL would be a second authority. A claim the application then
-- declines is settled as `skipped` with its reason, so the decision is still
-- recorded.
--
-- Results: claimed | already_claimed | not_found | not_live |
-- studio_disabled | invalid_input. Only `claimed` writes a row.

create or replace function public.claim_waitlist_invitation_sms(
  p_studio_id     uuid,
  p_invitation_id uuid
) returns table (
  result             text,
  message_id         uuid,
  phone              text,
  sms_consent_at     timestamptz,
  sms_opted_out_at   timestamptz,
  mobile_verified_at timestamptz,
  expires_at         timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_inv     record;
  v_entry   record;
  v_enabled boolean;
  v_id      uuid;
begin
  if p_studio_id is null or p_invitation_id is null then
    return query select 'invalid_input'::text, null::uuid, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- FOR SHARE, held to commit: a lifecycle command (redeem, decline,
  -- release, expire, close) that is mid-flight is waited for and then seen,
  -- and one that arrives later waits for this claim. "claimed" therefore
  -- always means the invitation was live when the claim committed.
  select i.id, i.entry_id, i.expires_at, i.redeemed_at, i.expired_at,
         i.released_at, i.declined_at, i.closed_at
    into v_inv
    from public.new_client_waitlist_invitations i
   where i.id = p_invitation_id
     and i.studio_id = p_studio_id
     for share;

  if not found then
    return query select 'not_found'::text, null::uuid, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- The 0192 liveness predicate, plus 0201's closed_at, plus the clock: an
  -- invitation that has lapsed but not yet been swept is not live either.
  if v_inv.redeemed_at is not null or v_inv.expired_at is not null
     or v_inv.released_at is not null or v_inv.declined_at is not null
     or v_inv.closed_at is not null
     or v_inv.expires_at <= clock_timestamp() then
    return query select 'not_live'::text, null::uuid, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  select s.send_waitlist_invitation_sms into v_enabled
    from public.studios s
   where s.id = p_studio_id;

  if v_enabled is distinct from true then
    return query select 'studio_disabled'::text, null::uuid, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  select e.phone, e.sms_consent_at, e.sms_opted_out_at, e.mobile_verified_at
    into v_entry
    from public.new_client_waitlist_entries e
   where e.id = v_inv.entry_id
     and e.studio_id = p_studio_id;

  if not found then
    return query select 'not_found'::text, null::uuid, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  insert into public.sms_outbound_messages (studio_id, purpose, waitlist_invitation_id)
  values (p_studio_id, 'waitlist_invitation', p_invitation_id)
  on conflict (waitlist_invitation_id) where waitlist_invitation_id is not null
  do nothing
  returning id into v_id;

  if v_id is null then
    return query select 'already_claimed'::text, null::uuid, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  return query select 'claimed'::text, v_id, v_entry.phone,
    v_entry.sms_consent_at, v_entry.sms_opted_out_at,
    v_entry.mobile_verified_at, v_inv.expires_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. settle_sms_message — what the provider answered
-- ---------------------------------------------------------------------------
--
-- Outcomes: accepted (the provider returned a message SID) | refused (it
-- definitely did not take the message) | unknown (an attempt was made and the
-- answer was lost: a timeout, a dropped connection, a reply without a SID) |
-- skipped (no provider call was made; the reason says why).
--
-- Only a `claimed` row settles. A delivery-status callback can beat the settle
-- to the row; when it has already recorded THIS SID, an `accepted` settle is
-- answered `already_settled` and changes nothing.
--
-- Results: settled | already_settled | not_found | not_claimed | invalid_input.

create or replace function public.settle_sms_message(
  p_message_id          uuid,
  p_outcome             text,
  p_provider_message_sid text,
  p_provider_error_code integer,
  p_skip_reason         text
) returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row record;
begin
  if p_message_id is null
     or p_outcome is null
     or p_outcome not in ('accepted', 'refused', 'unknown', 'skipped')
     or (p_outcome = 'accepted'
         and (p_provider_message_sid is null
              or p_provider_message_sid !~ '^(SM|MM)[0-9a-fA-F]{32}$'))
     or (p_outcome <> 'accepted' and p_provider_message_sid is not null)
     or (p_outcome = 'skipped'
         and (p_skip_reason is null or p_skip_reason !~ '^[a-z][a-z0-9_]{2,63}$'))
     or (p_outcome <> 'skipped' and p_skip_reason is not null)
     or (p_provider_error_code is not null
         and (p_outcome not in ('refused', 'unknown')
              or p_provider_error_code not between 1 and 99999999)) then
    return 'invalid_input';
  end if;

  select m.id, m.status, m.provider_message_sid
    into v_row
    from public.sms_outbound_messages m
   where m.id = p_message_id
     for update;

  if not found then
    return 'not_found';
  end if;

  if v_row.status <> 'claimed' then
    if p_outcome = 'accepted'
       and v_row.provider_message_sid = p_provider_message_sid then
      return 'already_settled';
    end if;
    -- An `unknown` settle that loses the race to a callback carrying the
    -- truth: the callback already said the provider has the message, and an
    -- ambiguity must never overwrite a fact.
    if p_outcome = 'unknown' and v_row.provider_message_sid is not null then
      return 'already_settled';
    end if;
    return 'not_claimed';
  end if;

  update public.sms_outbound_messages m
     set status               = p_outcome,
         provider_message_sid = p_provider_message_sid,
         provider_error_code  = p_provider_error_code,
         skip_reason          = p_skip_reason,
         settled_at           = now()
   where m.id = p_message_id;

  return 'settled';
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. record_sms_delivery_status — a Twilio status callback, applied once
-- ---------------------------------------------------------------------------
--
-- The callback route verifies Twilio's signature, then normalises
-- MessageStatus to queued | sending | sent | delivered | undelivered | failed.
-- Statuses only move FORWARD: callbacks arrive out of order, and a late
-- `sent` must not overwrite `delivered`. The three end states are terminal.
--
-- A callback also RESOLVES an `unknown` settle: the provider is telling us it
-- has the message, which is exactly what the ambiguous answer could not.
--
-- Results: updated | stale | unknown_message | sid_mismatch | not_sent |
-- invalid_input. studio_id, purpose and appointment_id are returned so the
-- route can raise an attributed alert on a terminal failure without a second
-- read.

create or replace function public.record_sms_delivery_status(
  p_message_id           uuid,
  p_provider_message_sid text,
  p_status               text,
  p_provider_error_code  integer
) returns table (
  result         text,
  studio_id      uuid,
  purpose        text,
  status         text,
  appointment_id uuid
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row      record;
  v_old_rank integer;
  v_new_rank integer;
begin
  if p_message_id is null
     or p_provider_message_sid is null
     or p_provider_message_sid !~ '^(SM|MM)[0-9a-fA-F]{32}$'
     or p_status is null
     or p_status not in ('queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed')
     or (p_provider_error_code is not null
         and p_provider_error_code not between 1 and 99999999) then
    return query select 'invalid_input'::text, null::uuid, null::text, null::text, null::uuid;
    return;
  end if;

  select m.id, m.studio_id, m.purpose, m.status, m.provider_message_sid,
         m.appointment_id
    into v_row
    from public.sms_outbound_messages m
   where m.id = p_message_id
     for update;

  if not found then
    return query select 'unknown_message'::text, null::uuid, null::text, null::text, null::uuid;
    return;
  end if;

  if v_row.provider_message_sid is not null
     and v_row.provider_message_sid <> p_provider_message_sid then
    return query select 'sid_mismatch'::text, v_row.studio_id, v_row.purpose, v_row.status, v_row.appointment_id;
    return;
  end if;

  -- A row Hone settled as never sent (`skipped`) or as definitely refused
  -- cannot be the subject of a delivery report.
  if v_row.status in ('skipped', 'refused') then
    return query select 'not_sent'::text, v_row.studio_id, v_row.purpose, v_row.status, v_row.appointment_id;
    return;
  end if;

  v_old_rank := case v_row.status
    when 'claimed'  then 0
    when 'unknown'  then 0
    when 'accepted' then 1
    when 'queued'   then 2
    when 'sending'  then 3
    when 'sent'     then 4
    else 5  -- delivered | undelivered | failed: terminal
  end;
  v_new_rank := case p_status
    when 'queued'  then 2
    when 'sending' then 3
    when 'sent'    then 4
    else 5
  end;

  if v_new_rank <= v_old_rank then
    return query select 'stale'::text, v_row.studio_id, v_row.purpose, v_row.status, v_row.appointment_id;
    return;
  end if;

  update public.sms_outbound_messages m
     set status               = p_status,
         provider_message_sid = p_provider_message_sid,
         provider_error_code  = coalesce(p_provider_error_code, m.provider_error_code),
         provider_status_at   = now(),
         settled_at           = coalesce(m.settled_at, now())
   where m.id = p_message_id;

  return query select 'updated'::text, v_row.studio_id, v_row.purpose, p_status, v_row.appointment_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
--
-- Supabase's ALTER DEFAULT PRIVILEGES grants a new table and every new
-- function to anon, authenticated AND service_role at create time. Each is
-- revoked BY NAME before anything is granted -- the 0129 (`anon`) and 0164
-- (`service_role`) failure class.

revoke all on public.sms_outbound_messages
  from public, anon, authenticated, service_role;

revoke execute on function public.begin_appointment_sms_message(uuid, uuid, text) from public;
revoke execute on function public.begin_appointment_sms_message(uuid, uuid, text) from anon;
revoke execute on function public.begin_appointment_sms_message(uuid, uuid, text) from authenticated;
revoke execute on function public.begin_appointment_sms_message(uuid, uuid, text) from service_role;

revoke execute on function public.claim_waitlist_invitation_sms(uuid, uuid) from public;
revoke execute on function public.claim_waitlist_invitation_sms(uuid, uuid) from anon;
revoke execute on function public.claim_waitlist_invitation_sms(uuid, uuid) from authenticated;
revoke execute on function public.claim_waitlist_invitation_sms(uuid, uuid) from service_role;

revoke execute on function public.settle_sms_message(uuid, text, text, integer, text) from public;
revoke execute on function public.settle_sms_message(uuid, text, text, integer, text) from anon;
revoke execute on function public.settle_sms_message(uuid, text, text, integer, text) from authenticated;
revoke execute on function public.settle_sms_message(uuid, text, text, integer, text) from service_role;

revoke execute on function public.record_sms_delivery_status(uuid, text, text, integer) from public;
revoke execute on function public.record_sms_delivery_status(uuid, text, text, integer) from anon;
revoke execute on function public.record_sms_delivery_status(uuid, text, text, integer) from authenticated;
revoke execute on function public.record_sms_delivery_status(uuid, text, text, integer) from service_role;

grant execute on function public.begin_appointment_sms_message(uuid, uuid, text) to service_role;
grant execute on function public.claim_waitlist_invitation_sms(uuid, uuid) to service_role;
grant execute on function public.settle_sms_message(uuid, text, text, integer, text) to service_role;
grant execute on function public.record_sms_delivery_status(uuid, text, text, integer) to service_role;

revoke all privileges on function public.sms_outbound_messages_server_timestamps()
  from public, anon, authenticated, service_role;
revoke all privileges on function public.sms_outbound_messages_identity_guard()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

comment on table public.sms_outbound_messages is
  'SMS-00 delivery ledger: one row per outbound SMS attempt, claimed before the provider call, settled with the provider''s answer, advanced by signed delivery-status callbacks. Holds no message body and no phone number. Written only by begin_appointment_sms_message, claim_waitlist_invitation_sms, settle_sms_message and record_sms_delivery_status (service_role only); no browser grant and no RLS policy.';
comment on column public.sms_outbound_messages.status is
  'claimed -> skipped | refused | unknown | accepted (settle_sms_message), then forward-only through queued, sending, sent to delivered | undelivered | failed (record_sms_delivery_status). A callback may also move claimed or unknown straight to a provider state, because it is the provider reporting that it has the message.';
comment on column public.sms_outbound_messages.provider_message_sid is
  'Twilio Message SID (SM… or MM…), written only from a provider answer or a signed callback. Write-once by trigger.';
comment on column public.sms_outbound_messages.provider_error_code is
  'Twilio''s numeric error code when the provider reported one. Never a provider message or payload.';
comment on column public.sms_outbound_messages.skip_reason is
  'Why no provider call was made, as a slug from the application vocabulary in lib/sms/delivery-ledger.ts. Present exactly when status = skipped.';
comment on function public.begin_appointment_sms_message(uuid, uuid, text) is
  'Create the ledger row for one appointment SMS attempt, after claim_sms_send (0049) has claimed it. Returns the row id, or null when the input is invalid or the appointment is not the studio''s. Does not decide whether a send may happen. service_role only.';
comment on function public.claim_waitlist_invitation_sms(uuid, uuid) is
  'The once-per-invitation SMS claim (SMS-01). Holds the invitation row FOR SHARE to commit, so liveness cannot change under it. Checks tenancy, invitation liveness and the studio switch, and returns the prospect''s phone, consent, opt-out and verification fields for the application''s prospectMayReceiveSms decision. Returns claimed | already_claimed | not_found | not_live | studio_disabled | invalid_input; only claimed writes a row. service_role only.';
comment on function public.settle_sms_message(uuid, text, text, integer, text) is
  'Record what the provider answered for a claimed attempt: accepted (with SID) | refused | unknown | skipped (with reason). Only a claimed row settles. Returns settled | already_settled | not_found | not_claimed | invalid_input. service_role only.';
comment on function public.record_sms_delivery_status(uuid, text, text, integer) is
  'Apply one signature-verified Twilio delivery-status callback to the attempt it names. Forward-only; the three end states are terminal; an unknown settle is resolved by the provider''s own report. Returns (result, studio_id, purpose, status, appointment_id) with result updated | stale | unknown_message | sid_mismatch | not_sent | invalid_input. service_role only.';

commit;
