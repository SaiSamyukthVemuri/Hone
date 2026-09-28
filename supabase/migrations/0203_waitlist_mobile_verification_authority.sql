-- ===========================================================================
-- 0203 — WAITLIST MOBILE VERIFICATION AUTHORITY
-- ===========================================================================
--
-- CANDIDATE, NOT APPLIED. Authored against production 4e8ea7ae with the
-- canonical derivation run fresh at authoring time: repo max 0202, hosted max
-- 0202, pending none, next free 0203. The number is claimed from that evidence
-- rather than from an earlier slice's note that "0203 is free".
--
-- WHAT THIS ADDS, AND NOTHING ELSE:
--   1. ONE narrow authority that promotes new_client_waitlist_entries.
--      mobile_verified_at from NULL to a DATABASE-CLOCK instant, and only after
--      the caller proves the phone it verified is the phone the row stores.
--   2. The guard clause 0202 explicitly said this slice would amend.
--
-- WHAT IT DOES NOT ADD: any send path, any provider call, any general DML, any
-- change to joined_at, queue position, consent, opt-out, name, email or the
-- stored mobile itself. 0185's privilege wall is untouched; no role gains DML.
--
-- THE STANDING THIS ENFORCES, restated because the whole slice turns on it:
--   candidate != verified · stored != verified · consent != verified ·
--   operator assertion != verified · profile completion != verified
--
-- A number the prospect typed is a CANDIDATE. Only a completed possession proof
-- for that same number makes it a destination, and the instant recorded is the
-- database's, never a browser's or a server process's.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. THE TRANSITION GUARD, CARRIED FROM 0202 WITH ONE CLAUSE AMENDED
-- ---------------------------------------------------------------------------
--
-- Carried VERBATIM apart from the mobile_verified_at clause. The body is
-- reproduced in full rather than patched, because `create or replace function`
-- replaces the whole body and a partial edit would silently drop every rule it
-- did not mention. tests/migrations/0203-* asserts the carried rules are still
-- present, so a future edit cannot lose the identity freeze, the one-way mobile
-- rule, the terminal opt-out or the lifecycle delta map by omission.

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
-- 2. THE ONE WRITER
-- ---------------------------------------------------------------------------
--
-- COMPARE-AND-SET ON THE EXACT STORED STRING, AND NO PHONE NORMALIZATION IN SQL.
--
-- The first draft of this command took the proved phone and compared digits.
-- That was wrong, and validating against a real database is what proved it: a
-- stored "647-555-1234" reduces to 6475551234 while an E.164 "+16475551234"
-- reduces to 16475551234, so the command REFUSED a legitimate proof for the very
-- same number. The application's `normalizePhoneForMatch` canonicalizes to E.164
-- first and gets 16475551234 for both.
--
-- Mirroring that canonicalization here would create the second phone normalizer
-- 0202 explicitly refused to introduce, and two copies of a normalizer drift.
-- In one direction they silently refuse real proofs, which is what happened; in
-- the other they accept a number that is not equivalent at all, which is worse.
--
-- So phone EQUIVALENCE stays in TypeScript, where exactly one normalizer lives,
-- and this command's backstop is a different, drift-free question:
-- `p_expected_phone` must match the stored value EXACTLY, as a string. The
-- server reads the row, decides equivalence with the one normalizer, and passes
-- back the value it read. If the stored mobile changed between that read and
-- this write, the compare-and-set refuses. That closes the wrong-row and
-- stale-read failures without teaching SQL anything about phone formats.
--
-- WHAT IT REFUSES, all without writing anything:
--   * an entry that does not exist;
--   * an entry with no stored mobile (there is nothing to have proved);
--   * a row whose stored mobile is not the one the caller verified against;
--   * an entry already verified (idempotent, and the instant does not move).
create or replace function public.mark_waitlist_mobile_verified(
  p_entry_id       uuid,
  p_expected_phone text
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_studio  uuid;
  v_phone   text;
  v_already timestamptz;
  v_now     timestamptz;
begin
  if p_entry_id is null or coalesce(btrim(p_expected_phone), '') = '' then
    return 'refused';
  end if;

  -- An UNLOCKED read for one purpose only: learn which studio owns the row so
  -- the canonical studio -> entry lock order can be taken. Nothing is decided
  -- here and no clock is read yet.
  select e.studio_id into v_studio
    from public.new_client_waitlist_entries e
   where e.id = p_entry_id;
  if v_studio is null then
    return 'not_found';
  end if;

  perform 1 from public.studios s where s.id = v_studio for no key update;

  select e.phone, e.mobile_verified_at
    into v_phone, v_already
    from public.new_client_waitlist_entries e
   where e.id = p_entry_id
     for update;

  -- Read the clock only after the locks. This transaction can wait on the entry
  -- lock for an unbounded time, and a pre-lock instant would record a moment
  -- that had already passed when the row was finally written.
  v_now := clock_timestamp();

  if v_phone is null then
    -- Nothing was stored, so nothing can have been proved. This is the arm that
    -- stops an empty row being granted a verified standing.
    return 'refused';
  end if;

  -- EXACT string comparison, deliberately. See the note above: this is a
  -- compare-and-set against the value the caller read, not an opinion about
  -- phone formats.
  if v_phone is distinct from p_expected_phone then
    return 'phone_mismatch';
  end if;

  if v_already is not null then
    -- Already proved. Reported distinctly so a retry is visibly harmless, and
    -- deliberately WITHOUT an update: re-stamping would move the recorded
    -- instant away from the proof that earned it.
    return 'already_verified';
  end if;

  -- THE NARROW PERMIT. Row-scoped and transaction-local, set immediately before
  -- the write and never for any other row. See the guard clause above for why
  -- this is not general write access.
  perform set_config('hone.mobile_verified_entry_id', p_entry_id::text, true);

  update public.new_client_waitlist_entries e
     set mobile_verified_at = v_now
   where e.id = p_entry_id
     and e.mobile_verified_at is null;

  return 'verified';
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. PRIVILEGES
-- ---------------------------------------------------------------------------
--
-- Revoked from every grantee BY NAME, then granted to service_role alone. A
-- browser-reachable role must not be able to promote a mobile standing even if
-- it somehow learned an entry id and a phone number.
revoke execute on function public.mark_waitlist_mobile_verified(uuid, text) from public;
revoke execute on function public.mark_waitlist_mobile_verified(uuid, text) from anon;
revoke execute on function public.mark_waitlist_mobile_verified(uuid, text) from authenticated;
revoke execute on function public.mark_waitlist_mobile_verified(uuid, text) from service_role;
grant execute on function public.mark_waitlist_mobile_verified(uuid, text) to service_role;

comment on function public.mark_waitlist_mobile_verified(uuid, text) is
  'Promotes new_client_waitlist_entries.mobile_verified_at from NULL to the database clock, only when p_expected_phone matches the stored mobile EXACTLY (compare-and-set; phone equivalence is decided by the application''s single normalizer and never re-derived here). The only writer of that column. Never replaces the stored mobile, never touches consent, opt-out or queue position.';

-- ---------------------------------------------------------------------------
-- 4. THE COLUMN COMMENTS 0202 LEFT BEHIND
-- ---------------------------------------------------------------------------
--
-- A COMMENT IS PERSISTED STATE, NOT A SOURCE COMMENT. 0202's text for these two
-- columns lives in `pg_description` and survives this migration untouched unless
-- it is replaced here. It says `mobile_verified_at` has NO WRITER, is NULL for
-- every row, and that the guard refuses every change to it. All three were true
-- of 0202 and this migration makes all three false, so schema introspection,
-- `\d+`, and every generated document would contradict the authority the same
-- file just installed.
--
-- 0202 IS APPLIED AND FROZEN, so its bytes are not edited; the correction is a
-- forward one, which is what a migration is for.
--
-- 0202's own text asked for this: it says "The verification slice amends that
-- guard clause, which is a change a reviewer sees." This IS that slice, and
-- amending the clause without amending the sentence describing it is how the
-- database ends up asserting something the database no longer does.
--
-- AND A COMMENT MUST NOT CLAIM MORE THAN ITS OWN OBJECT ENFORCES. A first version
-- of the text below said a non-NULL value MEANS a provider accepted a possession
-- proof. The database cannot know that: this command receives no proof, and any
-- service_role caller may invoke it. The provider-first ordering is an
-- application contract, and the comment now says which half is which -- because a
-- persisted claim that reads as a database guarantee will be trusted as one.
comment on column public.new_client_waitlist_entries.mobile_verified_at is
  'When `phone` was PROVEN to reach this person, or NULL. Separate from the number itself because "we hold a string" and "texts sent there arrive with the right person" are different facts and only the second may authorise a send. EXACTLY ONE WRITER EXISTS: public.mark_waitlist_mobile_verified, which sets a row-scoped transaction-local permit immediately before its own UPDATE; the transition guard refuses every other change, refuses any attempt to move or clear a value once proved, and a permit for one entry authorises nothing over another. A PostgREST caller cannot compose set_config with a write in one transaction, so no browser-reachable role can hold both halves. WHAT THE DATABASE DOES NOT ENFORCE, stated here because the difference matters: this command receives NO PROOF. It takes an entry id and the expected phone, and any service_role caller may invoke it directly. That a possession proof was obtained BEFORE the call is an APPLICATION-LEVEL contract held by lib/waitlist/mobile-verification-server.ts, which asks the provider first and returns before any write exists to make on every non-approval. So a non-NULL value means this command ran; it is evidence of a provider-accepted proof only to the extent that every caller honours that ordering, and it is NOT a database guarantee against an operator or a future call site stamping it without one.';

comment on column public.new_client_waitlist_entries.phone is
  'The single durable contact number for this prospect, and a CANDIDATE in every case: the public join form, a practitioner-entered enquiry, a legacy import and a bearer completion link all record a number somebody typed, and none of them proves it reaches this person. Reachability is `mobile_verified_at`, a separate fact with a separate proof, written by exactly one command and bound to this column by an exact-string compare-and-set. The product vocabulary calls this "mobile" and the adapter renames it at its boundary; THERE IS DELIBERATELY NO SECOND COLUMN, because a `mobile` beside this one would read as ABSENT for every legacy row that already holds a number here, letting a completion link write a number for someone the studio already has one for.';

commit;
