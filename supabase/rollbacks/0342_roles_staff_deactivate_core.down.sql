-- DOWN for 0342_roles_staff_deactivate_core. NOT a migration: supabase never runs this directory. Run by an operator, once, inside the maintenance
-- window, ONLY after the app is on a build that does not call deactivate_staff_member / reactivate_staff_member (the Roles page's Remove and
-- Restore access, and Team's Remove). Dropping the commands under a build that still calls them makes Remove fail with an error.
--
-- WHAT IT DOES: drops the two commands and perm_upcoming_policy(); puts change_staff_role back to EXACTLY 0287's body (without the capacity lock, so
-- Insurance RF-1 is open again, harmless while the staff_role_change gate is off); puts the permission_audit kind CHECK back to 0287's five kinds.
-- WHAT IT KEEPS: every audit row, including any 'staff_deactivated' / 'staff_reactivated' rows written while 0342 was live. permission_audit is
-- append-only (its triggers refuse UPDATE, DELETE and TRUNCATE), so those rows cannot be removed; the restored CHECK is therefore added NOT VALID, which
-- enforces the five kinds for every NEW row and leaves the existing rows alone. Nothing about who is active or inactive changes: practitioners.active and
-- studio_receptionists.active are not touched, so a person removed through 0342 stays removed.
begin;
set local lock_timeout = '5s';

drop function if exists public.deactivate_staff_member(uuid, uuid, text, text);
drop function if exists public.reactivate_staff_member(uuid, uuid, text, text);
drop function if exists public.perm_upcoming_policy();

alter table public.permission_audit drop constraint if exists permission_audit_kind_check;
alter table public.permission_audit add constraint permission_audit_kind_check
  check (kind in ('role_permissions_saved', 'defaults_adopted', 'role_reset', 'staff_role_changed', 'permissions_activated')) not valid;

-- 0287's change_staff_role, byte for byte (the SQL below is copied from the applied migration).
create or replace function public.change_staff_role(
  p_studio uuid, p_membership uuid, p_new_role text, p_expected_current_role text, p_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  a record;
  v_reason text;
  v_user uuid;
  v_name text;
  v_email text;
  v_active boolean;
  v_upcoming bigint;
  v_new_id uuid;
  v_target_kind text;
begin
  select * into a from public.perm_actor(p_studio);
  if not found or a.role <> 'owner' then return public.perm_fail('refused'); end if;
  -- OPERATOR SHIP GATE (Privacy E2, P1). This command creates or re-activates receptionist memberships and deactivates practitioners,
  -- which is the receptionist provisioning that stays held until the separate S4 approval. It is refused unless the operator has
  -- set the 'staff_role_change' gate for this studio; no gate row means off, and owners cannot write the gate.
  if not coalesce((select g.met from public.permission_ship_gates g where g.studio_id = p_studio and g.gate = 'staff_role_change'), false) then
    return public.perm_fail('gate_unmet', null, null, null, jsonb_build_object('gate', 'staff_role_change'));
  end if;
  -- NULL is refused explicitly: `null not in (...)` is null, not true, so a NULL role would skip this check and the reason rule below.
  if p_new_role is null or p_expected_current_role is null then return public.perm_fail('unknown_role'); end if;
  if p_new_role not in ('practitioner', 'receptionist') or p_expected_current_role not in ('practitioner', 'receptionist') then
    return public.perm_fail('owner_role_fixed');
  end if;
  if p_new_role = p_expected_current_role then return public.perm_fail('nothing_changed'); end if;
  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is not null and not public.perm_reason_ok(v_reason) then return public.perm_fail('reason_invalid'); end if;

  if p_expected_current_role = 'practitioner' then
    select pr.user_id, pr.display_name, pr.email, pr.active into v_user, v_name, v_email, v_active
      from public.practitioners pr where pr.id = p_membership and pr.studio_id = p_studio and pr.role = 'practitioner' for update;
    if not found then
      if exists (select 1 from public.practitioners pr where pr.id = p_membership and pr.studio_id = p_studio and pr.role = 'owner') then
        return public.perm_fail('owner_role_fixed');
      end if;
      return public.perm_fail('not_found');
    end if;
  else
    select r.user_id, r.display_name, r.email, r.active into v_user, v_name, v_email, v_active
      from public.studio_receptionists r where r.id = p_membership and r.studio_id = p_studio for update;
    if not found then return public.perm_fail('not_found'); end if;
  end if;
  if v_user is not null and v_user = auth.uid() then return public.perm_fail('self_change'); end if;
  if not v_active then return public.perm_fail('not_active'); end if;
  -- (After the membership checks, so a refusal never depends on the reason.) Moving a receptionist to practitioner widens clinical access, so a meaningful reason is required (Insurance RB-3).
  if p_expected_current_role = 'receptionist' and p_new_role = 'practitioner' and v_reason is null then
    return public.perm_fail('reason_required');
  end if;

  if p_expected_current_role = 'practitioner' then
    -- KNOWN GAP (Insurance RF-1), harmless while the staff_role_change gate is off: an appointment INSERTED after this count is not
    -- locked. Before the gate is turned on, lock the practitioner membership row and re-check after the update (see docs/production/rollback-0287-roles-engine.md).
    -- Lock the practitioner's future appointments, then count EVERY one that is not cancelled (confirmed, completed, no_show), so a
    -- concurrent change to one of them cannot slip past the check (Insurance RB-5).
    select count(*) into v_upcoming from (
      select ap.id from public.appointments ap
       where ap.studio_id = p_studio and ap.practitioner_id = p_membership and ap.status <> 'cancelled' and ap.starts_at > now()
       for update
    ) locked_upcoming;
    if v_upcoming > 0 then
      return public.perm_fail('has_upcoming_appointments', null, null, null, jsonb_build_object('count', v_upcoming));
    end if;
    update public.practitioners set active = false where id = p_membership;
    select r.id into v_new_id from public.studio_receptionists r where r.studio_id = p_studio and v_user is not null and r.user_id = v_user for update;
    if v_new_id is not null then
      update public.studio_receptionists set active = true, deactivated_at = null where id = v_new_id;
    else
      insert into public.studio_receptionists (studio_id, user_id, display_name, email, active, created_by_practitioner_id)
      values (p_studio, v_user, v_name, v_email, true, a.membership_id) returning id into v_new_id;
    end if;
    v_target_kind := 'receptionist';
  else
    if v_email is null then return public.perm_fail('email_required'); end if;
    update public.studio_receptionists set active = false, deactivated_at = now() where id = p_membership;
    select pr.id into v_new_id from public.practitioners pr where pr.studio_id = p_studio and v_user is not null and pr.user_id = v_user and pr.role = 'practitioner' for update;
    if v_new_id is not null then
      update public.practitioners set active = true where id = v_new_id;
    else
      insert into public.practitioners (studio_id, user_id, display_name, email, role, active)
      values (p_studio, v_user, v_name, v_email, 'practitioner', true) returning id into v_new_id;
    end if;
    v_target_kind := 'practitioner';
  end if;

  insert into public.permission_audit (studio_id, actor_user_id, actor_membership_id, kind, role, membership_id, membership_kind, before, after, reason)
  values (p_studio, auth.uid(), a.membership_id, 'staff_role_changed', p_new_role, v_new_id, v_target_kind,
          jsonb_build_object('role', p_expected_current_role, 'membership_id', p_membership),
          jsonb_build_object('role', p_new_role, 'membership_id', v_new_id), v_reason);
  return jsonb_build_object('ok', true, 'membership_id', v_new_id, 'role', p_new_role);
end;
$$;

revoke all on function public.change_staff_role(uuid, uuid, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.change_staff_role(uuid, uuid, text, text, text) to authenticated;

commit;
