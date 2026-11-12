-- 0331 — ROLES: a stored denial beats the new-studio default before its key is activated (Codex P2 on #1335; Sam: reconcile, then forward).
--
-- 0287 is APPLIED on hosted (7 Nov 2026) and its bytes are frozen. This migration corrects two of its helper functions by
-- `create or replace`, nothing else: no table, column, policy, index, trigger or data is touched.
--
-- The defect: perm_base_scope, on a new_studio basis whose basis_at is at or after the key's release, returned the new-studio DEFAULT even when
-- the owner had saved a LOWER value (a denial) before the release and had not activated the key. NARROWING NEVER WAITS FOR ACTIVATION
-- (Privacy AZ1): that denial must keep applying, otherwise a default hands back access the owner had withdrawn. The fix returns the stored value
-- when it is lower than the default; a stored value that is not lower is still inert for a widening, exactly as before.
-- perm_scope_source reports the same case as 'stored', so the owner's panel and the resolver agree.
--
-- Grants: both functions are internal helpers called only from SECURITY DEFINER functions. 0287 revoked them from public, anon, authenticated
-- and service_role and granted nothing back; `create or replace` keeps that ACL, and the revokes below restate it by name.
begin;
set local lock_timeout = '5s';

create or replace function public.perm_base_scope(p_studio uuid, p_role text, p_key text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c public.permission_catalog%rowtype;
  v_basis text;
  v_basis_at timestamptz;
  v_stored text;
  v_stored_at timestamptz;
  v_rel public.permission_key_release%rowtype;
  v_active boolean;
  v_snap text;
  v_cand text;
begin
  select * into c from public.permission_catalog where key = p_key;
  if not found then return 'off'; end if;
  v_snap := case p_role when 'practitioner' then c.snapshot_practitioner else c.snapshot_receptionist end;
  select spp.basis, spp.basis_at into v_basis, v_basis_at from public.studio_permission_policy spp where spp.studio_id = p_studio;
  v_basis := coalesce(v_basis, 'existing_snapshot');
  -- Activation rule: a key with no release row is unreleased, so only today's behaviour applies. Fail closed.
  select * into v_rel from public.permission_key_release r where r.key = p_key;
  if not found or v_rel.released_at is null then return v_snap; end if;   -- unreleased, or PENDING (enforcing code not live yet)
  select exists (select 1 from public.permission_key_activation k
                  where k.studio_id = p_studio and k.key = p_key and k.release_tag = v_rel.release_tag) into v_active;
  if c.owner_configurable then
    select s.scope, s.set_at into v_stored, v_stored_at from public.studio_role_permissions s where s.studio_id = p_studio and s.role = p_role and s.key = p_key;
  end if;
  if v_rel.release_kind = 'narrow' then
    -- NARROW release: the LESSER of the owner's value and today's snapshot. Narrowing applies at once; widening waits for a later FULL release.
    v_cand := coalesce(v_stored, case when v_basis = 'new_studio' and v_basis_at >= v_rel.released_at
                                      then case p_role when 'practitioner' then c.new_practitioner else c.new_receptionist end end, v_snap);
    return case when public.perm_rank(v_cand) < public.perm_rank(v_snap) then v_cand else v_snap end;
  end if;
  if v_stored is not null and (v_active or v_stored_at >= v_rel.released_at) then return v_stored; end if;
  if v_basis = 'new_studio' and (v_active or v_basis_at >= v_rel.released_at) then
    v_cand := case p_role when 'practitioner' then c.new_practitioner else c.new_receptionist end;
    -- A stored DENIAL (lower than the new-studio default) that pre-dates this release and is not yet activated still applies: narrowing never
    -- waits (Privacy AZ1), and returning the default here would hand back access the owner had already withdrawn (Codex P2, #1335).
    if v_stored is not null and public.perm_rank(v_stored) < public.perm_rank(v_cand) then return v_stored; end if;
    return v_cand;
  end if;
  -- NARROWING NEVER WAITS FOR ACTIVATION (Privacy AZ1). A stored or default value that pre-dates this release and has not been activated is
  -- inert for a WIDENING, but a value LOWER than today's snapshot keeps applying: otherwise upgrading a narrow release to full would silently
  -- hand back access an owner had already withdrawn.
  v_cand := coalesce(v_stored, case when v_basis = 'new_studio' then case p_role when 'practitioner' then c.new_practitioner else c.new_receptionist end end);
  if v_cand is not null and public.perm_rank(v_cand) < public.perm_rank(v_snap) then return v_cand; end if;
  return v_snap;
end;
$$;

create or replace function public.perm_scope_source(p_studio uuid, p_role text, p_key text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c public.permission_catalog%rowtype;
  v_basis text;
  v_basis_at timestamptz;
  v_stored text;
  v_stored_at timestamptz;
  v_rel public.permission_key_release%rowtype;
  v_active boolean;
  v_snap text;
  v_cand text;
begin
  select * into c from public.permission_catalog where key = p_key;
  if not found then return 'snapshot'; end if;
  v_snap := case p_role when 'practitioner' then c.snapshot_practitioner else c.snapshot_receptionist end;
  select spp.basis, spp.basis_at into v_basis, v_basis_at from public.studio_permission_policy spp where spp.studio_id = p_studio;
  v_basis := coalesce(v_basis, 'existing_snapshot');
  if c.owner_configurable then
    select s.scope, s.set_at into v_stored, v_stored_at from public.studio_role_permissions s where s.studio_id = p_studio and s.role = p_role and s.key = p_key;
  end if;
  select * into v_rel from public.permission_key_release r where r.key = p_key;
  if not found or v_rel.released_at is null then
    return case when v_stored is not null or v_basis = 'new_studio' then 'unreleased' else 'snapshot' end;
  end if;
  if v_rel.release_kind = 'narrow' then
    v_cand := coalesce(v_stored, case when v_basis = 'new_studio' and v_basis_at >= v_rel.released_at
                                      then case p_role when 'practitioner' then c.new_practitioner else c.new_receptionist end end);
    if v_cand is null then return 'snapshot'; end if;
    if public.perm_rank(v_cand) < public.perm_rank(v_snap) then return case when v_stored is not null then 'stored' else 'default' end; end if;
    return case when v_cand = v_snap then (case when v_stored is not null then 'stored' else 'snapshot' end) else 'inactive_until_activated' end;
  end if;
  select exists (select 1 from public.permission_key_activation k where k.studio_id = p_studio and k.key = p_key and k.release_tag = v_rel.release_tag) into v_active;
  -- Narrowing never waits for activation (Privacy AZ1): an inert value LOWER than the snapshot still applies, so it is reported as stored/default.
  if v_stored is not null then
    -- Mirrors perm_base_scope: a stored value also applies when it is a denial against the new-studio default that would otherwise be returned.
    v_cand := case p_role when 'practitioner' then c.new_practitioner else c.new_receptionist end;
    return case when v_active or v_stored_at >= v_rel.released_at or public.perm_rank(v_stored) < public.perm_rank(v_snap)
                  or (v_basis = 'new_studio' and v_basis_at >= v_rel.released_at and public.perm_rank(v_stored) < public.perm_rank(v_cand))
                then 'stored' else 'inactive_until_activated' end;
  end if;
  if v_basis = 'new_studio' then
    v_cand := case p_role when 'practitioner' then c.new_practitioner else c.new_receptionist end;
    return case when v_active or v_basis_at >= v_rel.released_at or public.perm_rank(v_cand) < public.perm_rank(v_snap) then 'default' else 'inactive_until_activated' end;
  end if;
  return 'snapshot';
end;
$$;

revoke all on function public.perm_base_scope(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.perm_scope_source(uuid, text, text) from public, anon, authenticated, service_role;

commit;
