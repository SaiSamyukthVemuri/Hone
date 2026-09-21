-- ===========================================================================
-- WAIT-04B — DURABLE PROSPECT PROFILE AND SMS CONSENT AUTHORITY — 0202
-- ===========================================================================
--
-- WHAT THIS IS. The waitlist entry can hold a name, an email, a phone and a
-- lifecycle. WAIT-04A shipped the reviewed vocabulary for a richer prospect
-- profile -- separate names, treatment areas, an availability preference and an
-- explicit SMS consent -- as PURE TYPES with no place to put any of it. This
-- migration is the place.
--
-- IT ACTIVATES NOTHING. Every column added here is NULL for every existing row
-- and NULL for every row any shipped path can create. The four commands below
-- are granted to service_role and called by NOTHING: the public join still runs
-- `join_new_client_waitlist`, the two WAIT-04A surfaces are still unreachable
-- from `app/`, and the inbound STOP route still stamps `clients` alone. The
-- bindings are separate children.
--
-- ---------------------------------------------------------------------------
-- WHY THE COMMANDS ARE HERE AND NOT WITH THEIR CALLERS
-- ---------------------------------------------------------------------------
--
-- 0185:556-558 revokes ALL privileges on this table from public, anon,
-- authenticated and service_role, and grants back only SELECT to authenticated:
--
--     revoke all on public.new_client_waitlist_entries
--       from public, anon, authenticated, service_role;
--     grant select on public.new_client_waitlist_entries to authenticated;
--
-- service_role therefore holds NEITHER SELECT NOR DML. An application cannot
-- read these columns and cannot write them; only a SECURITY DEFINER command
-- can. A columns-only migration would ship a path that fails at the privilege
-- layer, and per CLAUDE.md that failure "looks exactly like an application
-- bug". So the columns and the only writers that may touch them land together.
--
-- ---------------------------------------------------------------------------
-- WHAT IS NOT ADDED, AND WHY
-- ---------------------------------------------------------------------------
--
-- NO `availability_preference` COLUMN. 0193's
-- `new_client_waitlist_entry_preferences` already owns a stated preference, its
-- vocabulary already equals the shipped `AVAILABILITY_PREFERENCES`, and its
-- `source` check already permits 'public_form' with the practitioner id forced
-- NULL. A column here would be a second authority for one fact.
--
-- NO `mobile` COLUMN. The entry already has `phone`. A second contact column is
-- not a tidier name, it is the defect: a legacy row holding `phone` and a NULL
-- `mobile` reads as HAVING NO NUMBER, so a completion link could write one for
-- someone the studio already has a number for -- which is the redirect
-- `ProfileCompletionPatch` exists to make unexpressible. One column. The
-- product vocabulary calls it "mobile" and the adapter renames it at its
-- boundary, exactly as `prospectSuppressionCandidate` already renames in the
-- other direction.
--
-- NO BACKFILL. Every legacy row keeps NULL in all nine columns, which reads as
-- PROFILE_INCOMPLETE, which is the honest answer: Hone never asked those
-- questions. `joined_at` and `joined_at_provenance` are not read, not written
-- and not defaulted anywhere in this file.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. COLUMNS. Nine, all nullable, no DEFAULT -- catalog-only, no table rewrite.
-- ---------------------------------------------------------------------------

alter table public.new_client_waitlist_entries
  add column if not exists first_name               text,
  add column if not exists last_name                text,
  add column if not exists treatment_area_ids       text[],
  add column if not exists sms_consent_at           timestamptz,
  add column if not exists sms_consent_source       text,
  add column if not exists sms_consent_text_version text,
  add column if not exists sms_opted_out_at         timestamptz,
  add column if not exists sms_opt_out_source       text,
  add column if not exists mobile_verified_at       timestamptz;

-- ---------------------------------------------------------------------------
-- 2. CONSTRAINTS
-- ---------------------------------------------------------------------------

alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_first_name_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_first_name_check
  check (first_name is null or length(btrim(first_name)) between 1 and 60);

alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_last_name_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_last_name_check
  check (last_name is null or length(btrim(last_name)) between 1 and 60);

-- TREATMENT AREAS ARE CATALOG IDS, NEVER LABELS. A label may be re-worded; an
-- id may not be re-pointed. The catalog is restated here rather than imported
-- because the database re-checks INDEPENDENTLY of the application -- the same
-- layering the shipped join already uses -- and
-- `tests/lib/waitlist/...` pins this list against `TREATMENT_AREA_IDS` so the
-- two copies cannot drift.
--
-- `<@` ALSO REJECTS A NULL MEMBER, because array containment treats NULL as
-- equal to nothing. That is asserted by test rather than assumed here.
alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_treatment_area_ids_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_treatment_area_ids_check
  check (
    treatment_area_ids is null
    or (
      cardinality(treatment_area_ids) between 1 and 21
      and treatment_area_ids <@ array[
        'upper_lip','chin','jawline','cheeks','sideburns','eyebrows','full_face',
        'neck','ears','chest','abdomen','back','underarms','forearms','hands',
        'thighs','lower_legs','feet','bikini','brazilian','buttocks'
      ]::text[]
    )
  );

-- CONSENT VOCABULARY, mirroring lib/waitlist/prospect-sms-consent.ts.
alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_sms_consent_source_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_sms_consent_source_check
  check (sms_consent_source is null
         or sms_consent_source in ('public_form', 'practitioner', 'prospect_link'));

alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_sms_consent_text_version_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_sms_consent_text_version_check
  check (sms_consent_text_version is null
         or sms_consent_text_version = 'waitlist_sms_operational_v1');

alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_sms_opt_out_source_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_sms_opt_out_source_check
  check (sms_opt_out_source is null
         or sms_opt_out_source in ('twilio_stop', 'practitioner'));

-- CONSENT EVIDENCE IS ALL-OR-NOTHING, the shape 0185 already uses for removal
-- evidence. A consent instant without its source or its text version is an
-- agreement to nothing in particular, and a DECLINE writes three NULLs rather
-- than a timestamped false -- there is exactly one way to represent "may we
-- text this person", and a reader checking the column for presence must not be
-- able to mistake a refusal for one.
alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_sms_consent_evidence_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_sms_consent_evidence_check
  check (
    (sms_consent_at is null and sms_consent_source is null
       and sms_consent_text_version is null)
    or
    (sms_consent_at is not null and sms_consent_source is not null
       and sms_consent_text_version is not null)
  );

alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_sms_opt_out_evidence_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_sms_opt_out_evidence_check
  check (
    (sms_opted_out_at is null and sms_opt_out_source is null)
    or
    (sms_opted_out_at is not null and sms_opt_out_source is not null)
  );

-- A VERIFICATION WITHOUT A NUMBER IS UNREPRESENTABLE. Permanent, not
-- slice-scoped: it stays true after a verification mechanism exists.
alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_mobile_verified_requires_number_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_mobile_verified_requires_number_check
  check (mobile_verified_at is null or phone is not null);

-- ---------------------------------------------------------------------------
-- 3. THE NAME BUDGET. 120 -> 121, and the arithmetic is the whole reason.
-- ---------------------------------------------------------------------------
--
-- PROFILE_FIRST_NAME_MAX + one separator + PROFILE_LAST_NAME_MAX = 60 + 1 + 60
-- = 121. The shipped bound is 120, so a maximal 60/60 name composes to a string
-- the INSERT would refuse. Truncating would fabricate a name; widening by
-- exactly one character does not loosen anything else.
--
-- `phone`'s OWN CHECK IS DELIBERATELY UNTOUCHED. It is
-- `check (phone is null or length(btrim(phone)) between 1 and 40)` and it stays
-- that. The tempting tidy is to add the seven-digit floor the profile
-- vocabulary uses; it would fail validation against legacy rows holding an
-- imported "n/a", an "ask", or a landline typed short, and it would
-- retroactively invalidate values a studio entered on purpose. The floor
-- belongs in the COMMANDS, which govern only new writes.
alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_name_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_name_check
  check (length(btrim(name)) between 1 and 121);

-- ---------------------------------------------------------------------------
-- 4. THE TRANSITION GUARD, re-created.
-- ---------------------------------------------------------------------------
--
-- CARRIED OVER VERBATIM FROM 0190: the identity freeze, the legal-transition
-- graph, the per-transition allowed-delta map with its fail-closed
-- `else array[]::text[]`, and the status-unchanged lifecycle freeze. Only the
-- contact-detail clause changes, and four rules are added.
--
-- WHY THE NEW COLUMNS NEED THE GUARD AT ALL. Its status-unchanged branch names
-- only lifecycle columns, so a column added today would be silently mutable on
-- any status-unchanged UPDATE. The privilege wall means only a SECURITY DEFINER
-- command can issue that UPDATE -- but 0190 exists BECAUSE exactly this kind of
-- "the guard did not name it" gap shipped once already.
--
-- first_name, last_name and treatment_area_ids get NO rule, and that is a
-- decision rather than an oversight: no safety property attaches to correcting
-- a spelling, the capability layer bounds who may do it, and an owner
-- correction command will want them writable.

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

  -- VERIFICATION HAS NO WRITER IN THIS RELEASE. A candidate is not a
  -- destination, and the promotion must be a change a reviewer sees. THE
  -- VERIFICATION SLICE AMENDS THIS CLAUSE; that is why it is here rather than
  -- left to a convention.
  if new.mobile_verified_at is distinct from old.mobile_verified_at then
    raise exception
      'new_client_waitlist_entries: mobile_verified_at has no writer in this release'
      using errcode = 'check_violation';
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

-- The TRIGGER itself is not re-created; only the function body above is
-- replaced, exactly as 0190 did.

-- ---------------------------------------------------------------------------
-- 5. COMMAND — A NEW PROSPECT JOINS WITH A FULL PROFILE
-- ---------------------------------------------------------------------------
--
-- A SECOND COMMAND, NOT A WIDENED ONE. `join_new_client_waitlist(uuid, text,
-- text, text)` keeps its exact shape for every studio not on the profile
-- surface, so that path cannot regress while this one is being reviewed.
--
-- NO `p_consent_source` AND NO `p_consented_at`. The source is a fact about
-- WHICH FUNCTION RAN -- this one is reachable only from the public form -- and
-- the instant is the database clock read inside the statement. A
-- browser-supplied or server-process time is evidence of nothing, and an
-- agreement and its timestamp must commit together or not at all. Both
-- omissions make a misreport unexpressible rather than merely validated.
--
-- THE MOBILE ARRIVES AS A CANDIDATE AND IS STORED AS ONE. `mobile_verified_at`
-- is not in the INSERT column list. Structurally, not by policy: the public
-- form proves no possession of the number typed into it, and treating a
-- join-supplied number as verified would relocate the wrong-recipient defect
-- rather than remove it -- anyone can enrol a victim's name and email against a
-- phone they control.
create or replace function public.join_new_client_waitlist_with_profile(
  p_studio_id          uuid,
  p_first_name         text,
  p_last_name          text,
  p_email              text,
  p_mobile             text,
  p_treatment_area_ids text[],
  p_preference         text,
  p_sms_consent        boolean
)
returns table (result text, entry_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  c_max_attempts constant integer := 2;
  c_areas constant text[] := array[
    'upper_lip','chin','jawline','cheeks','sideburns','eyebrows','full_face',
    'neck','ears','chest','abdomen','back','underarms','forearms','hands',
    'thighs','lower_legs','feet','bikini','brazilian','buttocks'
  ];

  v_first    text := btrim(coalesce(p_first_name, ''));
  v_last     text := btrim(coalesce(p_last_name, ''));
  v_email    text := lower(btrim(coalesce(p_email, '')));
  v_mobile   text := btrim(coalesce(p_mobile, ''));
  v_in       text[] := coalesce(p_treatment_area_ids, array[]::text[]);
  v_name     text;
  v_areas    text[];
  v_distinct integer;
  v_id       uuid;
  v_now      timestamptz;
  v_attempt  integer := 0;
begin
  -- BOUNDED INPUT FIRST, so junk never reaches a lookup or an index. These
  -- re-state the shipped TypeScript bounds because client validation is a
  -- courtesy that saves a round trip, never the authority.
  if v_first = '' or length(v_first) > 60
     or v_last = '' or length(v_last) > 60
     or v_email = '' or length(v_email) > 254
     or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or v_mobile = '' or length(v_mobile) > 40
     or length(regexp_replace(v_mobile, '[^0-9]', '', 'g')) < 7
     or p_sms_consent is null
     or p_preference is null
     or p_preference not in ('weekdays', 'weekends', 'both') then
    return query select 'invalid_input'::text, null::uuid;
    return;
  end if;

  v_name := v_first || ' ' || v_last;

  -- AREAS: CANONICALIZE FROM THE CATALOG, THEN REFUSE RATHER THAN NARROW.
  -- Filtering the catalog by the submission dedupes and orders in one
  -- expression; comparing the result against the count of DISTINCT submitted
  -- values is what turns "we dropped the ones we did not recognise" into a
  -- refusal. A submission naming a retired or invented area is an error, not a
  -- shorter list -- an invitation composed from a silently narrowed list would
  -- be composed from something the prospect did not choose.
  -- REFUSE RATHER THAN NARROW. `= any` silently drops a NULL member, so
  -- array['chin', null] would have been accepted AS array['chin'] -- a shorter
  -- treatment list than the person submitted, recorded as though it were theirs.
  if array_position(v_in, null) is not null then
    return query select 'invalid_input'::text, null::uuid;
    return;
  end if;

  select array_agg(c.id order by c.ord) into v_areas
    from unnest(c_areas) with ordinality as c(id, ord)
   where c.id = any (v_in);

  select count(distinct x) into v_distinct
    from unnest(v_in) as x where x is not null;

  if v_areas is null
     or cardinality(v_areas) = 0
     or cardinality(v_areas) <> v_distinct then
    return query select 'invalid_input'::text, null::uuid;
    return;
  end if;

  -- A studio id that no longer exists must come back as a CLOSED RESULT CODE
  -- rather than a foreign-key exception: an exception is indistinguishable from
  -- "the insert may have committed", and the caller would have to report an
  -- unconfirmed outcome for a request that certainly did not land.
  if p_studio_id is null
     or not exists (select 1 from public.studios s where s.id = p_studio_id) then
    return query select 'studio_not_found'::text, null::uuid;
    return;
  end if;

  while v_attempt < c_max_attempts loop
    v_attempt := v_attempt + 1;
    v_id := null;
    v_now := clock_timestamp();

    insert into public.new_client_waitlist_entries
      (studio_id, name, email, phone, first_name, last_name, treatment_area_ids,
       sms_consent_at, sms_consent_source, sms_consent_text_version)
    values
      (p_studio_id, v_name, v_email, v_mobile, v_first, v_last, v_areas,
       case when p_sms_consent then v_now end,
       case when p_sms_consent then 'public_form' end,
       case when p_sms_consent then 'waitlist_sms_operational_v1' end)
    on conflict (studio_id, email_normalized) where status = 'waiting'
    do nothing
    returning id into v_id;

    if v_id is not null then
      -- The preference row rides the SAME transaction. A profile that recorded
      -- everything except the availability answer is a partial write wearing a
      -- success code.
      insert into public.new_client_waitlist_entry_preferences
        (entry_id, studio_id, preference, stated_at, confirmed_at, source,
         recorded_by_practitioner_id)
      values (v_id, p_studio_id, p_preference, v_now, v_now, 'public_form', null);

      return query select 'created'::text, v_id;
      return;
    end if;

    select e.id into v_id
      from public.new_client_waitlist_entries e
     where e.studio_id        = p_studio_id
       and e.email_normalized = v_email
       and e.status           = 'waiting'
     limit 1;

    if v_id is not null then
      -- ALREADY WAITING WRITES NOTHING AT ALL -- not the profile, not the
      -- preference, not the consent. A public unauthenticated form that could
      -- overwrite an existing entry from a known address is a profile-overwrite
      -- oracle, and re-stamping `sms_consent_at` would move the recorded
      -- instant of an agreement that happened once.
      return query select 'already_waiting'::text, v_id;
      return;
    end if;
  end loop;

  return query select 'unknown'::text, null::uuid;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. COMMAND — A LEGACY PROSPECT COMPLETES THE FIELDS THAT DID NOT EXIST
-- ---------------------------------------------------------------------------
--
-- REDEEMS 0193's EXISTING GRANT. No second grant type and no `purpose` column:
-- profile completion is a strict superset of the availability redemption, it
-- writes the same preference row with source 'prospect_link', and it consumes
-- the same one-live-per-entry grant.
--
-- MUST NOT TOUCH `joined_at`. There is no parameter for it and the guard
-- forbids it. Answering a question Hone added later cannot cost someone their
-- place, and that is the single most important invariant in the slice.
--
-- NO `p_consent_source`: a completion reached through a preference grant is
-- 'prospect_link' by construction.
create or replace function public.complete_waitlist_profile_by_grant(
  p_raw_token          text,
  p_first_name         text,
  p_last_name          text,
  p_treatment_area_ids text[],
  p_preference         text,
  p_mobile_candidate   text,
  p_sms_consent        boolean
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  c_areas constant text[] := array[
    'upper_lip','chin','jawline','cheeks','sideburns','eyebrows','full_face',
    'neck','ears','chest','abdomen','back','underarms','forearms','hands',
    'thighs','lower_legs','feet','bikini','brazilian','buttocks'
  ];

  v_hash     text;
  v_entry    uuid;
  v_studio   uuid;
  v_grant    record;
  v_now      timestamptz;
  v_first    text := btrim(coalesce(p_first_name, ''));
  v_last     text := btrim(coalesce(p_last_name, ''));
  v_cand     text := nullif(btrim(coalesce(p_mobile_candidate, '')), '');
  v_in       text[] := coalesce(p_treatment_area_ids, array[]::text[]);
  v_areas    text[];
  v_distinct integer;
  v_entry_row record;
  v_pref     text;
  -- WHY THIS BOOLEAN EXISTS RATHER THAN A BARE `found`.
  -- `found` reflects the MOST RECENT statement, and two reads sit between the
  -- grant re-resolve and the branch below. Reading `found` there asked "does a
  -- preference row exist", which is a different question with the same spelling:
  -- a legacy entry (no preference row) took the replay branch and was refused,
  -- and an entry that HAD one skipped the replay branch on an expired, revoked
  -- or already-spent token and wrote anyway. Capturing the answer on the next
  -- line makes the branch independent of what is read after it.
  v_grant_found boolean;
begin
  if p_raw_token is null or p_sms_consent is null then
    return 'refused';
  end if;

  v_hash := encode(extensions.digest(p_raw_token, 'sha256'), 'hex');

  -- STEP 1: an UNLOCKED read, for one purpose only -- to learn WHICH studio and
  -- entry this token belongs to, so the canonical locks can be taken in order.
  -- Nothing is decided here and no clock is read yet.
  select g.entry_id, g.studio_id into v_entry, v_studio
    from public.new_client_waitlist_preference_grants g
   where g.token_hash = v_hash;
  if v_entry is null then return 'refused'; end if;

  -- STEP 2: CANONICAL LOCK ORDER, STUDIO -> ENTRY, the same order
  -- admit_new_client_waitlist_entry, issue_ and redeem_ all take.
  perform 1 from public.studios s where s.id = v_studio for no key update;
  perform 1 from public.new_client_waitlist_entries e
   where e.id = v_entry for update;

  -- STEP 3: READ THE CLOCK ONLY NOW, AFTER THE LOCKS. This transaction can wait
  -- on the entry lock for an unbounded time, and a grant that was live when the
  -- wait began can expire during it. A pre-lock timestamp makes the expiry
  -- re-check pass on evidence that is already stale.
  v_now := clock_timestamp();

  -- Validate the submission. Never names which field: the surface renders one
  -- message for every refusal.
  if v_first = '' or length(v_first) > 60
     or v_last = '' or length(v_last) > 60
     or p_preference is null
     or p_preference not in ('weekdays', 'weekends', 'both') then
    return 'invalid_submission';
  end if;

  if v_cand is not null
     and (length(v_cand) > 40
          or length(regexp_replace(v_cand, '[^0-9]', '', 'g')) < 7) then
    return 'invalid_submission';
  end if;

  -- REFUSE RATHER THAN NARROW. `= any` silently drops a NULL member, so
  -- array['chin', null] would have been accepted AS array['chin'] -- a shorter
  -- treatment list than the person submitted, recorded as though it were theirs.
  if array_position(v_in, null) is not null then
    return 'invalid_submission';
  end if;

  select array_agg(c.id order by c.ord) into v_areas
    from unnest(c_areas) with ordinality as c(id, ord)
   where c.id = any (v_in);
  select count(distinct x) into v_distinct
    from unnest(v_in) as x where x is not null;
  if v_areas is null
     or cardinality(v_areas) = 0
     or cardinality(v_areas) <> v_distinct then
    return 'invalid_submission';
  end if;

  -- STEP 4: re-resolve the grant UNDER the locks, with the full validity
  -- predicate and the post-lock clock. THE ENTRY'S LIFECYCLE IS PART OF THAT
  -- PREDICATE: removal moves the entry to `removed` without touching the grant,
  -- whose own columns stay perfectly valid, so a link issued while the prospect
  -- was waiting would otherwise stay redeemable after the owner removed them.
  -- `removed` and `converted` are the two states with no outgoing transition.
  select g.id, g.entry_id, g.studio_id
    into v_grant
    from public.new_client_waitlist_preference_grants g
    join public.new_client_waitlist_entries e
      on e.id = g.entry_id and e.studio_id = g.studio_id
   where g.token_hash  = v_hash
     and g.redeemed_at is null
     and g.revoked_at  is null
     and g.expires_at  > v_now
     and e.status not in ('removed', 'converted')
   for update of g;
  v_grant_found := found;   -- MUST stay on the line after the select above.

  select e.first_name, e.last_name, e.treatment_area_ids, e.phone,
         e.sms_consent_at
    into v_entry_row
    from public.new_client_waitlist_entries e
   where e.id = v_entry;

  select p.preference into v_pref
    from public.new_client_waitlist_entry_preferences p
   where p.entry_id = v_entry;

  if not v_grant_found then
    -- STEP 4a: IDEMPOTENT REPLAY, AND ONLY THAT.
    --
    -- 0193's grant is single-use, so a person who taps twice on a slow
    -- connection would otherwise get `accepted` then `refused` -- rendered as
    -- "not authorised", for doing nothing wrong. When the token resolves but
    -- the grant is spent, and the entry ALREADY HOLDS exactly what was
    -- submitted, this is that second tap.
    --
    -- IT WRITES NOTHING, which is the load-bearing half: a replay must not
    -- re-stamp `sms_consent_at`, must not move the preference row's
    -- `confirmed_at`, and must not bump `updated_at`. A DIFFERENT submission on
    -- a spent grant is refused exactly as an unknown token is.
    if exists (
      select 1 from public.new_client_waitlist_preference_grants g
       where g.token_hash  = v_hash
         and g.redeemed_at is not null
         and g.revoked_at  is null
    )
    and v_entry_row.first_name         is not distinct from v_first
    and v_entry_row.last_name          is not distinct from v_last
    and v_entry_row.treatment_area_ids is not distinct from v_areas
    and v_pref                         is not distinct from p_preference
    and (v_cand is null or v_entry_row.phone is not distinct from v_cand)
    -- AND THE CONSENT ANSWER, which is the one field a replay can legitimately
    -- differ on: a person who ticked the box on the second tap has NOT already
    -- been recorded, so reporting `accepted` while writing nothing would claim a
    -- consent that does not exist. Ticking requires consent to be on the row;
    -- not ticking is a no-op under STEP 5 and is therefore always satisfied.
    and (not p_sms_consent or v_entry_row.sms_consent_at is not null) then
      return 'accepted';
    end if;
    return 'refused';
  end if;

  -- STEP 5: THE MOBILE ARM IS DECIDED BY THE ROW, NEVER BY THE SUBMISSION.
  -- A forged post can always claim the wrong one. An entry that already holds a
  -- number and a submission carrying a candidate is an attempted REPLACEMENT --
  -- the finding this shape closes -- and it is refused outright rather than
  -- ignored, because ignoring it would report success for a write that did not
  -- happen.
  if v_cand is not null and v_entry_row.phone is not null then
    return 'refused';
  end if;

  -- AND THE OTHER ARM: no candidate supplied and none on file. `mobile` is a
  -- required field of `assessProfileCompleteness`, so accepting this would spend
  -- the single-use grant on a write that leaves the profile PROFILE_INCOMPLETE
  -- and the prospect with no second link -- permanently unable to finish. It is
  -- a deficient SUBMISSION, so it is refused the way a deficient submission is,
  -- leaving the grant live for the retry.
  if v_cand is null and v_entry_row.phone is null then
    return 'invalid_submission';
  end if;

  update public.new_client_waitlist_entries e
     set first_name         = v_first,
         last_name          = v_last,
         treatment_area_ids = v_areas,
         -- Written only when the entry held none. `mobile_verified_at` is NOT
         -- in this SET list: nothing a bearer link supplies may verify itself.
         phone              = case when v_cand is not null then v_cand else e.phone end,
         -- CONSENT IS EVIDENCE OF AN ACT AT A TIME, so this command may only
         -- ever ADD it. Writing the three columns unconditionally re-stamped
         -- `sms_consent_at` for someone who had already consented -- moving
         -- evidence the join command refuses to move -- and silently NULLED all
         -- three when the box was left unticked, erasing a consent through a
         -- surface that is not a withdrawal surface. Withdrawal has its own
         -- path: `sms_opted_out_at`, which the guard makes terminal.
         sms_consent_at           = case when p_sms_consent and e.sms_consent_at is null
                                         then v_now else e.sms_consent_at end,
         sms_consent_source       = case when p_sms_consent and e.sms_consent_at is null
                                         then 'prospect_link' else e.sms_consent_source end,
         sms_consent_text_version = case when p_sms_consent and e.sms_consent_at is null
                                         then 'waitlist_sms_operational_v1'
                                         else e.sms_consent_text_version end
   where e.id = v_entry;

  if v_pref is null then
    insert into public.new_client_waitlist_entry_preferences
      (entry_id, studio_id, preference, stated_at, confirmed_at, source,
       recorded_by_practitioner_id)
    values (v_entry, v_studio, p_preference, v_now, v_now, 'prospect_link', null);
  elsif v_pref = p_preference then
    update public.new_client_waitlist_entry_preferences
       set confirmed_at = v_now, source = 'prospect_link',
           recorded_by_practitioner_id = null
     where entry_id = v_entry;
  else
    update public.new_client_waitlist_entry_preferences
       set preference = p_preference, stated_at = v_now, confirmed_at = v_now,
           source = 'prospect_link', recorded_by_practitioner_id = null
     where entry_id = v_entry;
  end if;

  update public.new_client_waitlist_preference_grants
     set redeemed_at = v_now
   where id = v_grant.id;

  return 'accepted';
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. COMMANDS — PROSPECT SUPPRESSION (the STOP path's two halves)
-- ---------------------------------------------------------------------------
--
-- NEITHER FUNCTION MATCHES A PHONE, and that is the design rather than an
-- omission. Matching lives in TypeScript, in `selectHoneSuppressionTargets`,
-- because there is no SQL equivalent of `normalizePhoneForMatch` -- the only SQL
-- normalizer that exists, 0199's `sms_normalized_phone`, is the SEND normalizer
-- (E.164 or NULL) and using it to match would NARROW a STOP, missing exactly
-- the stored values the match normalizer's digit-strip fallback exists to
-- catch. The database hands out candidates; the one law selects; the database
-- stamps by id.
--
-- CALLED BY NOTHING IN THIS MIGRATION'S RELEASE. The inbound route still sweeps
-- `clients` alone.

-- The read. No studio parameter, no `to`, no lifecycle filter, no matching.
-- Returns exactly `SuppressionCandidate` and nothing else about the person: no
-- name, no email, no treatment areas.
--
-- NO LIFECYCLE FILTER IS DELIBERATE. A STOP is a statement about a PHONE, not
-- about a queue position, so a `removed` or `converted` entry whose number
-- matches is still stamped. Filtering by status would be narrowing by another
-- name.
create or replace function public.waitlist_prospect_suppression_candidates()
returns table (id uuid, studio_id uuid, phone text, sms_opted_out_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select e.id, e.studio_id, e.phone, e.sms_opted_out_at
    from public.new_client_waitlist_entries e
   where e.phone is not null;
$$;

-- The stamp. BY ID ONLY -- the ids come from the one TypeScript law.
--
-- Named `suppress_waitlist_prospects`, not `..._by_phone`: a phone parameter
-- would force SQL to match, so the narrowing parameter is not there to be
-- passed.
--
-- `sms_opt_out_source` is a LITERAL, not a parameter. This command only ever
-- runs for an inbound STOP, so 'twilio_stop' is a fact about which function
-- ran. `p_opted_at` IS a parameter, and that is a considered exception to the
-- database-clock rule above: a consent instant is evidence of an agreement,
-- whereas an opt-out instant carries no authority at all -- every gate tests
-- the column for PRESENCE, never for its value -- and passing it lets one STOP
-- stamp clients and prospects with one instant, so the event stays
-- reconstructible as one event.
create or replace function public.suppress_waitlist_prospects(
  p_entry_ids uuid[],
  p_opted_at  timestamptz
)
returns table (stamped_id uuid)
language sql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
  update public.new_client_waitlist_entries e
     set sms_opted_out_at   = p_opted_at,
         sms_opt_out_source = 'twilio_stop'
   where e.id = any (coalesce(p_entry_ids, array[]::uuid[]))
     and p_opted_at is not null
     and e.sms_opted_out_at is null   -- retry-dedup, mirroring the client path
  returning e.id;
$$;

-- ---------------------------------------------------------------------------
-- 8. PRIVILEGES
-- ---------------------------------------------------------------------------
--
-- Literal statements, never a DO-block with format(), because the grant guards
-- read them textually. All four grantees revoked BY NAME first: ALTER DEFAULT
-- PRIVILEGES arms anon, authenticated AND service_role at function-create time,
-- which is the 0129/0164 trap.
--
-- NO TABLE PRIVILEGE IS GRANTED TO ANYONE. The wall 0185 built stands: a
-- SECURITY DEFINER function executes as its owner and needs none.

revoke execute on function public.join_new_client_waitlist_with_profile(uuid, text, text, text, text, text[], text, boolean) from public;
revoke execute on function public.join_new_client_waitlist_with_profile(uuid, text, text, text, text, text[], text, boolean) from anon;
revoke execute on function public.join_new_client_waitlist_with_profile(uuid, text, text, text, text, text[], text, boolean) from authenticated;
revoke execute on function public.join_new_client_waitlist_with_profile(uuid, text, text, text, text, text[], text, boolean) from service_role;

revoke execute on function public.complete_waitlist_profile_by_grant(text, text, text, text[], text, text, boolean) from public;
revoke execute on function public.complete_waitlist_profile_by_grant(text, text, text, text[], text, text, boolean) from anon;
revoke execute on function public.complete_waitlist_profile_by_grant(text, text, text, text[], text, text, boolean) from authenticated;
revoke execute on function public.complete_waitlist_profile_by_grant(text, text, text, text[], text, text, boolean) from service_role;

revoke execute on function public.waitlist_prospect_suppression_candidates() from public;
revoke execute on function public.waitlist_prospect_suppression_candidates() from anon;
revoke execute on function public.waitlist_prospect_suppression_candidates() from authenticated;
revoke execute on function public.waitlist_prospect_suppression_candidates() from service_role;

revoke execute on function public.suppress_waitlist_prospects(uuid[], timestamptz) from public;
revoke execute on function public.suppress_waitlist_prospects(uuid[], timestamptz) from anon;
revoke execute on function public.suppress_waitlist_prospects(uuid[], timestamptz) from authenticated;
revoke execute on function public.suppress_waitlist_prospects(uuid[], timestamptz) from service_role;

grant execute on function public.join_new_client_waitlist_with_profile(uuid, text, text, text, text, text[], text, boolean) to service_role;
grant execute on function public.complete_waitlist_profile_by_grant(text, text, text, text[], text, text, boolean) to service_role;
grant execute on function public.waitlist_prospect_suppression_candidates() to service_role;
grant execute on function public.suppress_waitlist_prospects(uuid[], timestamptz) to service_role;

-- The transition guard runs only as the table owner through its trigger and is
-- granted to no application role.
revoke execute on function public.new_client_waitlist_entries_transition_guard() from public;
revoke execute on function public.new_client_waitlist_entries_transition_guard() from anon;
revoke execute on function public.new_client_waitlist_entries_transition_guard() from authenticated;
revoke execute on function public.new_client_waitlist_entries_transition_guard() from service_role;

-- ---------------------------------------------------------------------------
-- 9. COLUMN COMMENTS
-- ---------------------------------------------------------------------------

comment on column public.new_client_waitlist_entries.first_name is
  'Given name, collected separately from the family name by the WAIT-04A join surface. NULL on every legacy row and never derived from `name`: splitting a combined name guesses which part is which, and a guess about a person''s name is a statement Hone has no basis for. `assessProfileCompleteness` reads NULL here as PROFILE_INCOMPLETE, which is the honest answer to a question that was never asked.';

comment on column public.new_client_waitlist_entries.last_name is
  'Family name. See `first_name`: NULL on every legacy row, never split out of `name`.';

comment on column public.new_client_waitlist_entries.treatment_area_ids is
  'Catalog IDS, never labels -- a label may be re-worded, an id may not be re-pointed. Constrained against the frozen 21-value catalog in lib/waitlist/treatment-area-catalog.ts, which the commands restate so the database re-checks independently of the application. Stored canonically ordered and duplicate-free by the commands; a submission naming an unknown area is REFUSED rather than silently narrowed, because an invitation composed from a narrowed list is composed from something the prospect did not choose.';

comment on column public.new_client_waitlist_entries.phone is
  'The single durable contact number for this prospect, and a CANDIDATE in every case: the public join form, a practitioner-entered enquiry, a legacy import and a bearer completion link all record a number somebody typed, and none of them proves it reaches this person. Reachability is `mobile_verified_at`, a separate fact with a separate proof and, in this release, no writer at all. The product vocabulary calls this "mobile" and the adapter renames it at its boundary; THERE IS DELIBERATELY NO SECOND COLUMN, because a `mobile` beside this one would read as ABSENT for every legacy row that already holds a number here, letting a completion link write a number for someone the studio already has one for.';

comment on column public.new_client_waitlist_entries.sms_consent_at is
  'The INSTANT the prospect agreed to operational SMS, stamped from the database clock inside the same statement as the agreement. NULL means "never agreed" and NEVER "declined at": a decline writes all three consent columns NULL, because there is exactly one way to represent "may we text this person" and a timestamped refusal would be indistinguishable from agreement to any reader checking the column for presence.';

comment on column public.new_client_waitlist_entries.sms_consent_source is
  'Where the agreement was collected: public_form | practitioner | prospect_link. A fact about which command ran, never a value the browser supplies.';

comment on column public.new_client_waitlist_entries.sms_consent_text_version is
  'Which wording was agreed to, pinned to waitlist_sms_operational_v1. Consent is to a specific sentence about a specific purpose; widening the purpose requires a new version, not a reinterpretation of an old agreement.';

comment on column public.new_client_waitlist_entries.sms_opted_out_at is
  'When this person said STOP. TERMINAL: the transition guard refuses any statement that clears, re-times or re-attributes it, so a later consent cannot resurrect sendability. Opt-out dominates consent at every gate.';

comment on column public.new_client_waitlist_entries.sms_opt_out_source is
  'Who ended it: twilio_stop | practitioner. Same vocabulary clients.sms_opt_out_source already uses, so a prospect who becomes a client is reconciled rather than translated.';

comment on column public.new_client_waitlist_entries.mobile_verified_at is
  'When `phone` was PROVEN to reach this person, or NULL. Separate from the number itself because "we hold a string" and "texts sent there arrive with the right person" are different facts and only the second may authorise a send. NO WRITER EXISTS IN THIS RELEASE and the transition guard refuses any change to it, so it is NULL for every row: `prospectMayReceiveSms` therefore refuses every prospect send, which is the correct standing behaviour rather than a gap. The verification slice amends that guard clause, which is a change a reviewer sees.';

commit;
