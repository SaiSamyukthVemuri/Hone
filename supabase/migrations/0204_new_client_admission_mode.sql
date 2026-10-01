-- ===========================================================================
-- 0204 — STUDIO-OWNED NEW-CLIENT ADMISSION MODE
-- ===========================================================================
--
-- CANDIDATE, NOT APPLIED. Authored against production a5e179f2 with the
-- canonical derivation run fresh at authoring time: repo max 0203, hosted max
-- 0203, pending none, next free 0204. The number is claimed from that evidence.
--
-- WHAT THIS ADDS, AND NOTHING ELSE:
--   1. studios.new_client_admission_mode — one durable, studio-owned field
--      with a CLOSED value set: 'open' | 'waitlist' | 'closed'.
--   2. ONE narrow owner-authorized command that sets it.
--
-- WHY A COLUMN AND NOT A TABLE. This is exactly one value per studio with no
-- history requirement beyond "who last changed it, when", and `studios` already
-- carries every other studio-scoped operating toggle (clinical_finalization_
-- enabled, practitioner_capacity_enabled, onboarding_v2_enabled, send_intake_
-- reminders). A side table would add a join and a missing-row state to every
-- read of a value that must never be missing.
--
-- THE DEFAULT IS 'open', AND IT IS DERIVED, NOT GUESSED. Today a studio takes
-- ordinary new-client bookings unless its slug appears in the server-only
-- NEW_CLIENT_WAITLIST_STUDIO_SLUGS list. Backfilling every existing row to
-- 'open' therefore reproduces current behaviour for every studio that is not
-- on that list, and the transition bridge in
-- lib/booking/new-client-admission.ts keeps the listed studios on WAITLIST
-- until the activation gate writes their real mode. This migration deliberately
-- does NOT try to read the env list: a migration cannot see Vercel, and
-- inferring it from historical rows is the guess this slice refuses to make.
--
-- WHAT IT DOES NOT DO: it does not read, write or retire any environment
-- variable; it does not touch new_client_waitlist_entries; it does not change
-- any existing-client, portal or rebook right; it grants no role new DML on
-- studios.
--
-- NEW-CLIENT ONLY. 'closed' closes the door to people who are not yet clients.
-- An existing client's booking, portal access and rebooking are unaffected by
-- every value here, and nothing in this file references them.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. THE COLUMN
-- ---------------------------------------------------------------------------
--
-- NOT NULL with a default, so the value can never be missing and a read can
-- never have to invent one. The CHECK is the closed set: a mode outside it is
-- not a state this product has semantics for, so the database refuses it rather
-- than letting the application decide what an unknown string means.

alter table public.studios
  add column if not exists new_client_admission_mode text not null default 'open';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.studios'::regclass
      and conname = 'studios_new_client_admission_mode_check'
  ) then
    alter table public.studios
      add constraint studios_new_client_admission_mode_check
      check (new_client_admission_mode in ('open', 'waitlist', 'closed'));
  end if;
end $$;

comment on column public.studios.new_client_admission_mode is
  'Studio-owned NEW-CLIENT admission mode: open | waitlist | closed. '
  'NEW-CLIENT ONLY - never gates an existing client, the portal or rebooking. '
  'Set exclusively through public.set_new_client_admission_mode(); no role '
  'holds direct UPDATE on this table. Default open reproduces the behaviour of '
  'a studio absent from NEW_CLIENT_WAITLIST_STUDIO_SLUGS.';

-- ---------------------------------------------------------------------------
-- 2. WHO LAST CHANGED IT
-- ---------------------------------------------------------------------------
--
-- The repository's established pattern for an operator-visible setting is to
-- record the acting practitioner and the instant, so a later question about a
-- studio's admission state has an answer that is not "someone, at some point".
-- Both are written by the command below from DB-derived facts, never from
-- anything the browser sent.

alter table public.studios
  add column if not exists new_client_admission_mode_set_at timestamptz;

-- NO FOREIGN KEY, AND THAT IS DELIBERATE.
--
-- A `references public.practitioners(id)` here would add a SECOND relationship
-- between `studios` and `practitioners`. PostgREST resolves embeds by
-- relationship, and the forward one - `practitioners.studio_id -> studios.id`
-- from 0001 - is already used by fifteen call sites as `studio:studios(*)`.
-- Adding the reverse makes every one of them ambiguous:
--
--   "Could not embed because more than one relationship was found for
--    'practitioners' and 'studios'"
--
-- which is a repository-wide PostgREST change for no product benefit. This
-- column is audit EVIDENCE, not a relational edge anything traverses.
--
-- THE FK WAS NEVER THE AUTHORITY, so dropping it removes no guarantee:
--   * set_new_client_admission_mode re-derives auth.uid() itself;
--   * it resolves an ACTIVE OWNER belonging to THIS studio;
--   * the browser never supplies a practitioner id;
--   * the admission guard below requires a transaction-local permit naming
--     THIS studio, so mode, set_at and set_by cannot be PATCHed around it;
--   * the three fields change atomically, in the command's single statement.
--
-- It also makes the audit survive a practitioner's lifecycle: `on delete set
-- null` would have ERASED the actor when that practitioner was removed, which
-- is precisely when the record matters most.
alter table public.studios
  add column if not exists new_client_admission_mode_set_by uuid;

comment on column public.studios.new_client_admission_mode_set_at is
  'When new_client_admission_mode was last set, from the DATABASE clock. NULL '
  'means the row still carries the 0204 backfill default and no owner has '
  'chosen a mode.';
comment on column public.studios.new_client_admission_mode_set_by is
  'The practitioner the DATABASE resolved from auth.uid() at the moment the '
  'mode was set - never an id the browser supplied. Deliberately NOT a foreign '
  'key: a second studios<->practitioners relationship would make the '
  'established practitioners -> studio:studios(*) PostgREST embed ambiguous. '
  'Integrity comes from set_new_client_admission_mode plus the scoped permit '
  'guard, not from a constraint, and the value outlives the practitioner row.';

-- ---------------------------------------------------------------------------
-- 3. THE ONE COMMAND
-- ---------------------------------------------------------------------------
--
-- THE BROWSER SUPPLIES INTENT ONLY. `p_mode` is the entire browser-influenced
-- surface. The studio comes from the server, and membership + owner role are
-- re-derived here from auth.uid() via is_studio_owner(), so a forged form
-- cannot name another studio and a practitioner cannot self-promote.
--
-- RESULT-BEARING, NOT EXCEPTION-BEARING, for the refusals a caller must
-- distinguish: 'ok', 'not_authorized', 'studio_not_found', 'invalid_mode'. A
-- caller that cannot tell "you may not" from "that studio does not exist"
-- cannot write truthful copy.

create or replace function public.set_new_client_admission_mode(
  p_studio_id uuid,
  p_mode text,
  -- TRUE while this studio's NEW-client waitlist joins still commit through the
  -- LEGACY EMAIL-ONLY path. Server-derived, because the database cannot read the
  -- env lists, and TEMPORARY: retired with the bridge at cutover.
  p_legacy_email_only boolean default false
)
returns table (outcome text, mode text, set_at timestamptz)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_mode           text := lower(btrim(coalesce(p_mode, '')));
  v_practitioner   uuid;
  v_now            timestamptz := now();
begin
  if p_studio_id is null then
    return query select 'studio_not_found'::text, null::text, null::timestamptz;
    return;
  end if;

  -- The closed set, checked before anything is locked or written, so an
  -- unrecognised intent costs a studio nothing.
  if v_mode not in ('open', 'waitlist', 'closed') then
    return query select 'invalid_mode'::text, null::text, null::timestamptz;
    return;
  end if;

  -- MEMBERSHIP AND ROLE ARE RE-DERIVED HERE. is_studio_owner reads auth.uid()
  -- itself; nothing the caller passed can influence it.
  if not public.is_studio_owner(p_studio_id) then
    return query select 'not_authorized'::text, null::text, null::timestamptz;
    return;
  end if;

  -- WHILE A STUDIO IS STILL ON THE LEGACY EMAIL-ONLY COMMIT PATH, THE
  -- OPEN/CLOSED TRANSITION IS NOT AVAILABLE.
  --
  -- That path commits through an external email provider, so it cannot hold a
  -- transaction across its commit point, and a check immediately before the send
  -- only narrows the window - it cannot close it. Rather than fake atomicity
  -- around a provider, or build an outbox in this PR, the CONCURRENT TRANSITION
  -- IS REMOVED: no owner change can invalidate an in-flight legacy commit,
  -- because the owner cannot make one.
  --
  -- WAITLIST IS STILL ALLOWED, and it is the way out: writing WAITLIST stamps
  -- the row, which makes the commit durable, after which normal OPEN / WAITLIST
  -- / CLOSED control becomes available. Ordinary durable admission authority is
  -- untouched - this refuses only for a studio whose joins still land in an
  -- inbox.
  if coalesce(p_legacy_email_only, false) and v_mode in ('open', 'closed') then
    return query select 'legacy_waitlist_cutover_required'::text,
                        null::text, null::timestamptz;
    return;
  end if;

  -- The actor is resolved from the same session identity, never from a
  -- parameter, so the audit column records who the DATABASE believes acted.
  select p.id
    into v_practitioner
    from public.practitioners p
   where p.studio_id = p_studio_id
     and p.user_id = auth.uid()
     and p.active = true
     and p.role = 'owner'
   limit 1;

  -- ARM THE ROW-SCOPED PERMIT. Transaction-local (`is_local => true`), so it
  -- cannot leak to another statement, another session, or a later request, and
  -- it names THIS studio so a permit for A can never pass an update to B. This
  -- is the 0120 / 0203 idiom, unchanged.
  perform set_config('hone.admission_mode_studio_id', p_studio_id::text, true);

  -- No `updated_at` write: public.studios HAS NO SUCH COLUMN (it carries
  -- created_at and policy_updated_at only), and a plpgsql body is not
  -- name-resolved at create time, so an invented column here fails with 42703
  -- at CALL time - the command would never once succeed. The three admission
  -- fields are their own audit record; set_at IS the "when".
  update public.studios s
     set new_client_admission_mode        = v_mode,
         new_client_admission_mode_set_at = v_now,
         new_client_admission_mode_set_by = v_practitioner
   where s.id = p_studio_id;

  if not found then
    return query select 'studio_not_found'::text, null::text, null::timestamptz;
    return;
  end if;

  return query select 'ok'::text, v_mode, v_now;
end;
$$;

comment on function public.set_new_client_admission_mode(uuid, text, boolean) is
  'Sets a studio''s NEW-CLIENT admission mode. Browser supplies intent only; '
  'membership and owner role are re-derived from auth.uid() inside the '
  'function. Returns ok | not_authorized | studio_not_found | invalid_mode | '
  'legacy_waitlist_cutover_required.';

-- ---------------------------------------------------------------------------
-- 4. THE COMMAND IS THE ONLY WRITER
-- ---------------------------------------------------------------------------
--
-- WHY THIS IS NEEDED AT ALL. `studios` has carried a "studios: owners update"
-- policy since 0001, so an owner already holds table-level UPDATE. Adding three
-- columns to that table therefore hands every owner a PostgREST PATCH that sets
-- the mode, backdates the `_set_at` column and names someone else in `_set_by`
-- - bypassing the command, its owner re-derivation and its audit contract
-- entirely. The command would be a front door beside an open window.
--
-- NARROW ON PURPOSE. This does not touch the existing policy, revoke UPDATE, or
-- gate any other column: an ordinary studios update - name, timezone, buffer,
-- any existing toggle - is unaffected and needs no permit. The guard fires ONLY
-- when one of the three admission fields actually changes.
--
-- NOT A BYPASS SWITCH. The permit carries the studio id and is compared against
-- the row being written, so it authorises exactly one row for the duration of
-- one transaction. There is no value of it that means "allow anything".

create or replace function public.studios_admission_mode_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_touches_admission boolean :=
        new.new_client_admission_mode        is distinct from old.new_client_admission_mode
     or new.new_client_admission_mode_set_at is distinct from old.new_client_admission_mode_set_at
     or new.new_client_admission_mode_set_by is distinct from old.new_client_admission_mode_set_by;
begin
  if not v_touches_admission then
    return new;
  end if;

  if coalesce(current_setting('hone.admission_mode_studio_id', true), '')
     is distinct from new.id::text then
    raise exception
      'studios: new-client admission has exactly one writer, and this is not it'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.studios_admission_mode_guard() is
  'Refuses any UPDATE that changes new_client_admission_mode or its audit '
  'columns without a transaction-local permit naming THIS studio. Ordinary '
  'studios updates are untouched.';

drop trigger if exists studios_admission_mode_guard on public.studios;
create trigger studios_admission_mode_guard
  before update on public.studios
  for each row
  execute function public.studios_admission_mode_guard();

-- ---------------------------------------------------------------------------
-- 5. GRANTS
-- ---------------------------------------------------------------------------
--
-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon, authenticated AND
-- service_role at create time. An authenticated-only command must revoke from
-- all three BY NAME - missed once in 0129 (anon) and again in 0164
-- (service_role), and now pinned by tests/security/clinical-rpc-grant-guard.
-- The function is owner-gated internally, but an unauthenticated caller should
-- not be able to reach it at all.

revoke all on function public.set_new_client_admission_mode(uuid, text, boolean) from public;
revoke all on function public.set_new_client_admission_mode(uuid, text, boolean) from anon;
revoke all on function public.set_new_client_admission_mode(uuid, text, boolean) from authenticated;
revoke all on function public.set_new_client_admission_mode(uuid, text, boolean) from service_role;
grant execute on function public.set_new_client_admission_mode(uuid, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. COMMIT-TIME AUTHORITY
--
-- THE APPLICATION READ IS NOT COMMIT-TIME AUTHORITY. It is presentation, fast
-- refusal, and work avoidance. Between that read and the write the owner can
-- change the mode, and the writes travel as SEPARATE PostgREST requests - so a
-- request that began under `open` could insert a client and create an
-- appointment after the studio had been closed.
--
-- The fix is a serial order, not a second read: every new-client business
-- mutation resolves admission INSIDE its own transaction, after taking the
-- studio row lock.
--
--   mutation gets the lock first -> it commits under the mode it saw, and the
--                                   owner's change applies afterwards;
--   owner gets the lock first    -> the mutation waits, then observes the NEW
--                                   mode, and refuses if it does not permit it.
--
-- `set_new_client_admission_mode` above takes the same row lock implicitly, via
-- its UPDATE of that row, so the two orders are the only two possible.
--
-- `FOR NO KEY UPDATE`, NEVER `FOR UPDATE`. 0193 measured this: FOR UPDATE
-- conflicts with KEY SHARE, and the 0185/0188 entry writers hold an entry and
-- then request KEY SHARE on studios through an FK trigger, so a studio-first
-- FOR UPDATE moves the deadlock cycle rather than closing it.
--
-- NEW-CLIENT ONLY. Nothing here is reachable from existing-client ordinary
-- booking, portal rebooking, management of a confirmed appointment, or EMERG-01
-- free-consult rescheduling. `create_public_appointment` is UNTOUCHED, so every
-- existing-client caller behaves exactly as before.
-- ---------------------------------------------------------------------------

-- THE TRANSITION ARGUMENT, AND WHY IT EXISTS.
--
-- 0204 cannot read Vercel env state, so for an UNSTAMPED row the database
-- cannot know whether the legacy list escalates it. The service-role caller -
-- never the browser - supplies that one server-derived fact.
--
-- It is consulted ONLY when `new_client_admission_mode_set_at IS NULL`. Once an
-- owner has stamped a choice, persisted authority wins and this argument is
-- ignored outright, which is what gives the race its required outcome: an owner
-- who stamps CLOSED before the mutation takes the lock wins even if the request
-- began under a legacy read.
--
-- TEMPORARY. It is retired with the bridge at cutover, together with
-- lib/booking/new-client-waitlist-durability-bridge.ts and the durable env gate.
-- See docs/production/new-client-admission-activation.md, step 6.
--
-- NULL means "the caller did not supply the transition fact". For an unstamped
-- row that leaves the effective mode genuinely unknown, and unknown refuses.
create or replace function public.effective_new_client_admission(
  p_studio_id               uuid,
  p_legacy_bridge_waitlist  boolean
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_mode   text;
  v_set_at timestamptz;
  v_found  boolean := false;
begin
  if p_studio_id is null then
    return 'unknown';
  end if;

  -- THE LOCK COMES FIRST, before any read of the mode and before any write by
  -- any caller. This is the whole mechanism.
  perform 1 from public.studios s where s.id = p_studio_id for no key update;

  select true, s.new_client_admission_mode, s.new_client_admission_mode_set_at
    into v_found, v_mode, v_set_at
    from public.studios s
   where s.id = p_studio_id;

  -- NO ROW IS NOT A MODE. A studio that does not exist cannot admit anyone.
  if not coalesce(v_found, false) then
    return 'unknown';
  end if;
  if v_mode is null or v_mode not in ('open', 'waitlist', 'closed') then
    return 'unknown';
  end if;

  -- An explicit owner write is authoritative; the transition fact is ignored.
  if v_set_at is not null then
    return v_mode;
  end if;

  -- UNSTAMPED: 0204's backfill, so the bounded transition fact decides. ONE-WAY,
  -- exactly as the application bridge is: it may escalate an unchosen `open` to
  -- waitlist and may never make a studio less restricted than its row says.
  if p_legacy_bridge_waitlist is null then
    return 'unknown';
  end if;
  if v_mode = 'open' and p_legacy_bridge_waitlist then
    return 'waitlist';
  end if;
  return v_mode;
end;
$$;

comment on function public.effective_new_client_admission(uuid, boolean) is
  'Resolves the EFFECTIVE new-client admission mode inside the caller''s '
  'transaction, after taking the studios row lock FOR NO KEY UPDATE. Returns '
  'open | waitlist | closed | unknown. A stamped mode wins outright; an '
  'unstamped row consults the caller-supplied legacy bridge fact, which is '
  'TEMPORARY and retired with the bridge.';

-- The operation matrix, in one place so no caller can hold a different opinion.
create or replace function public.assert_new_client_admission(
  p_studio_id               uuid,
  p_operation               text,
  p_legacy_bridge_waitlist  boolean
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_mode text := public.effective_new_client_admission(
    p_studio_id, p_legacy_bridge_waitlist
  );
begin
  -- ONE refusal code for every refused state. `closed` and `unknown` differ in
  -- cause, not consequence, and a distinct answer for `unknown` would publish
  -- that a read failed. It is returned without consulting any credential, so it
  -- cannot be used to probe whether an invitation is valid.
  return case p_operation
    -- Ordinary new-client booking: `open` only.
    when 'book' then
      case when v_mode = 'open' then 'ok' else 'new_client_admission_refused' end
    -- Invitation booking: `waitlist` is the exception the WAIT lifecycle needs,
    -- and `open` is preserved because the ordinary path already permits a
    -- credentialed booking there. No new right is invented: `closed` and
    -- `unknown` refuse even with a valid invitation.
    when 'invited_book' then
      case
        when v_mode in ('open', 'waitlist') then 'ok'
        else 'new_client_admission_refused'
      end
    -- Durable waitlist join: `waitlist` only. `open` has nothing to join.
    when 'join_waitlist' then
      case when v_mode = 'waitlist' then 'ok' else 'new_client_admission_refused' end
    else 'new_client_admission_refused'
  end;
end;
$$;

comment on function public.assert_new_client_admission(uuid, text, boolean) is
  'Commit-time new-client admission gate. Operations: book | invited_book | '
  'join_waitlist. Returns ok or new_client_admission_refused - one code for '
  'every refused state, so it cannot be used to probe a credential.';

-- 5a. DURABLE WAITLIST JOIN
--
-- A WRAPPER, not a rewrite: 0185/0188 own `join_new_client_waitlist` and are
-- applied, so this composes with it in the SAME transaction rather than editing
-- frozen history - the shape 0195 already established for atomic composition.
create or replace function public.join_new_client_waitlist_guarded(
  p_studio_id               uuid,
  p_name                    text,
  p_email                   text,
  p_phone                   text,
  p_legacy_bridge_waitlist  boolean
)
returns table (result text, entry_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_gate text := public.assert_new_client_admission(
    p_studio_id, 'join_waitlist', p_legacy_bridge_waitlist
  );
begin
  if v_gate <> 'ok' then
    -- Nothing has been written, so the refusal leaves no trace at all.
    return query select v_gate, null::uuid;
    return;
  end if;
  return query
    select j.result, j.entry_id
      from public.join_new_client_waitlist(p_studio_id, p_name, p_email, p_phone) j;
end;
$$;

comment on function public.join_new_client_waitlist_guarded(uuid, text, text, text, boolean) is
  'join_new_client_waitlist with COMMIT-TIME admission: refuses unless the '
  'effective mode is waitlist, decided under the studios row lock in this '
  'transaction. Wraps rather than replaces the 0185/0188 command.';

-- 5c. ORDINARY NEW-CLIENT BOOKING
--
-- THE CLIENT ROW IS THE FIRST IRREVERSIBLE NEW-CLIENT WRITE, and the application
-- used to insert it through its own PostgREST request before the appointment
-- command ran. Guarding only the appointment command would therefore have left
-- an ORPHAN CLIENT behind for a request that should have been refused, so the
-- insert moves inside this transaction, after the locked decision.
--
-- SCOPE. Only the CREATE half moves. Resolving an already-existing client by
-- email, and reconciling their SMS consent, stay in the application: that row
-- already exists, so it is not a new-client business mutation, and porting that
-- logic would be a rewrite rather than a repair. The caller passes
-- `p_client_id` when it resolved one and NULL when it did not.
--
-- `create_public_appointment` is called, never modified: existing-client
-- ordinary booking continues to reach it directly and is unaffected.
-- AN ADDED DEFAULTED PARAMETER CREATES AN OVERLOAD, NOT A REPLACEMENT, and two
-- overloads make every existing call AMBIGUOUS. Dropping the previous shape
-- first keeps this migration safely re-appliable; on a fresh chain it is a
-- no-op, because only the signature below is ever created.
drop function if exists public.create_public_appointment_for_new_client(
  uuid, uuid, text, text, text, timestamptz, uuid, timestamptz, text, boolean, text, text
);

create or replace function public.create_public_appointment_for_new_client(
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
  p_referral_source         text default null,
  -- SERVER-DERIVED, from the locked redemption that just spent the invitation.
  -- NULL is the ordinary path; non-null composes 0195's conversion instead, which
  -- is the same branch the application already made on `redeemedEntryId`.
  p_entry_id                uuid default null
)
returns table (
  result           text,
  appointment_id   uuid,
  starts_at        timestamptz,
  ends_at          timestamptz,
  duration_minutes integer,
  practitioner_id  uuid,
  created_at       timestamptz,
  client_id        uuid
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  -- The OPERATION, not just the mode: an invitation may admit under `waitlist`,
  -- an ordinary booking may not, and neither may under `closed` or `unknown`.
  v_gate      text := public.assert_new_client_admission(
    p_studio_id,
    case when p_entry_id is null then 'book' else 'invited_book' end,
    p_legacy_bridge_waitlist
  );
  v_client_id uuid := p_client_id;
  v_archived  boolean;
begin
  if v_gate <> 'ok' then
    -- BEFORE the insert, so a refused request writes no client row.
    return query select v_gate, null::uuid, null::timestamptz, null::timestamptz,
                        null::integer, null::uuid, null::timestamptz, null::uuid;
    return;
  end if;

  if v_client_id is null then
    -- RE-RESOLVE UNDER THE LOCK. The caller's own lookup ran before this
    -- transaction, so another booking could have created this client since. The
    -- studios row lock taken above serialises same-studio bookings, which is why
    -- a plain lookup-then-insert is safe here and the application's 23505
    -- unique-violation race cannot occur inside this command.
    --
    -- `normalized_email` is the generated column the uniqueness is built on, so
    -- matching on it is matching on exactly what would collide.
    select c.id, c.archived_at is not null
      into v_client_id, v_archived
      from public.clients c
     where c.studio_id = p_studio_id
       and c.normalized_email = case
             when p_client_email is null or btrim(p_client_email) = '' then null
             else lower(btrim(p_client_email))
           end
     limit 1;

    -- An ARCHIVED client is the application's existing refusal, kept verbatim so
    -- the caller can log it exactly as it does today rather than resurrecting a
    -- client nobody asked to restore.
    if coalesce(v_archived, false) then
      return query select 'archived_client_collision'::text,
                          null::uuid, null::timestamptz, null::timestamptz,
                          null::integer, null::uuid, null::timestamptz, null::uuid;
      return;
    end if;

    if v_client_id is null then
      -- THE RACE IS REAL, BECAUSE NOT EVERY CLIENT WRITER TAKES THIS LOCK.
      --
      -- The studios row lock serialises this command against other transactions
      -- that acquire it - and the practitioner "Add Client" surface
      -- (app/(app)/clients/new/actions.ts) does not. It inserts straight into
      -- `clients`, so it can land between the lookup above and the insert below
      -- and raise 23505 on the unique email index.
      --
      -- An uncaught exception here would abort the whole RPC, and on the
      -- invitation path the redemption is ALREADY COMMITTED from an earlier
      -- request - leaving an invitation spent with no booking outcome from the
      -- transaction that owns it. So the collision is caught and answered.
      begin
        insert into public.clients (
          studio_id, name, email, phone, sms_consent_at, sms_consent_source
        )
        values (
          p_studio_id, p_client_name, p_client_email, p_client_phone,
          p_sms_consent_at,
          case when p_sms_consent_at is null then null else 'public_booking' end
        )
        returning id into v_client_id;
      exception
        when unique_violation then
          -- RE-READ THE WINNER, and distinguish active from archived exactly as
          -- the application contract did before this moved into the database.
          select c.id, c.archived_at is not null
            into v_client_id, v_archived
            from public.clients c
           where c.studio_id = p_studio_id
             and c.normalized_email = case
                   when p_client_email is null or btrim(p_client_email) = '' then null
                   else lower(btrim(p_client_email))
                 end
           limit 1;

          if coalesce(v_archived, false) then
            return query select 'archived_client_collision'::text,
                                null::uuid, null::timestamptz, null::timestamptz,
                                null::integer, null::uuid, null::timestamptz, null::uuid;
            return;
          end if;

          -- The index said a row exists and the re-read cannot see it, so the
          -- collision was on something this command does not own. Answer
          -- definitely rather than raising: the caller must be able to tell a
          -- spent invitation apart from an unknown failure.
          if v_client_id is null then
            return query select 'client_not_created'::text,
                                null::uuid, null::timestamptz, null::timestamptz,
                                null::integer, null::uuid, null::timestamptz, null::uuid;
            return;
          end if;
      end;
    end if;
  end if;

  if p_entry_id is null then
    return query
      select c.result, c.appointment_id, c.starts_at, c.ends_at,
             c.duration_minutes, c.practitioner_id, c.created_at, v_client_id
        from public.create_public_appointment(
               p_studio_id, v_client_id, p_service_id, p_starts_at,
               p_cancellation_token_hash, p_notes, p_referral_source
             ) c;
  else
    -- 0195 already takes the studios row lock and converts the entry in the same
    -- transaction, so the admission decision above simply precedes it.
    return query
      select c.result, c.appointment_id, c.starts_at, c.ends_at,
             c.duration_minutes, c.practitioner_id, c.created_at, v_client_id
        from public.create_waitlist_public_appointment(
               p_studio_id, v_client_id, p_service_id, p_starts_at,
               p_cancellation_token_hash, p_entry_id, p_notes, p_referral_source
             ) c;
  end if;
end;
$$;

comment on function public.create_public_appointment_for_new_client(uuid, uuid, text, text, text, timestamptz, uuid, timestamptz, text, boolean, text, text, uuid) is
  'Ordinary NEW-client booking as ONE commit: locked admission decision, then '
  'the client row if the caller resolved none, then create_public_appointment. '
  'Guarding only the appointment command would have left an orphan client for a '
  'refused request. create_public_appointment itself is unchanged, so '
  'existing-client callers are unaffected.';

-- GRANTS. Supabase grants EXECUTE to anon, authenticated AND service_role at
-- create time, so each is revoked BY NAME - the 0129 (anon) and 0164
-- (service_role) lesson. These are service-role commands: the public booking and
-- waitlist actions reach them with the service key after resolving the studio
-- server-side.
--
-- The two resolver/gate helpers are internal. Nothing outside these commands may
-- call them, so they are revoked from all three and granted to nobody: the
-- SECURITY DEFINER commands above execute as owner and reach them regardless.
-- PUBLIC IS A GRANTEE TOO, AND IT IS THE ONE EASIEST TO MISS. Revoking from
-- anon, authenticated and service_role by name is not enough: a function's
-- default ACL also grants EXECUTE to PUBLIC, and `anon` is a member of PUBLIC -
-- measured on this database, every function below answered
-- has_function_privilege('anon', ..., 'execute') = true after the three named
-- revokes alone. This is the 0129 (anon) and 0164 (service_role) lesson with a
-- fourth grantee, so PUBLIC is revoked FIRST, from every function here.
revoke all on function public.effective_new_client_admission(uuid, boolean) from public;
revoke all on function public.effective_new_client_admission(uuid, boolean) from anon;
revoke all on function public.effective_new_client_admission(uuid, boolean) from authenticated;
revoke all on function public.effective_new_client_admission(uuid, boolean) from service_role;
revoke all on function public.assert_new_client_admission(uuid, text, boolean) from public;
revoke all on function public.assert_new_client_admission(uuid, text, boolean) from anon;
revoke all on function public.assert_new_client_admission(uuid, text, boolean) from authenticated;
revoke all on function public.assert_new_client_admission(uuid, text, boolean) from service_role;

revoke all on function public.join_new_client_waitlist_guarded(uuid, text, text, text, boolean) from public;
revoke all on function public.join_new_client_waitlist_guarded(uuid, text, text, text, boolean) from anon;
revoke all on function public.join_new_client_waitlist_guarded(uuid, text, text, text, boolean) from authenticated;
revoke all on function public.join_new_client_waitlist_guarded(uuid, text, text, text, boolean) from service_role;
grant execute on function public.join_new_client_waitlist_guarded(uuid, text, text, text, boolean) to service_role;


revoke all on function public.create_public_appointment_for_new_client(uuid, uuid, text, text, text, timestamptz, uuid, timestamptz, text, boolean, text, text, uuid) from public;
revoke all on function public.create_public_appointment_for_new_client(uuid, uuid, text, text, text, timestamptz, uuid, timestamptz, text, boolean, text, text, uuid) from anon;
revoke all on function public.create_public_appointment_for_new_client(uuid, uuid, text, text, text, timestamptz, uuid, timestamptz, text, boolean, text, text, uuid) from authenticated;
revoke all on function public.create_public_appointment_for_new_client(uuid, uuid, text, text, text, timestamptz, uuid, timestamptz, text, boolean, text, text, uuid) from service_role;
grant execute on function public.create_public_appointment_for_new_client(uuid, uuid, text, text, text, timestamptz, uuid, timestamptz, text, boolean, text, text, uuid) to service_role;

commit;
