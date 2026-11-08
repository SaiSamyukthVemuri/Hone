-- 0323 — HON-7 launch controls. DRAFT: not applied. Two independent parts, one transaction.
--
-- PART A. A closed studio may still book a person it has invited.
--   assert_new_client_admission's 'invited_book' operation now passes for open, waitlist
--   AND closed. 'unknown' still refuses, and so do 'book' (open only) and 'join_waitlist'
--   (waitlist only): Closed still means no new public booking and no public waitlist join.
--   NOTHING else about an invitation changes: a booking still needs the proven capability
--   (0313 redeem_and_book_waitlist_invitation proves it inside the command; the flag-off path
--   proves it first). Effect on other studios: a Closed studio that already holds a live
--   invitation (48h lifetime) will find that link bookable from the apply. Only that.
--   public.waitlist_closed_invited_booking_enabled() returns true and is created in the SAME
--   transaction, so the application can tell the rule is applied (absent = not yet). It is
--   executable by service_role and authenticated only.
--
-- PART B. The capacity estimate (below).
--
-- WHAT THIS FIXES. The owner's "how many more can I offer" estimate subtracted EVERY
-- live invitation in the studio from the consultations that fit the window being
-- offered, however far away or on whichever days that invitation was scoped. An
-- invitation for next month therefore reduced the room this week. The scope columns
-- (service, date range, allowed weekdays) have no SELECT grant for any API role (0188),
-- so the application cannot narrow the count itself.
--
-- WHAT THIS DOES. One owner-gated, read-only function that returns ONE integer: how
-- many live invitations in the caller's studio have a scope that overlaps the given
-- window. Nothing else about any invitation is returned.
--
--   * Overlap is exact on BOTH axes: at least one calendar date inside the
--     intersection of the two date ranges falls on a weekday both permit.
--   * ANY service counts. The studio is one calendar, so an invitation for another
--     service still competes for the same hours.
--   * An invitation with no scope (legacy rows; the scope columns are all null or all
--     set) is counted: with nothing known about it, the conservative answer is that
--     it competes.
--   * Live means not redeemed, expired, released or declined, and not past expires_at.
--   * A null or empty weekday list means every day, as it does for the invitation.
--
-- WHO CAN CALL IT. `authenticated` only, and only as an owner of the studio asked
-- about: the function re-proves is_studio_owner(p_studio_id) from auth.uid() inside
-- itself and refuses anyone else with 42501. It is NOT granted to service_role, which
-- has no access to these tables (0188). It reads; it writes nothing.
--
-- BEFORE IT IS APPLIED. The application treats the function being absent as "not yet
-- applied" and keeps the previous behaviour (count every live invitation) with copy
-- that says so, so the release is safe in either apply order.

begin;

set local lock_timeout = '5s';

-- PART A. The operation matrix, with ONE changed cell: invited_book now also passes for `closed`.
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
    -- Invitation booking: ok in `open`, `waitlist` and (0323) `closed`. The credential
    -- is proven by the booking command itself, not here, so this cell opens no door for a
    -- caller without a valid invitation. `unknown` still refuses.
    when 'invited_book' then
      case
        when v_mode in ('open', 'waitlist', 'closed') then 'ok'
        else 'new_client_admission_refused'
      end
    -- Durable waitlist join: `waitlist` only. `open` has nothing to join.
    when 'join_waitlist' then
      case when v_mode = 'waitlist' then 'ok' else 'new_client_admission_refused' end
    else 'new_client_admission_refused'
  end;
end;
$$;

-- The marker the application reads to learn that the rule above is applied.
create or replace function public.waitlist_closed_invited_booking_enabled()
returns boolean
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$ select true $$;

revoke all on function public.assert_new_client_admission(uuid, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.waitlist_closed_invited_booking_enabled() from public, anon, authenticated, service_role;
grant execute on function public.waitlist_closed_invited_booking_enabled() to service_role, authenticated;

comment on function public.waitlist_closed_invited_booking_enabled() is
  'Marker: exists exactly when assert_new_client_admission lets invited_book pass under closed (0323).';

-- PART B.
create or replace function public.count_competing_waitlist_invitations(
  p_studio_id uuid,
  p_from      date,
  p_to        date,
  p_weekdays  integer[] default null
)
returns integer
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_n    integer;
begin
  if v_user is null or p_studio_id is null or not public.is_studio_owner(p_studio_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 365 then
    raise exception 'invalid window' using errcode = '22023';
  end if;
  if p_weekdays is not null and (
       exists (select 1 from unnest(p_weekdays) w where w is null or w < 0 or w > 6)
     ) then
    raise exception 'invalid weekdays' using errcode = '22023';
  end if;

  select count(*)::integer into v_n
    from public.new_client_waitlist_invitations i
   where i.studio_id = p_studio_id
     and i.redeemed_at is null
     and i.expired_at  is null
     and i.released_at is null
     and i.declined_at is null
     and i.expires_at > pg_catalog.clock_timestamp()
     and (
       -- No recorded scope: cannot be shown to be elsewhere, so it competes.
       i.scope_start_date is null
       or i.scope_end_date is null
       or exists (
         -- Whole calendar dates: integer offsets, never timestamps, so the session
         -- time zone cannot move a date across midnight.
         select 1
           from pg_catalog.generate_series(
                  0,
                  least(i.scope_end_date, p_to) - greatest(i.scope_start_date, p_from)
                ) o
          cross join lateral (select greatest(i.scope_start_date, p_from) + o as d) x
          where (p_weekdays is null or pg_catalog.cardinality(p_weekdays) = 0
                 or extract(dow from x.d)::integer = any (p_weekdays))
            and (i.scope_allowed_weekdays is null or pg_catalog.cardinality(i.scope_allowed_weekdays) = 0
                 or extract(dow from x.d)::smallint = any (i.scope_allowed_weekdays))
       )
     );

  return v_n;
end;
$$;

revoke all on function public.count_competing_waitlist_invitations(uuid, date, date, integer[]) from public, anon, authenticated, service_role;
grant execute on function public.count_competing_waitlist_invitations(uuid, date, date, integer[]) to authenticated;

comment on function public.count_competing_waitlist_invitations(uuid, date, date, integer[]) is
  'Owner-only. Number of live invitations in the studio whose scope overlaps the window (any service). Returns one integer.';

-- ---------------------------------------------------------------------------
-- Self-check: the grants are exactly as intended. A hosted apply that finds a
-- default privilege for any other role fails instead of shipping a function a
-- signed-out caller could reach.
-- ---------------------------------------------------------------------------
do $$
declare
  v_fn regprocedure := 'public.count_competing_waitlist_invitations(uuid, date, date, integer[])'::regprocedure;
  v_role text;
begin
  -- Part A: the matrix is callable by nobody; the marker by service_role and authenticated only.
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if pg_catalog.has_function_privilege(v_role, 'public.assert_new_client_admission(uuid, text, boolean)'::regprocedure, 'EXECUTE') then
      raise exception '0323: % must not be able to execute assert_new_client_admission', v_role;
    end if;
  end loop;
  if pg_catalog.has_function_privilege('anon', 'public.waitlist_closed_invited_booking_enabled()'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', 'public.waitlist_closed_invited_booking_enabled()'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege('authenticated', 'public.waitlist_closed_invited_booking_enabled()'::regprocedure, 'EXECUTE')
     or exists (select 1 from pg_catalog.pg_proc p cross join lateral pg_catalog.aclexplode(p.proacl) a
                 where p.oid = 'public.waitlist_closed_invited_booking_enabled()'::regprocedure and a.grantee = 0) then
    raise exception '0323: waitlist_closed_invited_booking_enabled must be executable by service_role and authenticated only';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'public.assert_new_client_admission(uuid, text, boolean)'::regprocedure
                    and p.prosrc like '%''open'', ''waitlist'', ''closed''%') then
    raise exception '0323: assert_new_client_admission does not carry the closed invited_book cell';
  end if;
  -- Part B.
  foreach v_role in array array['anon', 'service_role'] loop
    if pg_catalog.has_function_privilege(v_role, v_fn, 'EXECUTE') then
      raise exception '0323: % must not be able to execute count_competing_waitlist_invitations', v_role;
    end if;
  end loop;
  if not pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE') then
    raise exception '0323: authenticated must be able to execute count_competing_waitlist_invitations';
  end if;
  if exists (
       select 1
         from pg_catalog.pg_proc p
         cross join lateral pg_catalog.aclexplode(p.proacl) a
        where p.oid = v_fn::oid and a.grantee = 0
     ) then
    raise exception '0323: PUBLIC must not hold EXECUTE on count_competing_waitlist_invitations';
  end if;
end;
$$;

commit;
