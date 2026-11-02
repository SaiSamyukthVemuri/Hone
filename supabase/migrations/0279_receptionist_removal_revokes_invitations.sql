-- 0279: removing a receptionist also revokes their outstanding invitations.
--
-- DRAFT, HELD, PREPARE-ONLY. Never applied or activated without Sam's per-change approval; Privacy
-- SQL review first, then Insurance. Number: 0279, assigned by OPS (0275 is #1296, 0275/0276 are reserved in #1316's guard, 0277/0278 are Team's).
--
-- THE GAP (Sam, 2 Nov: "removing a receptionist must also invalidate any outstanding invitation so
-- it cannot restore access"). link_invited_membership (0218) REACTIVATES an inactive receptionist
-- row for the invited user (active = true, deactivated_at = null) when an invitation is accepted.
-- set_studio_receptionist_active(.., false) (0216) deactivated the row but left any pending
-- invitation for that person in place, so accepting that old invitation brought the access back.
--
-- THE CHANGE. One command, one transaction: when the command DEACTIVATES a receptionist it now also
-- sets every PENDING receptionist invitation for that studio and that membership's email (compared
-- lower-case) to 'revoked'. It is the same row-level state the owner's existing Revoke button writes
-- (status 'pending' -> 'revoked'), so the existing accept path simply finds no invitation. It runs
-- under the same locks, also when the row was already inactive (the idempotent no_change answer),
-- so a retry cleans up an invitation issued in between. Reactivation (p_active = true) is unchanged
-- and revokes nothing. An invitation the owner issues AFTER the removal is deliberate and still
-- works: that is how an owner re-admits someone.
--
-- Everything else in the body is 0216's, byte for byte (authorisation, lock order, concurrency
-- refusal). Signature, return type and privileges are unchanged: service_role only. No column,
-- table or index is added, nothing is dropped.

begin;
set local lock_timeout = '5s';

create or replace function public.set_studio_receptionist_active(
  p_studio_id              uuid,
  p_owner_practitioner_id  uuid,
  p_receptionist_id        uuid,
  p_active                 boolean
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row       public.studio_receptionists%rowtype;
  v_lock_user uuid;
begin
  if not exists (
    select 1 from public.practitioners pr
     where pr.id = p_owner_practitioner_id
       and pr.studio_id = p_studio_id
       and pr.active
       and pr.role = 'owner'
  ) then
    return 'not_authorized';
  end if;
  if p_active is null then
    raise exception 'invalid_active' using errcode = '22004';
  end if;

  select sr.user_id into v_lock_user
    from public.studio_receptionists sr
   where sr.id = p_receptionist_id and sr.studio_id = p_studio_id;
  if not found then
    return 'not_found';
  end if;
  if v_lock_user is not null then
    perform public.studio_membership_kind_lock(p_studio_id, v_lock_user);
  end if;

  select * into v_row
    from public.studio_receptionists sr
   where sr.id = p_receptionist_id and sr.studio_id = p_studio_id
   for update;
  if not found then
    return 'not_found';
  end if;
  if v_row.user_id is distinct from v_lock_user then
    raise exception 'receptionist_changed_concurrently' using errcode = '40001';
  end if;

  -- 0279: a removal also closes every outstanding receptionist invitation for this person, in the
  -- same transaction, so an old invitation cannot reactivate the row.
  if not p_active and v_row.email is not null then
    update public.pending_invitations
       set status = 'revoked'
     where studio_id = p_studio_id
       and role = 'receptionist'
       and status = 'pending'
       and lower(email) = lower(v_row.email);
  end if;

  if v_row.active = p_active then
    return 'no_change';
  end if;

  update public.studio_receptionists
     set active = p_active,
         deactivated_at = case when p_active then null else now() end
   where id = v_row.id;
  return 'updated';
end;
$$;

revoke execute on function public.set_studio_receptionist_active(uuid, uuid, uuid, boolean) from public;
revoke execute on function public.set_studio_receptionist_active(uuid, uuid, uuid, boolean) from anon;
revoke execute on function public.set_studio_receptionist_active(uuid, uuid, uuid, boolean) from authenticated;
grant execute on function public.set_studio_receptionist_active(uuid, uuid, uuid, boolean) to service_role;

commit;
