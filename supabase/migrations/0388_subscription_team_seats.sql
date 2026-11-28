-- Seat entitlements for studios provisioned by platform billing (0387).
begin;
set local lock_timeout = '5s';

alter table public.hone_signup_attempts add column seat_revision bigint not null default 0;

-- Clinical seats are a plan limit enforced here. Receptionist seats belong to 0390's Front Desk model:
-- the plan only writes its included grant (hone_sync_included_desk, 0387), and 0390 refuses an invitation,
-- acceptance or reactivation beyond the grants. The count below READS that limit; it enforces nothing.
-- plpgsql, so the 0390 function is resolved when it runs, not when this file is applied.
create function public.hone_team_seat_counts(p_studio uuid)
returns table(plan text, practitioner_used int, practitioner_limit int, receptionist_used int, receptionist_limit int)
language plpgsql stable security definer set search_path = '' as $$
begin
  return query
  select a.plan,
    (select count(*) from public.practitioners p where p.studio_id=a.studio_id and p.active)::int + pending.clinical,
    case a.plan when 'solo' then 1 when 'studio' then 3 end,
    (select count(*) from public.studio_receptionists r where r.studio_id=a.studio_id and r.active)::int + pending.desk,
    public.front_desk_seat_limit(a.studio_id)
  from public.hone_signup_attempts a
  cross join lateral (
    select count(*) filter (where i.role is distinct from 'receptionist')::int as clinical,
           count(*) filter (where i.role='receptionist')::int as desk
    from public.pending_invitations i where i.studio_id=a.studio_id and i.status='pending'
  ) pending
  where a.state='paid' and a.studio_id=p_studio;
end $$;

create function public.my_hone_team_seats(p_studio uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(s) from public.hone_team_seat_counts(p_studio) s
  where public.is_studio_owner(p_studio);
$$;

create function public.enforce_hone_team_seats() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  usage record;
begin
  -- An actual write serializes changes to the same paid studio. At stronger
  -- isolation a stale writer gets a serialization failure instead of a stale count.
  -- The quota is checked at transaction end: normal invitation acceptance adds a
  -- member and marks the reservation accepted in the same transaction.
  update public.hone_signup_attempts set seat_revision=seat_revision+1
   where state='paid' and studio_id=new.studio_id;
  if not found then return null; end if;

  select * into strict usage from public.hone_team_seat_counts(new.studio_id);
  if usage.practitioner_used > usage.practitioner_limit then
    raise exception using errcode='HN001', message='practitioner_seat_limit';
  end if;
  return null;
end $$;

-- Receptionist invitations are 0390's (a seat grant), so they never touch the billing row here: that keeps the
-- billing row and 0390's seat lock from ever being taken in opposite orders.
-- Only changes that can acquire a seat need a check. Removing or deactivating
-- people and cancelling invitations must still work, including for older data.
create constraint trigger hone_practitioner_seat_insert after insert on public.practitioners
  deferrable initially deferred for each row when (new.active)
  execute function public.enforce_hone_team_seats();
create constraint trigger hone_practitioner_seat_update after update of active,studio_id on public.practitioners
  deferrable initially deferred for each row
  when (new.active and (not old.active or new.studio_id is distinct from old.studio_id))
  execute function public.enforce_hone_team_seats();
create constraint trigger hone_invitation_seat_insert after insert on public.pending_invitations
  deferrable initially deferred for each row when (new.status='pending' and new.role is distinct from 'receptionist')
  execute function public.enforce_hone_team_seats();
create constraint trigger hone_invitation_seat_update after update of status,role,studio_id on public.pending_invitations
  deferrable initially deferred for each row
  when (new.status='pending' and new.role is distinct from 'receptionist' and (old.status is distinct from new.status
    or old.role is distinct from new.role or old.studio_id is distinct from new.studio_id))
  execute function public.enforce_hone_team_seats();
-- A change of plan must fit the actual team and all reservations at commit.
-- The revision-only update in the trigger never re-queues this trigger.
create constraint trigger hone_plan_seats_insert after insert on public.hone_signup_attempts
  deferrable initially deferred for each row when (new.state='paid')
  execute function public.enforce_hone_team_seats();
create constraint trigger hone_plan_seats_update after update of plan,state,studio_id on public.hone_signup_attempts
  deferrable initially deferred for each row when (new.state='paid' and
    (new.state is distinct from old.state or new.plan is distinct from old.plan or new.studio_id is distinct from old.studio_id))
  execute function public.enforce_hone_team_seats();

revoke all on function public.hone_team_seat_counts(uuid), public.enforce_hone_team_seats(),
  public.my_hone_team_seats(uuid) from public,anon,authenticated,service_role;
grant execute on function public.my_hone_team_seats(uuid) to authenticated;
commit;
