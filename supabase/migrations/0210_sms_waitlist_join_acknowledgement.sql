-- ===========================================================================
-- 0210 — SMS-04: THE WAITLIST JOIN ACKNOWLEDGEMENT TEXT
-- ===========================================================================
--
-- A person who joins a studio's new-client waitlist on the public form, and
-- answers Yes to the text question with a usable number, gets ONE text after
-- the entry is durably saved:
--
--   "<Studio>: you've joined our waitlist. We'll contact you when you're
--    invited to book. Reply STOP to opt out."
--
-- This migration is the database half of two approved changes (SMS-04):
--
--   A. THE SIGNUP: a phone number is required for every NEW public waitlist
--      signup, and the text question is re-worded (version 2):
--        "May we text you about joining this waitlist and any appointment
--         offered from it? Reply STOP at any time to opt out."
--   B. THE JOIN TEXT: the ledger learns a fifth purpose, and one
--      service_role-only command claims the text at most once per entry.
--
-- Section by section:
--
--   1. sms_outbound_messages.waitlist_entry_id -- the new purpose's subject,
--      tied to its studio by a composite foreign key (tenancy by
--      construction, like the appointment subject).
--   2. The purpose and subject checks admit 'waitlist_join_acknowledgement'.
--   3. sms_outbound_messages_one_join_ack_per_entry -- AT MOST ONE join text
--      per entry, as a database fact rather than a property of one code path.
--   4. The identity guard also freezes waitlist_entry_id.
--   5. claim_waitlist_join_ack_sms(studio, entry) -- the claim.
--   6. sms_consent_text_version admits 'waitlist_sms_operational_v2' beside
--      v1 (every recorded v1 consent stays exactly as it is).
--   7. join_new_client_waitlist_with_phone_and_sms_answer -- the signup
--      command the application calls from now on. It is 0208's
--      join_new_client_waitlist_with_sms_answer with two differences: a
--      missing or unsendable phone is refused for a Yes AND a No, and a Yes is
--      stamped with version 2. 0208's command is LEFT IN PLACE, unchanged:
--      this migration is applied before the application that calls the new
--      command is deployed, and until then the deployed form (v1 wording)
--      keeps calling the old command, which keeps stamping v1 -- so every
--      stored answer names the words that person was shown. Retiring it is a
--      later, separate change.
--
-- EXISTING ENTRIES ARE UNTOUCHED. No row is read for rewriting, no constraint
-- requires a phone on a stored entry, and email-only people already waiting
-- stay valid. The owner's "Add someone to the waitlist" keeps its optional
-- phone. Only a NEW public signup must give one.
--
-- WHO CAN EVER BE TEXTED BY THIS, AND WHO CANNOT. The claim admits only a
-- GENUINELY NEW SELF-SERVICE JOIN WITH ITS OWN YES:
--
--   * the entry came from the public form (source public_booking, provenance
--     form) and is still waiting;
--   * its consent is the form's own Yes to the version-2 question (source
--     public_form, wording waitlist_sms_operational_v2), recorded IN THE JOIN
--     ITSELF -- the signup command (section 7) stamps it in the same
--     transaction that creates the entry, so it sits within seconds of
--     joined_at;
--   * the entry joined less than 15 minutes ago: only the request that
--     created it can claim its text.
--
-- So people ALREADY on a waitlist are never texted by it: not when consent is
-- later recorded for them (an owner's record or the Willow backfill is source
-- 'practitioner', never 'public_form'), not when a studio switches waitlist
-- texts on (nothing here runs on a switch), and not on a resubmission (the
-- join answers already_waiting and creates no entry). A No records nothing,
-- so it can never qualify.
--
-- THE SWITCH. The same studio switch as the invitation text,
-- send_waitlist_invitation_sms ("waitlist texts"). Off, the claim answers
-- studio_disabled and writes nothing; turning it on sends nothing by itself.
--
-- ONE TEXT PER NUMBER PER DAY. A different email with the same number is a new
-- entry, so the per-entry rule alone would let one form text one number again
-- and again. The claim also refuses (recently_acknowledged) while any join
-- text that may have reached the provider was claimed for the same sendable
-- number, in any studio, in the last 24 hours. "The same number" is
-- public.sms_normalized_phone (0199), the parity-proven SQL twin of the
-- sender's own normalizePhoneForSms.
--
-- WHAT THE APPLICATION STILL DECIDES, AFTER THE CLAIM: prospectMayReceiveSms
-- (STOP first, then recorded consent), a usable number, the phone-wide STOP
-- re-read, and the production fence -- exactly as the invitation text does.
-- Each records a skip with its reason on the claimed row.
--
-- NOT HERE: any write to a business table, any new trigger, any backfill, any
-- change to an applied migration's objects other than three checks and one
-- trigger function, each replaced whole below (the ledger's purpose and
-- subject checks, its identity guard, and the entries' wording-version
-- check), and any grant to a browser role. Rolling the application back after
-- this is safe: the earlier application calls neither new command and keeps
-- using 0208's signup command, which this migration leaves as it is.
-- ===========================================================================

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. The new subject
-- ---------------------------------------------------------------------------

alter table public.sms_outbound_messages
  add column waitlist_entry_id uuid;

-- Tenancy by construction: an entry can only be referenced together with the
-- studio that owns it (new_client_waitlist_entries carries UNIQUE (id,
-- studio_id)). The ledger is never embedded through PostgREST -- no browser
-- role can read it -- so this relationship adds no embed ambiguity.
alter table public.sms_outbound_messages
  add constraint sms_outbound_messages_entry_same_studio_fk
    foreign key (waitlist_entry_id, studio_id)
    references public.new_client_waitlist_entries (id, studio_id) on delete cascade;

-- ---------------------------------------------------------------------------
-- 2. The purpose and its subject (0206's checks, replaced whole)
-- ---------------------------------------------------------------------------

alter table public.sms_outbound_messages
  drop constraint sms_outbound_messages_purpose_ck;
alter table public.sms_outbound_messages
  add constraint sms_outbound_messages_purpose_ck check (purpose in (
    'appointment_confirmation',
    'appointment_reminder_24h',
    'appointment_reminder_2h',
    'waitlist_invitation',
    'waitlist_join_acknowledgement'
  ));

-- Exactly one subject, and the one the purpose names.
alter table public.sms_outbound_messages
  drop constraint sms_outbound_messages_subject_ck;
alter table public.sms_outbound_messages
  add constraint sms_outbound_messages_subject_ck check (
    case
      when purpose = 'waitlist_invitation'
        then waitlist_invitation_id is not null and appointment_id is null
             and waitlist_entry_id is null
      when purpose = 'waitlist_join_acknowledgement'
        then waitlist_entry_id is not null and appointment_id is null
             and waitlist_invitation_id is null
      else appointment_id is not null and waitlist_invitation_id is null
           and waitlist_entry_id is null
    end
  );

-- ---------------------------------------------------------------------------
-- 3. THE ONCE-PER-ENTRY RULE
-- ---------------------------------------------------------------------------
--
-- Only the join text has an entry subject, so "at most one row per entry" is
-- "at most one join text per entry".

create unique index sms_outbound_messages_one_join_ack_per_entry
  on public.sms_outbound_messages (waitlist_entry_id)
  where waitlist_entry_id is not null;

-- ---------------------------------------------------------------------------
-- 4. The identity guard (0206's, replaced whole, plus the new subject)
-- ---------------------------------------------------------------------------

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
     or new.waitlist_entry_id is distinct from old.waitlist_entry_id
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

-- ---------------------------------------------------------------------------
-- 5. claim_waitlist_join_ack_sms -- the claim
-- ---------------------------------------------------------------------------
--
-- Results (the claim writes a row ONLY for `claimed`):
--   claimed                a row now exists; the caller decides, sends, settles
--   already_claimed        this entry's text was claimed before
--   recently_acknowledged  this number got a join text in the last 24 hours
--   not_eligible           not a new self-service join with its own Yes
--   not_fresh              joined 15 minutes ago or more
--   studio_disabled        the studio's waitlist texts are off
--   not_found              no such entry in this studio
--   invalid_input
--
-- The entry row is held FOR NO KEY UPDATE, so two claims for one entry run one
-- at a time and the second sees the first's row (already_claimed) -- the same
-- serialisation 0207 gave the invitation claim. Returns the entry's phone and
-- SMS facts from that locked row, so the text goes to the number the consent
-- was recorded with (a stored phone can never change: 0202/0203).

create or replace function public.claim_waitlist_join_ack_sms(
  p_studio_id uuid,
  p_entry_id  uuid
) returns table (
  result             text,
  message_id         uuid,
  phone              text,
  sms_consent_at     timestamptz,
  sms_opted_out_at   timestamptz,
  mobile_verified_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_entry   record;
  v_enabled boolean;
  v_number  text;
  v_id      uuid;
begin
  if p_studio_id is null or p_entry_id is null then
    return query select 'invalid_input'::text, null::uuid, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  select e.status, e.source, e.joined_at, e.joined_at_provenance, e.phone,
         e.sms_consent_at, e.sms_consent_source, e.sms_consent_text_version,
         e.sms_opted_out_at, e.mobile_verified_at
    into v_entry
    from public.new_client_waitlist_entries e
   where e.id = p_entry_id
     and e.studio_id = p_studio_id
     for no key update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  select s.send_waitlist_invitation_sms into v_enabled
    from public.studios s
   where s.id = p_studio_id;
  if v_enabled is distinct from true then
    return query select 'studio_disabled'::text, null::uuid, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- A GENUINELY NEW SELF-SERVICE JOIN WITH ITS OWN YES, TO THE WORDS THAT
  -- NAME JOINING. Every clause is a fact the signup command (section 7) writes
  -- and nothing else does: an owner-recorded or backfilled consent is source
  -- 'practitioner'; an owner-added or imported entry is source 'practitioner' /
  -- 'legacy_import'; a later consent is not inside the join's own minute; and
  -- only version 2 asked about joining -- a v1 Yes (0208's command) never
  -- qualifies for this text.
  if v_entry.status is distinct from 'waiting'
     or v_entry.source is distinct from 'public_booking'
     or v_entry.joined_at_provenance is distinct from 'form'
     or v_entry.sms_consent_at is null
     or v_entry.sms_consent_source is distinct from 'public_form'
     or v_entry.sms_consent_text_version is distinct from 'waitlist_sms_operational_v2'
     or v_entry.sms_consent_at < v_entry.joined_at
     or v_entry.sms_consent_at > v_entry.joined_at + interval '1 minute' then
    return query select 'not_eligible'::text, null::uuid, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- ONCE PER ENTRY. Asked first, so a repeat names itself: the entry row is
  -- held, so no other claimer for it can land between this read and the
  -- insert below, whose unique index stays the backstop.
  if exists (
    select 1 from public.sms_outbound_messages m where m.waitlist_entry_id = p_entry_id
  ) then
    return query select 'already_claimed'::text, null::uuid, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- ONLY THE JOINING REQUEST. Nothing later -- no switch, no retry job, no
  -- second caller -- can produce a catch-up text for an entry that is no
  -- longer new.
  if v_entry.joined_at < clock_timestamp() - interval '15 minutes' then
    return query select 'not_fresh'::text, null::uuid, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- ONE TEXT PER NUMBER PER DAY, across studios: every studio shares one
  -- sender, so to the recipient it is one stream. A row that definitely
  -- reached no one (skipped, refused) does not count.
  v_number := public.sms_normalized_phone(v_entry.phone);
  if v_number is not null and exists (
    select 1
      from public.sms_outbound_messages m
      join public.new_client_waitlist_entries o
        on o.id = m.waitlist_entry_id
     where m.purpose = 'waitlist_join_acknowledgement'
       and m.claimed_at > clock_timestamp() - interval '24 hours'
       and m.status not in ('skipped', 'refused')
       and public.sms_normalized_phone(o.phone) = v_number
  ) then
    return query select 'recently_acknowledged'::text, null::uuid, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  insert into public.sms_outbound_messages (studio_id, purpose, waitlist_entry_id)
  values (p_studio_id, 'waitlist_join_acknowledgement', p_entry_id)
  on conflict (waitlist_entry_id) where waitlist_entry_id is not null
  do nothing
  returning id into v_id;
  if v_id is null then
    return query select 'already_claimed'::text, null::uuid, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  return query select 'claimed'::text, v_id, v_entry.phone,
    v_entry.sms_consent_at, v_entry.sms_opted_out_at, v_entry.mobile_verified_at;
end;
$$;


-- ---------------------------------------------------------------------------
-- 6. The wording version admits v2 (0202's check, replaced whole)
-- ---------------------------------------------------------------------------
--
-- Consent is to a specific sentence, so a re-worded question is a new
-- version and v1 keeps its own sentence. Every stored row (NULL or v1) still
-- satisfies the check.

alter table public.new_client_waitlist_entries
  drop constraint new_client_waitlist_entries_sms_consent_text_version_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_sms_consent_text_version_check
  check (sms_consent_text_version is null
         or sms_consent_text_version in ('waitlist_sms_operational_v1',
                                         'waitlist_sms_operational_v2'));

-- ---------------------------------------------------------------------------
-- 7. join_new_client_waitlist_with_phone_and_sms_answer -- the signup
-- ---------------------------------------------------------------------------
--
-- 0208's wrapper, with a required phone and the version-2 stamp. The admission
-- gate and the join itself are join_new_client_waitlist_guarded (0204),
-- called unchanged, so the duplicate rule, the studio's admission mode and
-- the legacy bridge behave exactly as before.
--
-- A PHONE NUMBER IS REQUIRED, for a Yes and a No alike, and it must be a
-- number the sender could text: public.sms_normalized_phone (0199), the
-- parity-proven twin of normalizePhoneForSms, which the form and the server
-- action apply first. A missing or unusable number is invalid_input and
-- writes nothing.
--
-- A Yes is recorded ONLY on an entry this call just created (a resubmission
-- answers already_waiting and changes nothing, so an email-only entry stays
-- as it is), with the database clock, source public_form, version 2. A No
-- records nothing and joins exactly the same way.

create or replace function public.join_new_client_waitlist_with_phone_and_sms_answer(
  p_studio_id              uuid,
  p_name                   text,
  p_email                  text,
  p_phone                  text,
  p_legacy_bridge_waitlist boolean,
  p_sms_consent            boolean
)
returns table (result text, entry_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_result text;
  v_entry  uuid;
  v_rows   integer;
begin
  if p_sms_consent is null then
    return query select 'invalid_input'::text, null::uuid;
    return;
  end if;

  if public.sms_normalized_phone(p_phone) is null then
    return query select 'invalid_input'::text, null::uuid;
    return;
  end if;

  select j.result, j.entry_id
    into v_result, v_entry
    from public.join_new_client_waitlist_guarded(
           p_studio_id, p_name, p_email, p_phone, p_legacy_bridge_waitlist) j;

  if v_result = 'created' and p_sms_consent then
    update public.new_client_waitlist_entries e
       set sms_consent_at           = clock_timestamp(),
           sms_consent_source       = 'public_form',
           sms_consent_text_version = 'waitlist_sms_operational_v2'
     where e.id = v_entry
       and e.studio_id = p_studio_id
       and e.sms_consent_at is null
       and e.phone is not null;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception
        'join_new_client_waitlist_with_phone_and_sms_answer: the answer for a new entry could not be recorded';
    end if;
  end if;

  return query select v_result, v_entry;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
--
-- Supabase's ALTER DEFAULT PRIVILEGES grants every new function to anon,
-- authenticated AND service_role at create time. Revoked BY NAME before the
-- one grant -- the 0129 (`anon`) and 0164 (`service_role`) failure class.

revoke execute on function public.claim_waitlist_join_ack_sms(uuid, uuid) from public;
revoke execute on function public.claim_waitlist_join_ack_sms(uuid, uuid) from anon;
revoke execute on function public.claim_waitlist_join_ack_sms(uuid, uuid) from authenticated;
revoke execute on function public.claim_waitlist_join_ack_sms(uuid, uuid) from service_role;
grant execute on function public.claim_waitlist_join_ack_sms(uuid, uuid) to service_role;

revoke execute on function public.join_new_client_waitlist_with_phone_and_sms_answer(uuid, text, text, text, boolean, boolean) from public;
revoke execute on function public.join_new_client_waitlist_with_phone_and_sms_answer(uuid, text, text, text, boolean, boolean) from anon;
revoke execute on function public.join_new_client_waitlist_with_phone_and_sms_answer(uuid, text, text, text, boolean, boolean) from authenticated;
revoke execute on function public.join_new_client_waitlist_with_phone_and_sms_answer(uuid, text, text, text, boolean, boolean) from service_role;
grant execute on function public.join_new_client_waitlist_with_phone_and_sms_answer(uuid, text, text, text, boolean, boolean) to service_role;

-- The guard was replaced; its privileges are restated, not assumed.
revoke all privileges on function public.sms_outbound_messages_identity_guard()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

comment on table public.sms_outbound_messages is
  'SMS-00 delivery ledger: one row per outbound SMS attempt, claimed before the provider call, settled with the provider''s answer, advanced by signed delivery-status callbacks. Holds no message body and no phone number. Written only by begin_appointment_sms_message, claim_waitlist_invitation_sms, claim_waitlist_join_ack_sms (0210), settle_sms_message and record_sms_delivery_status (service_role only); no browser grant and no RLS policy.';
comment on column public.sms_outbound_messages.waitlist_entry_id is
  'SMS-04 (0210). The waitlist entry a join acknowledgement text is about; set only for purpose waitlist_join_acknowledgement, at most one row per entry, write-once by trigger.';
comment on function public.claim_waitlist_join_ack_sms(uuid, uuid) is
  'SMS-04 (0210). Claims the ONE join acknowledgement text for a genuinely new self-service waitlist join with its own Yes (public form, still waiting, consent public_form recorded in the join, joined < 15 minutes ago), when the studio''s waitlist texts are on, at most once per entry and once per sendable number per 24 hours. Writes a ledger row only for claimed. Returns (result, message_id, phone, sms_consent_at, sms_opted_out_at, mobile_verified_at); result is claimed | already_claimed | recently_acknowledged | not_eligible | not_fresh | studio_disabled | not_found | invalid_input. service_role only.';
comment on column public.new_client_waitlist_entries.sms_consent_text_version is
  'Which wording a self-service Yes agreed to: waitlist_sms_operational_v1 ("Text me about this waitlist and any appointment offered from it. Reply STOP at any time to opt out.") or, from 0210, waitlist_sms_operational_v2 ("May we text you about joining this waitlist and any appointment offered from it? Reply STOP at any time to opt out."). Consent is to a specific sentence: a re-wording is a new version and an existing version is never re-pointed. NULL for an owner-recorded consent, which no form sentence was shown for.';
comment on function public.join_new_client_waitlist_with_phone_and_sms_answer(uuid, text, text, text, boolean, boolean) is
  'SMS-04 (0210). The public waitlist signup: a phone number the sender could text is REQUIRED (public.sms_normalized_phone) for a Yes and a No alike; NULL answer refused; the admission gate and join are join_new_client_waitlist_guarded (0204), unchanged; a Yes is stamped (public_form, waitlist_sms_operational_v2, database clock) only on an entry this call created. Returns (result, entry_id). service_role only. Supersedes join_new_client_waitlist_with_sms_answer (0208), which is kept for the deployed application until it is replaced.';

commit;
