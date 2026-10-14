-- ===========================================================================
-- 0208 — WAITLIST SMS CONSENT: PRACTITIONER RECORDING AND THE SIGNUP ANSWER
-- ===========================================================================
--
-- CANDIDATE, NOT APPLIED. Authored on the SMS-01 replacement line (SMS-01 r2
-- d931d934 + #812 5de29cc2) with the canonical derivation run at authoring
-- time: repo max 0207, hosted max 0207, pending none, next free 0208.
--
-- WHY THIS EXISTS. No live product path can record a waitlist prospect's SMS
-- consent today. The public signup (app/book/[slug]/NewClientWaitlistForm.tsx
-- -> join_new_client_waitlist_guarded) collects name, email and phone only,
-- and the two WAIT-04A consent surfaces (WaitlistJoinForm, CompleteProfilePanel)
-- are rendered by no route. Under D4(2) a prospect is texted on recorded
-- consent and no STOP, so without a recording path SMS-01 sends nothing.
-- The studio owner confirms some prospects gave SMS consent directly to the
-- studio. This migration gives that confirmation an honest place, and gives
-- every NEW signup an explicit Yes/No answer.
--
-- WHAT THIS ADDS:
--   1. Four nullable provenance columns, NULL for every existing row:
--        sms_consent_recorded_by_practitioner_id  who recorded it
--        sms_consent_scope                        what the permission covers
--        sms_consent_evidence_ref                 where the evidence is
--        sms_consent_given_on                     the date the person agreed,
--                                                 when the recorder knows it
--   2. A tightened evidence shape. A practitioner record carries NO wording
--      version: nobody was shown waitlist_sms_operational_v1, so recording it
--      would invent a public-form acceptance. It carries provenance instead.
--   3. Consent evidence becomes WRITE-ONCE in the transition guard: it may be
--      added, never changed or removed. Every existing consent and every
--      stored phone binding is preserved by construction.
--   4. record_waitlist_sms_consent_by_practitioner: owner-only, refuses an
--      opted-out entry, an entry that already holds consent, an entry with no
--      stored number, and a removed or converted entry.
--   5. join_new_client_waitlist_with_sms_answer: the live signup's command. It
--      requires an explicit answer (NULL is "not answered", never "no"), wraps
--      the UNCHANGED join_new_client_waitlist_guarded, and records a Yes in the
--      same transaction, on a new entry only.
--
-- WHAT THIS DOES NOT DO: write any row, change any studio switch, touch any
-- applied migration, redefine the SMS-00 claim, or decide eligibility.
-- prospectMayReceiveSms (TypeScript) stays the one authority: STOP wins, then
-- recorded consent decides. The phone-wide part of STOP is matched in
-- TypeScript (selectHoneSuppressionTargets), as 0202 explains, and is applied
-- by the application before a practitioner records and before a text is sent.
-- ===========================================================================

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. PREFLIGHT. No practitioner-sourced consent can exist yet: no command has
-- ever written that source. If one does, it predates provenance and must be
-- reconciled by a person, not reshaped by this migration.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from public.new_client_waitlist_entries e
     where e.sms_consent_source = 'practitioner'
  ) then
    raise exception
      '0208: a practitioner-sourced waitlist consent exists without provenance; reconcile it before applying';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. PROVENANCE COLUMNS. Nullable, no DEFAULT: catalog-only, no table rewrite.
-- ---------------------------------------------------------------------------

alter table public.new_client_waitlist_entries
  add column if not exists sms_consent_recorded_by_practitioner_id uuid,
  add column if not exists sms_consent_scope        text,
  add column if not exists sms_consent_evidence_ref text,
  add column if not exists sms_consent_given_on     date;

-- THE RECORDER IS A SAME-STUDIO ACTOR, held by the same composite foreign key
-- every other actor column on this table uses (claimed_by, created_by,
-- removed_by): (actor, studio_id) -> practitioners (id, studio_id), restrict.
-- 0179's law: durable actor attribution can never name another studio's
-- practitioner, and a simple FK to practitioners(id) is reserved for the nine
-- non-actor relationships tests/db/actor-fk-integrity pins.
alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_sms_consent_recorder_same_studio_fk;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_sms_consent_recorder_same_studio_fk
  foreign key (sms_consent_recorded_by_practitioner_id, studio_id)
  references public.practitioners (id, studio_id) on delete restrict;

-- ---------------------------------------------------------------------------
-- 2. CONSTRAINTS
-- ---------------------------------------------------------------------------

-- ONE SCOPE, AND IT IS THE PURPOSE THE PUBLIC SENTENCE NAMES: texts about this
-- waitlist and any appointment offered from it. A wider purpose needs its own
-- value and a sender that reads it, never a reinterpretation of this one.
alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_sms_consent_scope_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_sms_consent_scope_check
  check (sms_consent_scope is null or sms_consent_scope in ('waitlist_operational'));

-- A REFERENCE, NOT A TRANSCRIPT. Short, single-line, stored trimmed.
alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_sms_consent_evidence_ref_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_sms_consent_evidence_ref_check
  check (
    sms_consent_evidence_ref is null
    or (length(sms_consent_evidence_ref) between 3 and 200
        and sms_consent_evidence_ref = btrim(sms_consent_evidence_ref)
        and sms_consent_evidence_ref !~ '[[:cntrl:]]')
  );

-- CONSENT EVIDENCE, NOW IN THREE SHAPES. Each is all-or-nothing within itself,
-- as 0202's was, and the shapes cannot be mixed:
--   * never agreed: every consent column NULL;
--   * the person agreed to a pinned sentence themselves (public form or their
--     own link): instant, source and wording version, and NO practitioner
--     provenance;
--   * a practitioner records an agreement made outside Hone: instant (the
--     recording), recorder, scope and evidence, and NO wording version. The
--     date the person agreed is optional because it is honestly unknown for
--     some people; it may never be after the recording (one day of slack for
--     the studio's timezone, the command applies the exact local rule).
alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_sms_consent_evidence_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_sms_consent_evidence_check
  check (
    (sms_consent_at is null
       and sms_consent_source is null
       and sms_consent_text_version is null
       and sms_consent_recorded_by_practitioner_id is null
       and sms_consent_scope is null
       and sms_consent_evidence_ref is null
       and sms_consent_given_on is null)
    or
    (sms_consent_at is not null
       and sms_consent_source in ('public_form', 'prospect_link')
       and sms_consent_text_version is not null
       and sms_consent_recorded_by_practitioner_id is null
       and sms_consent_scope is null
       and sms_consent_evidence_ref is null
       and sms_consent_given_on is null)
    or
    (sms_consent_at is not null
       and sms_consent_source = 'practitioner'
       and sms_consent_text_version is null
       and sms_consent_recorded_by_practitioner_id is not null
       and sms_consent_scope is not null
       and sms_consent_evidence_ref is not null
       and (sms_consent_given_on is null
            or sms_consent_given_on <= (sms_consent_at at time zone 'UTC')::date + 1))
  );

-- ---------------------------------------------------------------------------
-- 3. THE TRANSITION GUARD, CARRIED FROM 0203 WITH ONE CLAUSE ADDED
-- ---------------------------------------------------------------------------
--
-- Carried VERBATIM apart from one inserted clause: consent evidence is
-- write-once. The body is reproduced in full rather than patched, because
-- `create or replace function` replaces the whole body and a partial edit would
-- silently drop every rule it did not mention. tests/migrations/0208-* compares
-- this body against 0203's and allows exactly that one inserted region.

create or replace function public.new_client_waitlist_entries_transition_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  v_legal   boolean;
  v_allowed text[];
  v_bad     text[] := '{}';
begin
  if new.id is distinct from old.id
     or new.studio_id is distinct from old.studio_id
     or new.joined_at is distinct from old.joined_at
     or new.source is distinct from old.source then
    raise exception
      'new_client_waitlist_entries: id, studio_id, joined_at and source are immutable'
      using errcode = 'check_violation';
  end if;

  -- NAME AND EMAIL STAY ABSOLUTELY IMMUTABLE. The email is where every future
  -- invitation goes, and there is still no correction command for either.
  if new.name is distinct from old.name
     or new.email is distinct from old.email then
    raise exception
      'new_client_waitlist_entries: name and email are immutable; there is no correction command yet'
      using errcode = 'check_violation';
  end if;

  -- THE MOBILE IS ONE-WAY, AND THIS IS THE CLAUSE THE SLICE TURNS ON.
  -- Absent may become present exactly once, which is what lets a legacy
  -- completion collect a candidate. Present may never become a DIFFERENT number
  -- and may never become absent. `ProfileCompletionPatch` already makes
  -- replacement unsayable in TypeScript; this makes it unwritable in the
  -- database, so a later command cannot reintroduce it by accident.
  if old.phone is not null and new.phone is distinct from old.phone then
    raise exception
      'new_client_waitlist_entries: a stored mobile may not be replaced or cleared'
      using errcode = 'check_violation';
  end if;

  -- AN OPT-OUT IS TERMINAL. Nothing clears it, re-times it, or re-attributes
  -- it. A later consent cannot resurrect sendability.
  if old.sms_opted_out_at is not null
     and (new.sms_opted_out_at    is distinct from old.sms_opted_out_at
          or new.sms_opt_out_source is distinct from old.sms_opt_out_source) then
    raise exception
      'new_client_waitlist_entries: an opt-out is terminal and its evidence is immutable'
      using errcode = 'check_violation';
  end if;

  -- CONSENT EVIDENCE IS WRITE-ONCE (0208). It records an act at a time by a
  -- named route, so it may be ADDED once and never changed, re-attributed,
  -- re-timed or removed. Withdrawal is not an edit: it is `sms_opted_out_at`,
  -- terminal above. This makes "preserve existing consent evidence" a property
  -- of the table rather than of every command remembering it.
  if old.sms_consent_at is not null
     and (new.sms_consent_at                          is distinct from old.sms_consent_at
          or new.sms_consent_source                   is distinct from old.sms_consent_source
          or new.sms_consent_text_version             is distinct from old.sms_consent_text_version
          or new.sms_consent_recorded_by_practitioner_id
                                                      is distinct from old.sms_consent_recorded_by_practitioner_id
          or new.sms_consent_scope                    is distinct from old.sms_consent_scope
          or new.sms_consent_evidence_ref             is distinct from old.sms_consent_evidence_ref
          or new.sms_consent_given_on                 is distinct from old.sms_consent_given_on) then
    raise exception
      'new_client_waitlist_entries: consent evidence is write-once; it may be added, never changed or removed'
      using errcode = 'check_violation';
  end if;

  -- VERIFICATION NOW HAS EXACTLY ONE WRITER, AND THIS IS THE CLAUSE 0202 SAID
  -- WOULD BE AMENDED. It is amended, not removed.
  --
  -- The permit is a row-scoped transaction-local GUC set by
  -- `mark_waitlist_mobile_verified` immediately before its UPDATE, following the
  -- pattern 0120 established for finalized clinical records. Three properties
  -- make it a narrow authority rather than general write access:
  --
  --   1. ROW-SCOPED. A permit for entry A grants nothing over entry B, even in
  --      the same transaction.
  --   2. STRUCTURALLY UNREACHABLE FROM A REST CLIENT. PostgREST gives each
  --      request its own transaction and no way to compose `set_config` with a
  --      write, so only a DEFINER body can hold both. No role holds DML on this
  --      table anyway (0185 revoked ALL from every role including service_role).
  --   3. ONE DIRECTION ONLY. NULL may become an instant. A verified instant may
  --      never move and may never return to NULL: possession proved once is not
  --      un-proved by a later write, and a re-verification that could re-stamp
  --      would let the timestamp drift away from the proof it records.
  if new.mobile_verified_at is distinct from old.mobile_verified_at then
    if old.mobile_verified_at is not null then
      raise exception
        'new_client_waitlist_entries: mobile_verified_at is immutable once proved'
        using errcode = 'check_violation';
    end if;
    if new.mobile_verified_at is null then
      raise exception
        'new_client_waitlist_entries: mobile_verified_at may not be cleared'
        using errcode = 'check_violation';
    end if;
    if coalesce(current_setting('hone.mobile_verified_entry_id', true), '')
       is distinct from new.id::text then
      raise exception
        'new_client_waitlist_entries: mobile_verified_at has exactly one writer, and this is not it'
        using errcode = 'check_violation';
    end if;
  end if;

  if new.status is distinct from old.status then
    v_legal := (old.status, new.status) in (
      ('waiting',  'claimed'),
      ('waiting',  'removed'),
      ('claimed',  'invited'),
      ('claimed',  'released'),
      ('invited',  'converted'),
      ('invited',  'expired'),
      ('invited',  'released'),
      ('expired',  'released'),
      ('expired',  'waiting'),
      ('expired',  'removed'),
      ('released', 'waiting'),
      ('released', 'removed')
    );

    if not v_legal then
      raise exception
        'new_client_waitlist_entries: illegal lifecycle transition % -> % (a claimed or invited entry must be released or expired before removal)',
        old.status, new.status
        using errcode = 'check_violation';
    end if;

    -- ONLY the evidence this transition owns may move.
    v_allowed := case old.status || '->' || new.status
      when 'waiting->claimed'   then array['claimed_at', 'claimed_by_practitioner_id']
      when 'waiting->removed'   then array['removed_at', 'removed_by_practitioner_id']
      when 'claimed->invited'   then array['invited_at']
      when 'claimed->released'  then array['released_at']
      when 'invited->converted' then array['converted_at', 'converted_client_id']
      when 'invited->expired'   then array['expired_at']
      when 'invited->released'  then array['released_at']
      when 'expired->released'  then array['released_at']
      when 'expired->removed'   then array['removed_at', 'removed_by_practitioner_id']
      when 'released->removed'  then array['removed_at', 'removed_by_practitioner_id']
      when 'expired->waiting'   then array['claimed_at', 'claimed_by_practitioner_id',
                                           'invited_at', 'expired_at', 'released_at']
      when 'released->waiting'  then array['claimed_at', 'claimed_by_practitioner_id',
                                           'invited_at', 'expired_at', 'released_at']
      else array[]::text[]
    end;

    if not ('claimed_at' = any (v_allowed))
       and new.claimed_at is distinct from old.claimed_at then
      v_bad := v_bad || 'claimed_at'::text;
    end if;
    if not ('claimed_by_practitioner_id' = any (v_allowed))
       and new.claimed_by_practitioner_id is distinct from old.claimed_by_practitioner_id then
      v_bad := v_bad || 'claimed_by_practitioner_id'::text;
    end if;
    if not ('invited_at' = any (v_allowed))
       and new.invited_at is distinct from old.invited_at then
      v_bad := v_bad || 'invited_at'::text;
    end if;
    if not ('expired_at' = any (v_allowed))
       and new.expired_at is distinct from old.expired_at then
      v_bad := v_bad || 'expired_at'::text;
    end if;
    if not ('released_at' = any (v_allowed))
       and new.released_at is distinct from old.released_at then
      v_bad := v_bad || 'released_at'::text;
    end if;
    if not ('converted_at' = any (v_allowed))
       and new.converted_at is distinct from old.converted_at then
      v_bad := v_bad || 'converted_at'::text;
    end if;
    if not ('converted_client_id' = any (v_allowed))
       and new.converted_client_id is distinct from old.converted_client_id then
      v_bad := v_bad || 'converted_client_id'::text;
    end if;
    if not ('removed_at' = any (v_allowed))
       and new.removed_at is distinct from old.removed_at then
      v_bad := v_bad || 'removed_at'::text;
    end if;
    if not ('removed_by_practitioner_id' = any (v_allowed))
       and new.removed_by_practitioner_id is distinct from old.removed_by_practitioner_id then
      v_bad := v_bad || 'removed_by_practitioner_id'::text;
    end if;

    if array_length(v_bad, 1) is not null then
      raise exception
        'new_client_waitlist_entries: transition % -> % may not change %; that evidence belongs to an earlier transition',
        old.status, new.status, array_to_string(v_bad, ', ')
        using errcode = 'check_violation';
    end if;
  else
    -- Status unchanged: the record is frozen. Nothing may be re-attributed,
    -- re-timed, or quietly reverted to NULL.
    if new.claimed_at is distinct from old.claimed_at
       or new.claimed_by_practitioner_id is distinct from old.claimed_by_practitioner_id
       or new.invited_at is distinct from old.invited_at
       or new.expired_at is distinct from old.expired_at
       or new.released_at is distinct from old.released_at
       or new.converted_at is distinct from old.converted_at
       or new.converted_client_id is distinct from old.converted_client_id
       or new.removed_at is distinct from old.removed_at
       or new.removed_by_practitioner_id is distinct from old.removed_by_practitioner_id then
      raise exception
        'new_client_waitlist_entries: lifecycle evidence changes only in the statement that performs a legal transition'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. COMMAND — A STUDIO OWNER RECORDS CONSENT GIVEN OUTSIDE HONE
-- ---------------------------------------------------------------------------
--
-- WHO. The actor is the authenticated user the server action resolved from the
-- session, never a form value. Membership and the owner role are re-derived
-- here, exactly as remove_new_client_waitlist_entry does, so a role change
-- committed after the route's own check still refuses.
--
-- WHAT IS RECORDED. `sms_consent_at` is the database clock at the RECORDING,
-- which is the instant Hone came to hold this consent; it is never back-dated.
-- The day the person agreed is `sms_consent_given_on` when the recorder knows
-- it, and NULL when the recorder has explicitly said it is unknown. The caller
-- must say which (p_consent_date_known), so "unknown" is an assertion, not an
-- omission. No wording version is written: the person was not shown one.
--
-- ORDER OF REFUSALS. STOP first, because an opted-out person must never be
-- told (by a success) that consent now applies. Then existing evidence, which
-- is never replaced: a second recording, or an entry that already consented
-- through a form, answers `already_consented` and writes nothing. Then the
-- binding: consent attaches to a stored number, so an entry without one
-- refuses. A removed or converted entry cannot be invited, so recording there
-- would be evidence of nothing.
--
-- THE PHONE-WIDE HALF OF STOP is not decided here. 0202 keeps phone matching in
-- TypeScript (there is no SQL normalizePhoneForMatch), and the server action
-- refuses a number suppressed anywhere before it calls this command. The send
-- path re-checks phone-wide at the moment of sending, so a STOP that lands
-- after this recording still wins.
--
-- Results: recorded | already_consented | opted_out | no_phone | not_active |
-- not_found | not_owner | not_a_member | invalid_input.
create or replace function public.record_waitlist_sms_consent_by_practitioner(
  p_studio_id          uuid,
  p_entry_id           uuid,
  p_actor_user_id      uuid,
  p_scope              text,
  p_evidence_ref       text,
  p_consent_date_known boolean,
  p_consent_given_on   date
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_practitioner_id uuid;
  v_role            text;
  v_timezone        text;
  v_today           date;
  v_evidence        text := btrim(coalesce(p_evidence_ref, ''));
  v_entry           record;
begin
  if p_studio_id is null or p_entry_id is null or p_actor_user_id is null
     or p_scope is null or p_consent_date_known is null then
    return 'invalid_input';
  end if;

  if p_scope not in ('waitlist_operational') then
    return 'invalid_input';
  end if;

  if length(v_evidence) < 3 or length(v_evidence) > 200
     or v_evidence ~ '[[:cntrl:]]' then
    return 'invalid_input';
  end if;

  -- STATED OR DECLARED UNKNOWN, NOTHING IN BETWEEN.
  if (p_consent_date_known and p_consent_given_on is null)
     or (not p_consent_date_known and p_consent_given_on is not null) then
    return 'invalid_input';
  end if;

  select p.id, p.role
    into v_practitioner_id, v_role
    from public.practitioners p
   where p.studio_id = p_studio_id
     and p.user_id   = p_actor_user_id
     and p.active    = true
   limit 1;

  if v_practitioner_id is null then
    return 'not_a_member';
  end if;
  if v_role <> 'owner' then
    return 'not_owner';
  end if;

  -- "Today" is the STUDIO's calendar day: a date read off a local calendar is
  -- never refused for being tomorrow in UTC.
  select s.timezone into v_timezone from public.studios s where s.id = p_studio_id;
  v_today := (clock_timestamp() at time zone coalesce(v_timezone, 'UTC'))::date;

  if p_consent_date_known
     and (p_consent_given_on > v_today or p_consent_given_on < date '2000-01-01') then
    return 'invalid_input';
  end if;

  select e.status, e.phone, e.sms_consent_at, e.sms_opted_out_at
    into v_entry
    from public.new_client_waitlist_entries e
   where e.id = p_entry_id
     and e.studio_id = p_studio_id
     for update;

  if not found then
    return 'not_found';
  end if;
  if v_entry.sms_opted_out_at is not null then
    return 'opted_out';
  end if;
  if v_entry.sms_consent_at is not null then
    return 'already_consented';
  end if;
  if v_entry.phone is null then
    return 'no_phone';
  end if;
  if v_entry.status in ('removed', 'converted') then
    return 'not_active';
  end if;

  update public.new_client_waitlist_entries e
     set sms_consent_at                          = clock_timestamp(),
         sms_consent_source                      = 'practitioner',
         sms_consent_text_version                = null,
         sms_consent_recorded_by_practitioner_id = v_practitioner_id,
         sms_consent_scope                       = p_scope,
         sms_consent_evidence_ref                = v_evidence,
         sms_consent_given_on                    = case when p_consent_date_known
                                                        then p_consent_given_on end
   where e.id = p_entry_id
     and e.studio_id = p_studio_id;

  return 'recorded';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. COMMAND — THE LIVE SIGNUP, WITH AN EXPLICIT SMS ANSWER
-- ---------------------------------------------------------------------------
--
-- A WRAPPER, NOT A COPY. join_new_client_waitlist_guarded (0204) keeps its
-- admission gate and the join it calls; both run unchanged inside this call,
-- so the answer and the join commit together or not at all.
--
-- THE ANSWER IS REQUIRED. NULL is "not answered", never "no": the visitor must
-- choose. Yes needs a number to bind to (at least seven digits, the profile
-- vocabulary's floor). No records nothing, which is exactly what 0202 says a
-- decline is, and costs nothing else: the entry, its email and its place are
-- identical either way.
--
-- ONLY A NEW ENTRY RECORDS A YES. An `already_waiting` answer writes nothing,
-- for the reason 0202's join gives: a public, unauthenticated form must not be
-- able to change an existing person's record from a known address.
--
-- A Yes records the public sentence the form shows, verbatim
-- (waitlist_sms_operational_v1), with the database clock, source public_form.
create or replace function public.join_new_client_waitlist_with_sms_answer(
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
  v_phone  text := btrim(coalesce(p_phone, ''));
  v_result text;
  v_entry  uuid;
  v_rows   integer;
begin
  if p_sms_consent is null then
    return query select 'invalid_input'::text, null::uuid;
    return;
  end if;

  if p_sms_consent
     and (v_phone = '' or length(regexp_replace(v_phone, '[^0-9]', '', 'g')) < 7) then
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
           sms_consent_text_version = 'waitlist_sms_operational_v1'
     where e.id = v_entry
       and e.studio_id = p_studio_id
       and e.sms_consent_at is null
       and e.phone is not null;
    get diagnostics v_rows = row_count;
    -- The join and its answer are one commit. A Yes that cannot be recorded
    -- undoes the join rather than leaving someone on the list with their
    -- answer silently dropped.
    if v_rows <> 1 then
      raise exception
        'join_new_client_waitlist_with_sms_answer: the answer for a new entry could not be recorded';
    end if;
  end if;

  return query select v_result, v_entry;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. PRIVILEGES
-- ---------------------------------------------------------------------------
--
-- Literal statements, every grantee revoked BY NAME first: ALTER DEFAULT
-- PRIVILEGES arms anon, authenticated AND service_role at function-create
-- time (the 0129/0164 trap). No table privilege is granted to anyone.

revoke execute on function public.record_waitlist_sms_consent_by_practitioner(uuid, uuid, uuid, text, text, boolean, date) from public;
revoke execute on function public.record_waitlist_sms_consent_by_practitioner(uuid, uuid, uuid, text, text, boolean, date) from anon;
revoke execute on function public.record_waitlist_sms_consent_by_practitioner(uuid, uuid, uuid, text, text, boolean, date) from authenticated;
revoke execute on function public.record_waitlist_sms_consent_by_practitioner(uuid, uuid, uuid, text, text, boolean, date) from service_role;

revoke execute on function public.join_new_client_waitlist_with_sms_answer(uuid, text, text, text, boolean, boolean) from public;
revoke execute on function public.join_new_client_waitlist_with_sms_answer(uuid, text, text, text, boolean, boolean) from anon;
revoke execute on function public.join_new_client_waitlist_with_sms_answer(uuid, text, text, text, boolean, boolean) from authenticated;
revoke execute on function public.join_new_client_waitlist_with_sms_answer(uuid, text, text, text, boolean, boolean) from service_role;

grant execute on function public.record_waitlist_sms_consent_by_practitioner(uuid, uuid, uuid, text, text, boolean, date) to service_role;
grant execute on function public.join_new_client_waitlist_with_sms_answer(uuid, text, text, text, boolean, boolean) to service_role;

-- The transition guard runs only as the table owner through its trigger and is
-- granted to no application role.
revoke execute on function public.new_client_waitlist_entries_transition_guard() from public;
revoke execute on function public.new_client_waitlist_entries_transition_guard() from anon;
revoke execute on function public.new_client_waitlist_entries_transition_guard() from authenticated;
revoke execute on function public.new_client_waitlist_entries_transition_guard() from service_role;

-- ---------------------------------------------------------------------------
-- 7. COMMENTS
-- ---------------------------------------------------------------------------

comment on column public.new_client_waitlist_entries.sms_consent_at is
  'When Hone came to hold this consent, from the database clock. For public_form and prospect_link it is the instant the person agreed, stamped in the same transaction as the agreement. For practitioner it is the instant the owner RECORDED an agreement made outside Hone; the day the person agreed is sms_consent_given_on. Never back-dated. NULL means "never agreed", never "declined at". Write-once (0208 guard).';

comment on column public.new_client_waitlist_entries.sms_consent_source is
  'Where the agreement was collected: public_form | prospect_link (the person agreed to a pinned sentence themselves) | practitioner (a studio owner recorded an agreement made outside Hone, with provenance). A fact about which command ran, never a value the browser supplies.';

comment on column public.new_client_waitlist_entries.sms_consent_text_version is
  'Which wording the person agreed to, pinned to waitlist_sms_operational_v1. NULL for a practitioner record: nobody was shown a sentence, and writing one would invent a public-form acceptance.';

comment on column public.new_client_waitlist_entries.sms_consent_recorded_by_practitioner_id is
  'The studio owner who recorded a practitioner-sourced consent, derived in the database from the authenticated session. Present exactly when sms_consent_source = practitioner.';

comment on column public.new_client_waitlist_entries.sms_consent_scope is
  'What a practitioner-recorded consent covers. waitlist_operational = texts about this waitlist and any appointment offered from it, the purpose the public sentence names. Present exactly when sms_consent_source = practitioner.';

comment on column public.new_client_waitlist_entries.sms_consent_evidence_ref is
  'Where the evidence of a practitioner-recorded consent lives (a short reference such as a file, form or conversation note), 3-200 characters, one line. Present exactly when sms_consent_source = practitioner.';

comment on column public.new_client_waitlist_entries.sms_consent_given_on is
  'The day the person agreed, when the recorder knows it. NULL on a practitioner record means the recorder explicitly declared the date unknown (the command requires that declaration); it is never guessed. Always NULL for public_form and prospect_link, whose sms_consent_at is the agreement itself.';

comment on function public.record_waitlist_sms_consent_by_practitioner(uuid, uuid, uuid, text, text, boolean, date) is
  'A studio owner records SMS consent a waitlist prospect gave outside Hone (0208). Membership and owner role re-derived from p_actor_user_id. Refuses opted_out, already_consented (existing evidence is never replaced), no_phone, not_active (removed or converted). Writes source practitioner, recorder, scope, evidence, the recording instant, and the consent day or an explicit unknown. service_role only; the phone-wide STOP check is the caller''s, before calling.';

comment on function public.join_new_client_waitlist_with_sms_answer(uuid, text, text, text, boolean, boolean) is
  'The public signup with an explicit SMS answer (0208). NULL answer refuses invalid_input. Wraps join_new_client_waitlist_guarded unchanged; a Yes on a newly created entry records public_form / waitlist_sms_operational_v1 in the same transaction; No and already_waiting record nothing. service_role only.';

commit;
