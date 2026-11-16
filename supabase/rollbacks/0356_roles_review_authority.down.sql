-- Rollback of 0356: restore the 0355 body of perm_run_changes (md5 of its prosrc: 4e65b638a84cfba3d24c1fc44b34daa0, asserted by tests), then drop each new
-- function by its exact signature. Order matters: perm_run_changes must stop calling the internal function before it is dropped.
begin;
set local lock_timeout = '5s';

create or replace function public.perm_run_changes(
  p_studio uuid, p_changes jsonb, p_reason text, p_confirmed boolean,
  p_expected_version bigint, p_require_version boolean, p_commit boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  a record;
  c public.permission_catalog%rowtype;
  v_version bigint;
  v_new_version bigint;
  v_role text;
  v_key text;
  v_scope text;
  v_allowed text[];
  v_snap text;
  v_gate text;
  v_base text;
  v_basis text;
  v_default text;
  v_shown text;
  v_reason text;
  v_msg text;
  v_req text;
  v_cap text;
  v_roles text[] := '{}';
  v_before_eff jsonb := '{}'::jsonb;
  v_after_eff jsonb := '{}'::jsonb;
  v_apply jsonb := '[]'::jsonb;
  v_item jsonb;
  v_audit_before jsonb := '{}'::jsonb;
  v_audit_after jsonb := '{}'::jsonb;
  v_changes jsonb := '{}'::jsonb;
  v_affected jsonb := '{}'::jsonb;
  v_sens jsonb := '[]'::jsonb;
  v_changed boolean := false;
  v_stored_prev text;
  v_widen boolean := false;
  v_result jsonb;
begin
  select * into a from public.perm_actor(p_studio);
  if not found or a.role <> 'owner' then return public.perm_fail('refused'); end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then return public.perm_fail('invalid_changes'); end if;
  v_reason := nullif(btrim(coalesce(p_reason, '')), '');

  begin
    insert into public.studio_permission_policy (studio_id, basis, version) values (p_studio, 'existing_snapshot', 0) on conflict do nothing;
    -- 0355: the basis is read under the same row lock as the version, so a concurrent adopt or reset cannot change it between the read and the compare.
    select spp.version, spp.basis into v_version, v_basis from public.studio_permission_policy spp where spp.studio_id = p_studio for update;
    v_basis := coalesce(v_basis, 'existing_snapshot');
    if p_expected_version is null and p_require_version then
      raise exception using errcode = 'PM001', message = public.perm_fail('version_required', null, null, v_version)::text;
    end if;
    if p_expected_version is not null and p_expected_version <> v_version then
      raise exception using errcode = 'PM001', message = public.perm_fail('stale_version', null, null, v_version)::text;
    end if;

    for v_role in select jsonb_object_keys(p_changes) loop
      if v_role not in ('practitioner', 'receptionist') or jsonb_typeof(p_changes -> v_role) <> 'object' then
        raise exception using errcode = 'PM001', message = public.perm_fail('unknown_role', null, v_role)::text;
      end if;
      v_roles := v_roles || v_role;
      v_before_eff := v_before_eff || jsonb_build_object(v_role, public.perm_effective_map(p_studio, v_role));
    end loop;
    if cardinality(v_roles) = 0 then
      raise exception using errcode = 'PM001', message = public.perm_fail('nothing_changed')::text;
    end if;

    foreach v_role in array v_roles loop
      for v_key in select jsonb_object_keys(p_changes -> v_role) loop
        select * into c from public.permission_catalog where key = v_key;
        if not found then
          raise exception using errcode = 'PM001', message = public.perm_fail('unknown_key', v_key, v_role)::text;
        end if;
        if jsonb_typeof(p_changes -> v_role -> v_key) <> 'string' then
          raise exception using errcode = 'PM001', message = public.perm_fail('scope_not_allowed', v_key, v_role)::text;
        end if;
        v_scope := p_changes -> v_role ->> v_key;
        if not c.owner_configurable then
          raise exception using errcode = 'PM001', message = public.perm_fail('fixed_key', v_key, v_role)::text;
        end if;
        if v_scope <> 'off' and not (case v_role when 'practitioner' then c.offered_practitioner else c.offered_receptionist end) then
          raise exception using errcode = 'PM001', message = public.perm_fail('not_offered', v_key, v_role)::text;
        end if;
        v_allowed := case when v_role = 'receptionist' then array_remove(c.scopes, 'own') else c.scopes end;
        if not (v_scope = any (v_allowed)) then
          raise exception using errcode = 'PM001', message = public.perm_fail('scope_not_allowed', v_key, v_role)::text;
        end if;
        v_snap := case v_role when 'practitioner' then c.snapshot_practitioner else c.snapshot_receptionist end;
        v_gate := case v_role when 'practitioner' then c.gate_practitioner else c.gate_receptionist end;
        if v_gate is not null
           and not coalesce((select g.met from public.permission_ship_gates g where g.studio_id = p_studio and g.gate = v_gate), false)
           and public.perm_rank(v_scope) > public.perm_rank(v_snap) then
          raise exception using errcode = 'PM001', message = public.perm_fail('gate_unmet', v_key, v_role, null, jsonb_build_object('gate', v_gate))::text;
        end if;
        v_base := public.perm_base_scope(p_studio, v_role, v_key);
        -- The owner's STORED intent is compared as well as the effective value: a stored choice that is inactive (set before its key's
        -- release, no activation) resolves to the snapshot, so saving the snapshot value must still REPLACE it (Discard must work).
        select s.scope into v_stored_prev from public.studio_role_permissions s where s.studio_id = p_studio and s.role = v_role and s.key = v_key;
        -- 0355: the value the owner SEES for a row with no stored choice is the studio's own basis (the new-studio default on a new studio,
        -- the snapshot on an existing one), which is not the value perm_base_scope returns while the key is unreleased. A request that matches
        -- the unreleased base but differs from what the owner sees is a real choice (an inert Off on a new-studio default) and must be stored.
        v_default := case when v_basis = 'new_studio' then case v_role when 'practitioner' then c.new_practitioner else c.new_receptionist end else v_snap end;
        v_shown := coalesce(v_stored_prev, v_default);
        if v_scope <> v_base or (v_stored_prev is not null and v_stored_prev <> v_scope) or v_scope <> v_shown then
          v_changed := true;
          v_apply := v_apply || jsonb_build_array(jsonb_build_object('role', v_role, 'key', v_key, 'scope', v_scope, 'base', coalesce(v_stored_prev, case when v_scope <> v_base then v_base else v_shown end)));
        end if;
      end loop;
    end loop;
    if not v_changed then
      raise exception using errcode = 'PM001', message = public.perm_fail('nothing_changed')::text;
    end if;

    for v_item in select * from jsonb_array_elements(v_apply) loop
      insert into public.studio_role_permissions (studio_id, role, key, scope)
      values (p_studio, v_item ->> 'role', v_item ->> 'key', v_item ->> 'scope')
      on conflict (studio_id, role, key) do update set scope = excluded.scope, set_at = now();
    end loop;

    -- Prerequisites must hold on the RESULTING set.
    for v_item in select * from jsonb_array_elements(v_apply) loop
      select * into c from public.permission_catalog where key = v_item ->> 'key';
      foreach v_req in array c.requires loop
        v_cap := public.perm_effective_scope(p_studio, v_item ->> 'role', v_req, array[v_item ->> 'key']);
        if public.perm_rank(v_cap) < public.perm_rank(v_item ->> 'scope') then
          raise exception using errcode = 'PM001',
            message = public.perm_fail('prerequisite_unmet', v_item ->> 'key', v_item ->> 'role', null, jsonb_build_object('blocked_by', v_req))::text;
        end if;
      end loop;
    end loop;

    foreach v_role in array v_roles loop
      v_after_eff := v_after_eff || jsonb_build_object(v_role, public.perm_effective_map(p_studio, v_role));
      v_changes := v_changes || jsonb_build_object(v_role, public.perm_diff(v_before_eff -> v_role, v_after_eff -> v_role));
      v_affected := v_affected || jsonb_build_object(v_role, public.perm_affected_people(p_studio, v_role));
      -- A reason and a confirmation are required when a SENSITIVE key's EFFECTIVE scope rises for any affected role, whether the owner
      -- edited that key or only raised a prerequisite that had been capping it. Judged on the resulting maps.
      select v_sens || coalesce(jsonb_agg(e.key order by e.key), '[]'::jsonb) into v_sens
        from jsonb_each_text(v_after_eff -> v_role) e
        join public.permission_catalog pc on pc.key = e.key
       where pc.sensitive and public.perm_rank(e.value) > public.perm_rank(v_before_eff -> v_role ->> e.key);
    end loop;
    v_widen := jsonb_array_length(v_sens) > 0;

    if v_widen and p_commit then
      if not coalesce(p_confirmed, false) then
        raise exception using errcode = 'PM001', message = public.perm_fail('sensitive_unconfirmed')::text;
      end if;
      if not public.perm_reason_ok(v_reason) then
        raise exception using errcode = 'PM001', message = public.perm_fail('reason_required')::text;
      end if;
    elsif v_reason is not null and not public.perm_reason_ok(v_reason) then
      raise exception using errcode = 'PM001', message = public.perm_fail('reason_invalid')::text;
    end if;

    v_result := jsonb_build_object(
      'ok', true, 'version', v_version, 'changes', v_changes, 'affected', v_affected,
      'reason_required', v_widen, 'sensitive_keys', v_sens
    );

    if not p_commit then
      raise exception using errcode = 'PM002', message = 'preview';
    end if;

    update public.studio_permission_policy set version = version + 1 where studio_id = p_studio returning version into v_new_version;
    foreach v_role in array v_roles loop
      v_audit_before := '{}'::jsonb;
      v_audit_after := '{}'::jsonb;
      for v_item in select value from jsonb_array_elements(v_apply) where value ->> 'role' = v_role loop
        v_audit_before := v_audit_before || jsonb_build_object(v_item ->> 'key',
          jsonb_build_object('stored', v_item ->> 'base', 'effective', v_before_eff -> v_role ->> (v_item ->> 'key')));
        v_audit_after := v_audit_after || jsonb_build_object(v_item ->> 'key',
          jsonb_build_object('stored', v_item ->> 'scope', 'effective', v_after_eff -> v_role ->> (v_item ->> 'key')));
      end loop;
      if v_audit_after <> '{}'::jsonb then
        insert into public.permission_audit (studio_id, actor_user_id, actor_membership_id, kind, role, before, after, reason, policy_version_before, policy_version_after)
        values (p_studio, auth.uid(), a.membership_id, 'role_permissions_saved', v_role, v_audit_before, v_audit_after, v_reason, v_version, v_new_version);
      end if;
    end loop;
    return v_result || jsonb_build_object('new_version', v_new_version);
  exception
    when sqlstate 'PM001' then
      get stacked diagnostics v_msg = message_text;
      return v_msg::jsonb;
    when sqlstate 'PM002' then
      return v_result;
  end;
end;
$$;

revoke all on function public.perm_run_changes(uuid, jsonb, text, boolean, bigint, boolean, boolean) from public, anon, authenticated, service_role;

drop function public.save_role_permissions_reviewed(uuid, bigint, jsonb, text, boolean, text);
drop function public.preview_role_changes_at(uuid, jsonb, bigint);
drop function public.perm_run_changes_reviewed(uuid, jsonb, text, boolean, bigint, boolean, boolean, text);
drop function public.perm_review_hash(uuid, bigint, jsonb, jsonb, boolean);
drop function public.perm_review_hash_input(uuid, bigint, jsonb, jsonb, boolean);
drop function public.perm_review_timing(boolean, text, text, text, text, text, boolean, boolean);
drop function public.perm_review_involved(text[]);

commit;
