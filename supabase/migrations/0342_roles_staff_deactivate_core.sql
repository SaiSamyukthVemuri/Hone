-- 0342 — ROLES S2: deactivate and reactivate staff THROUGH the permission core, with a reason, an audit row and a locked upcoming-appointments check.
--
-- Why: removal today is the Team page calling set_practitioner_active_locked (0150) with the admin client. It records no reason and no audit row
-- (so Roles > History never shows a removal), has no upcoming-appointments rule, and has no receptionist path at all. This adds two owner-only
-- commands in the style of change_staff_role (0287), widens the audit kinds, and closes Insurance RF-1 in change_staff_role.
--
-- Forward migration: 0287, 0331 and 0332 are frozen; nothing here edits them. Objects touched:
--   * permission_audit.kind CHECK widened by two kinds (staff_deactivated, staff_reactivated). The existing rows and the append-only trigger are untouched.
--   * new perm_upcoming_policy(): THE SWITCH for what an upcoming appointment means for a deactivation. 'block' (shipped) refuses; 'keep' allows it and leaves the
--     appointments assigned (today's behaviour); 'reassign' refuses with reassign_required until a reassign command exists. A change of Sam's decision is a
--     create or replace of this one function.
--   * new deactivate_staff_member / reactivate_staff_member (owner-only, authenticated only).
--   * change_staff_role replaced by create or replace: identical to 0287 except that it now takes the studio capacity lock before it counts upcoming
--     appointments (RF-1). Same signature, same ACL (restated below).
--
-- practitioners.active / studio_receptionists.active stay the single flag. The clinical read gates (0333-0336) key on practitioners.active, so a deactivation
-- cuts clinical reads at once and a reactivation restores them. Nothing is deleted, so appointments, notes and history stay.
--
-- Ship gate: deactivate has NO new gate (removal exists today and gating it would take a working capability away). reactivate is NEW capability and is
-- refused unless the operator has set the staff_role_change gate for the studio, the same gate change_staff_role uses.
-- RF-1: appointment writers take acquire_studio_capacity_lock; the commands take it too, before the count, so no appointment can be inserted between the count
-- and the update. The DB test must prove it with two sessions; do not rely on this comment.
--
-- Grants: every function is revoked from public, anon, authenticated AND service_role by name, then the three commands are granted to authenticated alone.
begin;
set local lock_timeout = '5s';

-- 1) audit kinds. The CHECK in 0287 is unnamed; find it by its definition, drop it, add it back named with the two new kinds.
do $$
declare c text;
begin
  for c in
    select con.conname from pg_constraint con
     where con.conrelid = 'public.permission_audit'::regclass and con.contype = 'c' and pg_get_constraintdef(con.oid) like '%role_permissions_saved%'
  loop
    execute format('alter table public.permission_audit drop constraint %I', c);
  end loop;
end $$;
alter table public.permission_audit add constraint permission_audit_kind_check
  check (kind in ('role_permissions_saved', 'defaults_adopted', 'role_reset', 'staff_role_changed', 'permissions_activated', 'staff_deactivated', 'staff_reactivated'));

-- 2) the switch
create or replace function public.perm_upcoming_policy()
returns text language sql immutable set search_path = ''
as $$ select 'block'::text $$;

-- 3) deactivate
create or replace function public.deactivate_staff_member(p_studio uuid, p_membership uuid, p_kind text, p_reason text default null)
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
  v_active boolean;
  v_role text;
  v_upcoming bigint := 0;
  v_policy text;
begin
  select * into a from public.perm_actor(p_studio);
  if not found or a.role <> 'owner' then return public.perm_fail('refused'); end if;
  if p_kind is null or p_kind not in ('practitioner', 'receptionist') then return public.perm_fail('unknown_role'); end if;
  if p_membership is null then return public.perm_fail('not_found'); end if;

  -- The lock comes first: it serialises with every appointment writer, so the count below cannot be overtaken (RF-1).
  if p_kind = 'practitioner' then perform public.acquire_studio_capacity_lock(p_studio); end if;

  if p_kind = 'practitioner' then
    select pr.user_id, pr.active, pr.role into v_user, v_active, v_role
      from public.practitioners pr where pr.id = p_membership and pr.studio_id = p_studio for update;
    if not found then return public.perm_fail('not_found'); end if;
    if v_role = 'owner' then return public.perm_fail('owner_role_fixed'); end if;
  else
    select r.user_id, r.active into v_user, v_active
      from public.studio_receptionists r where r.id = p_membership and r.studio_id = p_studio for update;
    if not found then return public.perm_fail('not_found'); end if;
  end if;
  if v_user is not null and v_user = auth.uid() then return public.perm_fail('self_change'); end if;
  if not v_active then return public.perm_fail('not_active'); end if;

  -- After the membership checks, so a refusal never depends on the reason.
  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null then return public.perm_fail('reason_required'); end if;
  if not public.perm_reason_ok(v_reason) then return public.perm_fail('reason_invalid'); end if;

  if p_kind = 'practitioner' then
    v_policy := public.perm_upcoming_policy();
    if v_policy <> 'keep' then
      -- Lock the future appointments, then count every one that is not cancelled (same rule as change_staff_role, Insurance RB-5).
      select count(*) into v_upcoming from (
        select ap.id from public.appointments ap
         where ap.studio_id = p_studio and ap.practitioner_id = p_membership and ap.status <> 'cancelled' and ap.starts_at > now()
         for update
      ) locked_upcoming;
      if v_upcoming > 0 then
        return public.perm_fail(case when v_policy = 'reassign' then 'reassign_required' else 'has_upcoming_appointments' end,
                                null, null, null, jsonb_build_object('count', v_upcoming));
      end if;
    end if;
    update public.practitioners set active = false where id = p_membership;
  else
    update public.studio_receptionists set active = false, deactivated_at = now() where id = p_membership;
  end if;

  insert into public.permission_audit (studio_id, actor_user_id, actor_membership_id, kind, role, membership_id, membership_kind, before, after, reason)
  values (p_studio, auth.uid(), a.membership_id, 'staff_deactivated', p_kind, p_membership, p_kind,
          jsonb_build_object('active', true), jsonb_build_object('active', false, 'upcoming_kept', v_upcoming), v_reason);
  return jsonb_build_object('ok', true, 'membership_id', p_membership, 'kind', p_kind, 'active', false);
end;
$$;

-- 4) reactivate (new capability: behind the staff_role_change gate)
create or replace function public.reactivate_staff_member(p_studio uuid, p_membership uuid, p_kind text, p_reason text default null)
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
  v_active boolean;
  v_role text;
  v_email text;
begin
  select * into a from public.perm_actor(p_studio);
  if not found or a.role <> 'owner' then return public.perm_fail('refused'); end if;
  if not coalesce((select g.met from public.permission_ship_gates g where g.studio_id = p_studio and g.gate = 'staff_role_change'), false) then
    return public.perm_fail('gate_unmet', null, null, null, jsonb_build_object('gate', 'staff_role_change'));
  end if;
  if p_kind is null or p_kind not in ('practitioner', 'receptionist') then return public.perm_fail('unknown_role'); end if;
  if p_membership is null then return public.perm_fail('not_found'); end if;

  if p_kind = 'practitioner' then
    perform public.acquire_studio_capacity_lock(p_studio);
    select pr.user_id, pr.active, pr.role into v_user, v_active, v_role
      from public.practitioners pr where pr.id = p_membership and pr.studio_id = p_studio for update;
    if not found then return public.perm_fail('not_found'); end if;
    if v_role = 'owner' then return public.perm_fail('owner_role_fixed'); end if;
  else
    select r.user_id, r.active, r.email into v_user, v_active, v_email
      from public.studio_receptionists r where r.id = p_membership and r.studio_id = p_studio for update;
    if not found then return public.perm_fail('not_found'); end if;
  end if;
  if v_user is not null and v_user = auth.uid() then return public.perm_fail('self_change'); end if;
  if v_active then return public.perm_fail('already_active'); end if;
  -- A person holds ONE active membership in a studio: restoring this one while another is active would give them two (change_staff_role keeps the same invariant).
  if v_user is not null and (
       exists (select 1 from public.practitioners pr where pr.studio_id = p_studio and pr.user_id = v_user and pr.active and pr.id <> p_membership)
    or exists (select 1 from public.studio_receptionists r where r.studio_id = p_studio and r.user_id = v_user and r.active and r.id <> p_membership)) then
    return public.perm_fail('other_membership_active');
  end if;
  if p_kind = 'receptionist' and v_email is null then return public.perm_fail('email_required'); end if;

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null then return public.perm_fail('reason_required'); end if;
  if not public.perm_reason_ok(v_reason) then return public.perm_fail('reason_invalid'); end if;

  if p_kind = 'practitioner' then
    update public.practitioners set active = true where id = p_membership;
  else
    update public.studio_receptionists set active = true, deactivated_at = null where id = p_membership;
  end if;

  insert into public.permission_audit (studio_id, actor_user_id, actor_membership_id, kind, role, membership_id, membership_kind, before, after, reason)
  values (p_studio, auth.uid(), a.membership_id, 'staff_reactivated', p_kind, p_membership, p_kind,
          jsonb_build_object('active', false), jsonb_build_object('active', true), v_reason);
  return jsonb_build_object('ok', true, 'membership_id', p_membership, 'kind', p_kind, 'active', true);
end;
$$;

-- 5) change_staff_role: 0287's body with ONE change, the capacity lock before the count (RF-1).
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
    -- RF-1 (Insurance), closed by 0342: take the studio's capacity lock BEFORE counting. Every appointment writer (booking, move, repair,
    -- waitlist conversion) takes the same lock, so no appointment can be inserted between this count and the update below.
    perform public.acquire_studio_capacity_lock(p_studio);
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

-- 6) grants
revoke all on function public.perm_upcoming_policy() from public, anon, authenticated, service_role;
revoke all on function public.deactivate_staff_member(uuid, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.reactivate_staff_member(uuid, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.change_staff_role(uuid, uuid, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.deactivate_staff_member(uuid, uuid, text, text) to authenticated;
grant execute on function public.reactivate_staff_member(uuid, uuid, text, text) to authenticated;
grant execute on function public.change_staff_role(uuid, uuid, text, text, text) to authenticated;

commit;
