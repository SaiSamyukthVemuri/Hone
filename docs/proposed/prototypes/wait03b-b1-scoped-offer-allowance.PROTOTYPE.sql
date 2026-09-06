-- =====================================================================
-- WAIT-03B — B1 PROTOTYPE.  UNNUMBERED.  NOT A MIGRATION.
--
-- This file lives OUTSIDE supabase/migrations/ deliberately. It is not
-- numbered, not part of the migration chain, and proving it on a disposable
-- database is NOT numbered-chain proof. It exists so the B1 invariant can be
-- exercised against real prior schema before anyone claims a migration number.
--
-- INVARIANT THIS SLICE DELIVERS
--   A stored invitation cannot express a permission its owner did not grant,
--   and outstanding admission permission can never exceed the round allowance.
--
-- DELIBERATELY NOT HERE: read-only resolver (G4), token-authorised decline
-- command (G3), booking-time commit validation and scope-bound appointments
-- (G7), invitation delivery authority (G8), and all server/browser/email work.
-- =====================================================================

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------
-- 1. ROUND ALLOWANCE.  Owner-set, explicit, with NO default live value:
--    a NULL allowance means "no round is open", not "unlimited".
-- ---------------------------------------------------------------------
-- ARCHITECTURE CORRECTION FOUND BY THE B1 PROOF.
-- The allowance was first added as a column on public.studios. That is unsafe:
-- `anon` and `authenticated` already hold TABLE-level UPDATE on studios, and
-- PostgreSQL cannot revoke a single column from a table-level grant -- the
-- attempted `revoke update (col)` silently left anon/authenticated able to
-- write it. Protecting it would have required revoking table UPDATE on studios
-- and re-granting every other column, a large blast radius on an existing
-- table. The allowance therefore lives in its OWN table, which starts with no
-- grants at all and needs no privilege surgery anywhere else.
create table if not exists public.studio_waitlist_admission_rounds (
  studio_id  uuid primary key references public.studios(id) on delete cascade,
  allowance  integer not null,
  updated_at timestamptz not null default now(),
  constraint studio_waitlist_admission_rounds_allowance_check check (allowance >= 0)
);

alter table public.studio_waitlist_admission_rounds enable row level security;

revoke all on public.studio_waitlist_admission_rounds from public;
revoke all on public.studio_waitlist_admission_rounds from anon;
revoke all on public.studio_waitlist_admission_rounds from authenticated;
revoke all on public.studio_waitlist_admission_rounds from service_role;
grant select (studio_id, allowance, updated_at)
  on public.studio_waitlist_admission_rounds to authenticated;

-- IDEMPOTENT, like every applied migration in this repo. Without the drop,
-- re-applying aborts the transaction here and every later statement --
-- including the scope constraint -- is silently skipped. That is exactly
-- how the first negative-control restore failed without anyone noticing.
drop policy if exists "studio_waitlist_admission_rounds_owner_select"
  on public.studio_waitlist_admission_rounds;
create policy "studio_waitlist_admission_rounds_owner_select"
  on public.studio_waitlist_admission_rounds for select to authenticated
  using (public.is_studio_owner(studio_id));

comment on table public.studio_waitlist_admission_rounds is
  'WAIT-03B: explicit per-round manual intake allowance, set by the owner. '
  'A studio with NO ROW here has no open round and no invitation may issue. '
  'It is never defaulted to a live number and never inferred from calendar '
  'emptiness. Deliberately its own table: a new column on studios would '
  'inherit the browser-reachable table-level UPDATE grant anon/authenticated '
  'already hold, and a column-level revoke cannot remove a table-level grant.';

-- ---------------------------------------------------------------------
-- 2. OFFER SCOPE + DECLINE OUTCOME on the invitation.
--    Scope is stored server-side so a substituted URL parameter, service or
--    date cannot widen permission: the commit path re-reads these columns.
-- ---------------------------------------------------------------------
alter table public.new_client_waitlist_invitations
  add column if not exists scope_service_id      uuid,
  add column if not exists scope_start_date      date,
  add column if not exists scope_end_date        date,
  add column if not exists scope_allowed_weekdays smallint[],
  add column if not exists declined_at           timestamptz;

-- Tenancy: the offered service must belong to the SAME studio as the
-- invitation. Composite FK, the same shape 0188 uses for entry and issuer.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.services'::regclass
       and contype  = 'u'
       and pg_get_constraintdef(oid) = 'UNIQUE (id, studio_id)'
  ) then
    alter table public.services
      add constraint services_id_studio_id_unique unique (id, studio_id);
  end if;
end $$;

alter table public.new_client_waitlist_invitations
  drop constraint if exists new_client_waitlist_invitations_scope_service_same_studio_fk;
alter table public.new_client_waitlist_invitations
  add constraint new_client_waitlist_invitations_scope_service_same_studio_fk
  foreign key (scope_service_id, studio_id)
  references public.services (id, studio_id) on delete restrict;

-- ALL-OR-NOTHING. A partially-scoped invitation is an unenforceable
-- permission, so it is unrepresentable rather than merely discouraged.
alter table public.new_client_waitlist_invitations
  drop constraint if exists new_client_waitlist_invitations_scope_complete_check;
alter table public.new_client_waitlist_invitations
  add constraint new_client_waitlist_invitations_scope_complete_check
  check (
    (scope_service_id is null and scope_start_date is null and scope_end_date is null
     and scope_allowed_weekdays is null)
    or
    (scope_service_id is not null and scope_start_date is not null
     and scope_end_date is not null and scope_start_date <= scope_end_date)
  );

-- Allowed weekdays, when present, must be a non-empty DISTINCT subset of
-- 0..6 (extract(dow): 0 = Sunday). NULL means "every day inside the range".
alter table public.new_client_waitlist_invitations
  drop constraint if exists new_client_waitlist_invitations_scope_weekdays_check;
alter table public.new_client_waitlist_invitations
  add constraint new_client_waitlist_invitations_scope_weekdays_check
  check (
    scope_allowed_weekdays is null
    or (
      array_length(scope_allowed_weekdays, 1) between 1 and 7
      and scope_allowed_weekdays <@ array[0,1,2,3,4,5,6]::smallint[]
      -- DISTINCTNESS IS NOT CHECKED HERE, DELIBERATELY. PostgreSQL forbids a
      -- subquery in a CHECK, and duplicates are semantically inert: membership
      -- is tested with <@ / = ANY, so [2,2,4] and [2,4] authorise the same days.
      -- The issue command canonicalises to a sorted DISTINCT array on write, so
      -- duplicates cannot arise through the supported path.
    )
  );

-- A decline is a terminal outcome and cannot coexist with another one.
alter table public.new_client_waitlist_invitations
  drop constraint if exists new_client_waitlist_invitations_one_terminal_outcome_check;
alter table public.new_client_waitlist_invitations
  add constraint new_client_waitlist_invitations_one_terminal_outcome_check
  check (
    (case when redeemed_at is not null then 1 else 0 end
     + case when expired_at  is not null then 1 else 0 end
     + case when released_at is not null then 1 else 0 end
     + case when declined_at is not null then 1 else 0 end) <= 1
  );

-- ---------------------------------------------------------------------
-- 3. LIVENESS now accounts for decline.
--    0188's index treated only redeemed/expired/released as closed, so a
--    declined invitation would keep blocking the entry forever and decision 5
--    ("a later manual offer remains possible") would be unreachable.
-- ---------------------------------------------------------------------
drop index if exists public.new_client_waitlist_invitations_one_live_per_entry;
create unique index if not exists new_client_waitlist_invitations_one_live_per_entry
  on public.new_client_waitlist_invitations (entry_id)
  where redeemed_at is null and expired_at is null
    and released_at is null and declined_at is null;

-- "No immediate re-invitation to the SAME declined round", without inventing a
-- time-based exclusion: the identical offer cannot be re-issued to the same
-- entry while that declined record stands. A DIFFERENT offer is unaffected.
-- P3-2 CORRECTION. The key omitted scope_allowed_weekdays, so two genuinely
-- different offers -- same service and dates, different permitted weekdays --
-- collided and the second was refused. The key must name every field that
-- defines the SAME LOGICAL OFFER.
--
-- NULLS NOT DISTINCT is required, not incidental. Adding a nullable column to a
-- unique index would otherwise WEAKEN the guard: PostgreSQL treats NULLs as
-- distinct by default, so two identical all-days offers (weekdays NULL) would
-- stop colliding -- the opposite of the intent. PG15+ / this stack is 17.
--
-- NULL and array[0,1,2,3,4,5,6] remain DIFFERENT keys. The contract defines
-- NULL as "every day inside the range" but does NOT define it as equivalent to
-- the explicit full array, so they are not made equivalent here.
--
-- Weekday ordering is already canonical: the issue command writes a sorted
-- DISTINCT array, so array equality is well defined on the supported path.
drop index if exists public.new_client_waitlist_invitations_no_repeat_declined_offer;
create unique index if not exists new_client_waitlist_invitations_no_repeat_declined_offer
  on public.new_client_waitlist_invitations
     (entry_id, scope_service_id, scope_start_date, scope_end_date, scope_allowed_weekdays)
  nulls not distinct
  where declined_at is not null;

-- ---------------------------------------------------------------------
-- 4. ADMISSION ACCOUNTING.
--    consumed = outstanding permission + permission already spent on a booking.
--    A booked permission stays consumed; it is NOT recycled on cancellation.
-- ---------------------------------------------------------------------
create or replace function public.waitlist_admission_consumed(p_studio_id uuid)
returns integer
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $$
  select
    (
      -- outstanding: live invitations whose response window has not passed
      select count(*)
        from public.new_client_waitlist_invitations i
       where i.studio_id   = p_studio_id
         and i.redeemed_at is null
         and i.expired_at  is null
         and i.released_at is null
         and i.declined_at is null
         and i.expires_at  > clock_timestamp()
    )
    +
    (
      -- spent: entries converted after redeeming an invitation
      select count(distinct e.id)
        from public.new_client_waitlist_entries e
        join public.new_client_waitlist_invitations i
          on i.entry_id = e.id and i.studio_id = e.studio_id
       where e.studio_id = p_studio_id
         and e.status    = 'converted'
         and i.redeemed_at is not null
    )
$$;

comment on function public.waitlist_admission_consumed(uuid) is
  'WAIT-03B: admission permission consumed for a studio. Outstanding live '
  'invitations plus permissions already spent on a booking. A declined or '
  'expired invitation frees permission; a booked one does not, and is not '
  'recycled when an appointment is later cancelled.';

-- ---------------------------------------------------------------------
-- 5. SCOPED ISSUE COMMAND.
--    Wraps the applied issue_ command rather than duplicating token minting.
--    Lock order is studios -> entry -> invitation, matching the existing
--    lifecycle, so this cannot deadlock against release_/requeue_/expire_.
-- ---------------------------------------------------------------------
create or replace function public.issue_scoped_new_client_waitlist_invitation(
  p_studio_id        uuid,
  p_entry_id         uuid,
  p_actor_user_id    uuid,
  p_service_id       uuid,
  p_start_date       date,
  p_end_date         date,
  p_allowed_weekdays smallint[] default null,
  p_ttl_hours        integer default 72
)
returns table (result text, raw_token text, invitation_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_allowance integer;
  v_consumed  integer;
  v_issue     record;
  v_inv_id    uuid;
begin
  -- LOCK ORDER STEP 1: the studio row. Serialises two concurrent issues
  -- competing for the final allowance seat.
  -- LOCK ORDER STEP 1: the studio row, then the round row. Serialises two
  -- concurrent issues competing for the final allowance seat.
  perform 1 from public.studios s where s.id = p_studio_id for update;
  if not found then
    return query select 'unknown_studio'::text, null::text, null::uuid; return;
  end if;

  select r.allowance into v_allowance
    from public.studio_waitlist_admission_rounds r
   where r.studio_id = p_studio_id
   for update;

  if v_allowance is null then
    return query select 'no_round_open'::text, null::text, null::uuid; return;
  end if;

  if p_start_date is null or p_end_date is null or p_start_date > p_end_date then
    return query select 'invalid_scope_dates'::text, null::text, null::uuid; return;
  end if;

  if p_service_id is null
     or not exists (select 1 from public.services sv
                     where sv.id = p_service_id and sv.studio_id = p_studio_id) then
    return query select 'invalid_service'::text, null::text, null::uuid; return;
  end if;

  if p_allowed_weekdays is not null then
    if array_length(p_allowed_weekdays, 1) is null
       or not (p_allowed_weekdays <@ array[0,1,2,3,4,5,6]::smallint[]) then
      return query select 'invalid_weekdays'::text, null::text, null::uuid; return;
    end if;
    -- Canonicalise: sorted DISTINCT. This is where duplicate weekdays are
    -- removed, since the CHECK above cannot express distinctness.
    select array_agg(d order by d) into p_allowed_weekdays
      from (select distinct unnest(p_allowed_weekdays) as d) q;
  end if;

  -- ALLOWANCE CHECKED UNDER THE STUDIO LOCK, not before it.
  v_consumed := public.waitlist_admission_consumed(p_studio_id);
  if v_consumed >= v_allowance then
    return query select 'round_full'::text, null::text, null::uuid; return;
  end if;

  -- LOCK ORDER STEP 2/3: the applied command locks the entry and inserts the
  -- invitation. Reusing it keeps ONE token-minting implementation.
  select * into v_issue
    from public.issue_new_client_waitlist_invitation(
           p_studio_id, p_entry_id, p_actor_user_id, p_ttl_hours);

  -- The applied command's SUCCESS literal is 'invited', not 'issued'. Assuming
  -- the wrong word here previously caused a silent early return AFTER issue_
  -- had already created the row, leaving an UNSCOPED invitation live -- the
  -- exact invariant this slice exists to hold. Unknown literals now raise
  -- rather than return, so the transaction rolls back instead of leaking one.
  if v_issue.result = 'invited' then
    null;
  elsif v_issue.result in ('already_invited','invalid_input','invalid_ttl','not_claimed','not_found') then
    return query select v_issue.result::text, null::text, null::uuid; return;
  else
    raise exception 'issue_scoped: unrecognised result % from issue_new_client_waitlist_invitation', v_issue.result
      using errcode = 'check_violation';
  end if;

  -- Stamp the scope onto the row just created, inside this same transaction.
  -- 0188's append-only trigger guards identity, tenancy, token and window and
  -- does not forbid these columns, so scope is settable exactly once here.
  update public.new_client_waitlist_invitations i
     set scope_service_id       = p_service_id,
         scope_start_date       = p_start_date,
         scope_end_date         = p_end_date,
         scope_allowed_weekdays = p_allowed_weekdays
   where i.studio_id   = p_studio_id
     and i.entry_id    = p_entry_id
     and i.redeemed_at is null and i.expired_at is null
     and i.released_at is null and i.declined_at is null
  returning i.id into v_inv_id;

  if v_inv_id is null then
    raise exception 'issue_scoped: invitation row not found for scope stamp'
      using errcode = 'check_violation';
  end if;

  return query select 'issued'::text, v_issue.raw_token::text, v_inv_id;
end;
$$;

-- service_role ONLY. Nothing for anon or authenticated; the browser never
-- executes this. Revoked from all four by name first (0129/0164 lesson).
revoke all privileges on function public.issue_scoped_new_client_waitlist_invitation(
  uuid, uuid, uuid, uuid, date, date, smallint[], integer) from public;
revoke all privileges on function public.issue_scoped_new_client_waitlist_invitation(
  uuid, uuid, uuid, uuid, date, date, smallint[], integer) from anon;
revoke all privileges on function public.issue_scoped_new_client_waitlist_invitation(
  uuid, uuid, uuid, uuid, date, date, smallint[], integer) from authenticated;
revoke all privileges on function public.issue_scoped_new_client_waitlist_invitation(
  uuid, uuid, uuid, uuid, date, date, smallint[], integer) from service_role;
grant  execute on function public.issue_scoped_new_client_waitlist_invitation(
  uuid, uuid, uuid, uuid, date, date, smallint[], integer) to service_role;

revoke all privileges on function public.waitlist_admission_consumed(uuid) from public;
revoke all privileges on function public.waitlist_admission_consumed(uuid) from anon;
revoke all privileges on function public.waitlist_admission_consumed(uuid) from authenticated;
revoke all privileges on function public.waitlist_admission_consumed(uuid) from service_role;
grant  execute on function public.waitlist_admission_consumed(uuid) to service_role;

commit;
