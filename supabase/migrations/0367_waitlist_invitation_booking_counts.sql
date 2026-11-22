-- Owner-only COUNTS of the waitlist invitations a studio sent in a period, and how many became a booking.
--
-- Read-only. It writes nothing and returns five integers, never a name, a contact detail or a token. The booking
-- figures come only from the explicit invitation-to-appointment link written by the booking command; nothing
-- is inferred from times. A conversion that has no link row is reported on its own, never as a booking.
--
-- The cohort is the invitations ISSUED in the period: start inclusive, end exclusive, either end may be null (open).
-- Every figure describes that one cohort, so they share one denominator.
begin;
set local lock_timeout = '5s';

create function public.waitlist_invitation_booking_counts(
  p_studio_id uuid,
  p_from      timestamptz default null,
  p_to        timestamptz default null
)
returns table (
  invitations_total     integer,
  people_invited        integer,
  booked_linked_live    integer,
  booked_then_cancelled integer,
  converted_unlinked    integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  -- ONE generic refusal for every caller who is not an active owner of THIS studio. The studio is an argument, never
  -- chosen for the caller, so an owner of several studios gets exactly the one they asked about.
  if auth.uid() is null or p_studio_id is null or not public.is_studio_owner(p_studio_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_from is not null and p_to is not null and p_to <= p_from then
    raise exception 'invalid window' using errcode = '22023';
  end if;

  return query
  select
    pg_catalog.count(*)::integer,
    pg_catalog.count(distinct i.entry_id)::integer,
    (pg_catalog.count(*) filter (where b.invitation_id is not null and a.status is distinct from 'cancelled'))::integer,
    (pg_catalog.count(*) filter (where b.invitation_id is not null and a.status = 'cancelled'))::integer,
    (pg_catalog.count(*) filter (where b.invitation_id is null and i.redeemed_at is not null and e.status = 'converted'))::integer
    from public.new_client_waitlist_invitations i
    join public.new_client_waitlist_entries e
      on e.id = i.entry_id and e.studio_id = i.studio_id
    left join public.waitlist_invitation_bookings b
      on b.invitation_id = i.id and b.studio_id = i.studio_id
    left join public.appointments a
      on a.id = b.appointment_id
   where i.studio_id = p_studio_id
     and (p_from is null or i.issued_at >= p_from)
     and (p_to   is null or i.issued_at <  p_to);
end;
$$;

revoke all on function public.waitlist_invitation_booking_counts(uuid, timestamptz, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.waitlist_invitation_booking_counts(uuid, timestamptz, timestamptz) to authenticated;

comment on function public.waitlist_invitation_booking_counts(uuid, timestamptz, timestamptz) is
  'Owner-only, read-only. Counts of invitations issued in [from, to) and how many became a booking through the explicit link. Five integers.';

-- The grants are exactly as intended: a hosted apply that finds any other grantee fails instead of shipping it.
do $$
declare
  v_fn regprocedure := 'public.waitlist_invitation_booking_counts(uuid, timestamptz, timestamptz)'::regprocedure;
begin
  if pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE')
     or pg_catalog.has_function_privilege('service_role', v_fn, 'EXECUTE')
     or not pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE')
     or exists (select 1 from pg_catalog.pg_proc p cross join lateral pg_catalog.aclexplode(p.proacl) a
                 where p.oid = v_fn::oid and a.grantee = 0) then
    raise exception 'waitlist_invitation_booking_counts must be executable by authenticated only';
  end if;
end;
$$;

commit;
