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

alter table public.studios
  add column if not exists new_client_admission_mode_set_by uuid
    references public.practitioners(id) on delete set null;

comment on column public.studios.new_client_admission_mode_set_at is
  'When new_client_admission_mode was last set, from the DATABASE clock. NULL '
  'means the row still carries the 0204 backfill default and no owner has '
  'chosen a mode.';
comment on column public.studios.new_client_admission_mode_set_by is
  'The practitioner the DATABASE resolved from auth.uid() at the moment the '
  'mode was set - never an id the browser supplied.';

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
  p_mode text
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

  update public.studios s
     set new_client_admission_mode        = v_mode,
         new_client_admission_mode_set_at = v_now,
         new_client_admission_mode_set_by = v_practitioner,
         updated_at                       = v_now
   where s.id = p_studio_id;

  if not found then
    return query select 'studio_not_found'::text, null::text, null::timestamptz;
    return;
  end if;

  return query select 'ok'::text, v_mode, v_now;
end;
$$;

comment on function public.set_new_client_admission_mode(uuid, text) is
  'Sets a studio''s NEW-CLIENT admission mode. Browser supplies intent only; '
  'membership and owner role are re-derived from auth.uid() inside the '
  'function. Returns ok | not_authorized | studio_not_found | invalid_mode.';

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

revoke all on function public.set_new_client_admission_mode(uuid, text) from public;
revoke all on function public.set_new_client_admission_mode(uuid, text) from anon;
revoke all on function public.set_new_client_admission_mode(uuid, text) from authenticated;
revoke all on function public.set_new_client_admission_mode(uuid, text) from service_role;
grant execute on function public.set_new_client_admission_mode(uuid, text) to authenticated;

commit;
