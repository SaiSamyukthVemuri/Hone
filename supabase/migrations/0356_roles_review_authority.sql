-- 0356: ONE review table, built by the database, for the exact policy version a save will check.
--
-- THE PROBLEM. The Roles page decided in the browser what each key's "before" was and what a save would do, while the database decided it again at
-- save time, differently. The preview returned only the effective diff, so with nothing released it could not say what was stored, what the owner
-- was shown, or whether a row would be written at all. A stale tab could show a "before" that another session had already replaced, and a save bound
-- to the PREVIEW's version would silently replace that other change.
--
-- WHAT THIS ADDS (functions only; no table, column, policy, index or data is touched):
--   perm_run_changes_reviewed(8 args)  INTERNAL. The 0355 body of perm_run_changes plus one parameter (p_review_hash) and these declared lines only:
--       (1) declarations v_applies, v_rows, v_review, v_hash;
--       (2) v_applies is computed once and a row is recorded for every requested key (role, key, stored_before, shown_before, requested, written, snapshot);
--       (3) after the effective maps exist, the review table and its hash are built;
--       (4) a commit that carries a review hash refuses with review_changed if the recomputed hash differs;
--       (5) the result gains `review`, `review_version`, `review_hash`; every existing result key keeps its name and type;
--       (6) a reviewed commit records {version, hash} under `_review` inside the audit row's `after`; with no hash nothing is added.
--   perm_run_changes(7 args)  unchanged head and ACL; it delegates with a null hash and strips the three new keys, so its callers (the old preview and
--       save commands) see exactly what 0355 returned.
--   preview_role_changes_at(uuid, jsonb, bigint)  the preview WITH the page's expected version (the version check runs when commit is false) and the table.
--   save_role_permissions_reviewed(uuid, bigint, jsonb, text, boolean, text)  the save that requires a version AND the review hash.
--   perm_review_involved, perm_review_timing, perm_review_hash_input, perm_review_hash  INTERNAL helpers.
--
-- THE HASH IS A CONSISTENCY TOKEN, NOT AUTHORIZATION. The owner and studio checks run first; the hash is recomputed on the server and only compared;
-- the version check stays. The studio id is part of the hash input (never returned), so another studio's hash cannot validate. The input is
-- the fixed field list in perm_review_hash_input: any name, reason or free text added to it needs a privacy review. Encoding: sha256 over the UTF-8 of
-- the canonical jsonb text (jsonb orders object keys deterministically; every array is built with an explicit order by; timestamps are UTC ISO text).
--
-- LOCKING. The save takes the policy row lock (select ... for update) first, then `for share` on the involved keys' permission_key_release rows, so a
-- release cannot commit between the recompute and the commit; then the single recompute-and-commit below.
--
-- NOT CHANGED. perm_base_scope, perm_effective_scope and so effective access; reset, adopt and activation (they keep their own version and hash checks).
-- Grants: every new function is revoked from public, anon, authenticated and service_role by name; only the two commands are granted, to authenticated.
-- Rollback: supabase/rollbacks/0356_*.down.sql restores the 0355 body (md5 4e65b638a84cfba3d24c1fc44b34daa0) and drops each new function by exact signature.

begin;
set local lock_timeout = '5s';

-- The keys a review involves: the requested keys and everything they require, transitively.
create or replace function public.perm_review_involved(p_keys text[])
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  with recursive k(key) as (
    select unnest(p_keys)
    union
    select unnest(c.requires) from public.permission_catalog c join k on c.key = k.key
  )
  select coalesce(array_agg(distinct key order by key), '{}'::text[]) from k
$$;

-- When a saved choice takes effect, from facts only: whether the key is released, its release kind, the snapshot, what was asked, what was in force before
-- and after the write (the engine's own answers), whether the call writes the row, and whether the owner activated this release.
-- Engine facts this encodes (0287 perm_base_scope): before release a stored choice is inert; at release a LOWERING applies at once; a stored value takes effect
-- when it was set at or after the release (set_at resets on every save, and the test is >=), so a raise SAVED after a full release is in force at once and a
-- re-save applies an old one; a raise on a NARROW release stays at the snapshot until a later full release, and activation does not help.
create or replace function public.perm_review_timing(
  p_released boolean, p_kind text, p_snapshot text, p_requested text, p_effective_before text, p_effective_after text, p_written boolean, p_active boolean
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if not p_written then
    return 'no_change';
  end if;
  if not coalesce(p_released, false) then
    return case when public.perm_rank(p_requested) < public.perm_rank(p_snapshot) then 'at_release' else 'not_released' end;
  end if;
  if p_kind = 'narrow' and public.perm_rank(p_requested) > public.perm_rank(p_snapshot) then
    return 'waits_for_full_release';
  end if;
  -- A write that is in force the moment it is saved: a lowering always, and a raise on a full release (set_at >= released_at). Whether the
  -- effective value MOVES decides the word: it moves, so the review says it takes effect on save; it does not, so it is already in force.
  if p_effective_after = p_requested then
    return case when p_effective_after <> p_effective_before then 'applies_on_save' else 'in_force_now' end;
  end if;
  -- Reachable only through a race: a save whose transaction started BEFORE a release that committed before the save took its share lock stores a
  -- set_at earlier than released_at, so a raise is not in force and no honest word exists. Refuse it as a changed review (a fresh transaction
  -- sees the release and says the true thing) instead of printing a word that may be untrue. A perm_fail refusal, so the caller returns it
  -- cleanly; no data in it.
  raise exception using errcode = 'PM001', message = public.perm_fail('review_changed')::text;
end
$$;

-- The exact, fixed input of the review hash. PRIVACY: this is the covered field list; adding a name, a reason or any free text needs review.
-- Fields: v, studio, version, basis, basis_at, review, sensitive_keys, reason_required, releases, activations, catalog, gates.
create or replace function public.perm_review_hash_input(p_studio uuid, p_version bigint, p_review jsonb, p_sens jsonb, p_widen boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with involved as (
    select public.perm_review_involved(coalesce((select array_agg(distinct r.value ->> 'key') from jsonb_array_elements(p_review) r(value)), '{}'::text[])) as keys
  )
  select jsonb_build_object(
    'v', 1,
    'studio', p_studio,
    'version', p_version,
    'basis', (select spp.basis from public.studio_permission_policy spp where spp.studio_id = p_studio),
    -- basis_at matters to the engine only on the new_studio basis (a default counts for a key released at or before it). On existing_snapshot it is the
    -- column's now() default, which differs between the preview's transient row (rolled back) and the save's real one for a studio with no policy
    -- row yet: hashing it would make the first reviewed save of every such studio return review_changed (the first reviewed save of such a studio could never succeed). Hash the stored state.
    'basis_at', (select case when spp.basis = 'new_studio' then to_char(spp.basis_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end
                   from public.studio_permission_policy spp where spp.studio_id = p_studio),
    'review', p_review,
    'sensitive_keys', (select coalesce(jsonb_agg(x order by x), '[]'::jsonb) from jsonb_array_elements_text(p_sens) x),
    'reason_required', p_widen,
    'releases', (select coalesce(jsonb_agg(jsonb_build_object(
                    'key', r.key, 'tag', r.release_tag, 'kind', r.release_kind,
                    'at', to_char(r.released_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) order by r.key), '[]'::jsonb)
                   from public.permission_key_release r where r.key = any (coalesce((select i.keys from involved i), '{}'::text[]))),
    'activations', (select coalesce(jsonb_agg(jsonb_build_object('key', k.key, 'tag', k.release_tag) order by k.key, k.release_tag), '[]'::jsonb)
                      from public.permission_key_activation k where k.studio_id = p_studio and k.key = any (coalesce((select i.keys from involved i), '{}'::text[]))),
    'catalog', (select coalesce(jsonb_agg(jsonb_build_object(
                    'key', c.key,
                    'scopes', (select coalesce(jsonb_agg(s order by s), '[]'::jsonb) from unnest(c.scopes) s),
                    'snapshot_practitioner', c.snapshot_practitioner, 'snapshot_receptionist', c.snapshot_receptionist,
                    'new_practitioner', c.new_practitioner, 'new_receptionist', c.new_receptionist,
                    'offered_practitioner', c.offered_practitioner, 'offered_receptionist', c.offered_receptionist,
                    'owner_configurable', c.owner_configurable,
                    'requires', (select coalesce(jsonb_agg(q order by q), '[]'::jsonb) from unnest(c.requires) q),
                    'gate_practitioner', c.gate_practitioner, 'gate_receptionist', c.gate_receptionist,
                    'sensitive', c.sensitive) order by c.key), '[]'::jsonb)
                  from public.permission_catalog c where c.key = any (coalesce((select i.keys from involved i), '{}'::text[]))),
    'gates', (select coalesce(jsonb_agg(jsonb_build_object('gate', g.gate, 'met', g.met) order by g.gate), '[]'::jsonb)
                from public.permission_ship_gates g
               where g.studio_id = p_studio
                 and g.gate in (select x from public.permission_catalog c, unnest(array[c.gate_practitioner, c.gate_receptionist]) x
                                 where c.key = any (coalesce((select i.keys from involved i), '{}'::text[])) and x is not null))
  )
$$;

create or replace function public.perm_review_hash(p_studio uuid, p_version bigint, p_review jsonb, p_sens jsonb, p_widen boolean)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select encode(sha256(convert_to(public.perm_review_hash_input(p_studio, p_version, p_review, p_sens, p_widen)::text, 'UTF8')), 'hex')
$$;

-- INTERNAL. The 0355 body of perm_run_changes with one more parameter; the declared differences are listed in the header.
create or replace function public.perm_run_changes_reviewed(
  p_studio uuid, p_changes jsonb, p_reason text, p_confirmed boolean,
  p_expected_version bigint, p_require_version boolean, p_commit boolean, p_review_hash text
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
  -- 0356
  v_applies boolean;
  v_rows jsonb := '[]'::jsonb;
  v_review jsonb := '[]'::jsonb;
  v_hash text;
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
        v_applies := v_scope <> v_base or (v_stored_prev is not null and v_stored_prev <> v_scope) or v_scope <> v_shown;
        -- 0356: every requested key is recorded with what was stored, what the owner was shown, and whether this call writes it.
        v_rows := v_rows || jsonb_build_array(jsonb_build_object('role', v_role, 'key', v_key, 'stored_before', v_stored_prev, 'shown_before', v_shown,
                                                                  'requested', v_scope, 'written', v_applies, 'snapshot', v_snap));
        if v_applies then
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

    -- 0356: the review table, built from the same values the decision above used, then its hash. Nothing here is free text.
    select coalesce(jsonb_agg(jsonb_build_object(
             'role', r.value ->> 'role',
             'key', r.value ->> 'key',
             'stored_before', r.value -> 'stored_before',
             'shown_before', r.value -> 'shown_before',
             'requested', r.value -> 'requested',
             'stored_after', case when (r.value ->> 'written')::boolean then r.value -> 'requested' else r.value -> 'stored_before' end,
             'written', (r.value ->> 'written')::boolean,
             'effective_before', v_before_eff -> (r.value ->> 'role') ->> (r.value ->> 'key'),
             'effective_after', v_after_eff -> (r.value ->> 'role') ->> (r.value ->> 'key'),
             'timing', public.perm_review_timing(
                         rel.released_at is not null, rel.release_kind, r.value ->> 'snapshot', r.value ->> 'requested',
                         v_before_eff -> (r.value ->> 'role') ->> (r.value ->> 'key'),
                         v_after_eff -> (r.value ->> 'role') ->> (r.value ->> 'key'), (r.value ->> 'written')::boolean,
                         exists (select 1 from public.permission_key_activation k
                                  where k.studio_id = p_studio and k.key = r.value ->> 'key' and k.release_tag = rel.release_tag))
           ) order by r.value ->> 'role', r.value ->> 'key'), '[]'::jsonb)
      into v_review
      from jsonb_array_elements(v_rows) r(value)
      left join public.permission_key_release rel on rel.key = r.value ->> 'key';
    v_hash := public.perm_review_hash(p_studio, v_version, v_review, v_sens, v_widen);
    if p_commit and p_review_hash is not null and p_review_hash <> v_hash then
      raise exception using errcode = 'PM001', message = public.perm_fail('review_changed', null, null, v_version)::text;
    end if;

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
      'reason_required', v_widen, 'sensitive_keys', v_sens,
      'review', v_review, 'review_version', v_version, 'review_hash', v_hash
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
        -- 0356: a reviewed save records which review it was (version and hash), inside `after`. Nothing else is added.
        if p_review_hash is not null then
          v_audit_after := v_audit_after || jsonb_build_object('_review', jsonb_build_object('version', v_version, 'hash', v_hash));
        end if;
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

-- The 7-argument command keeps its exact head and ACL. It delegates with no review hash and hands back exactly what 0355 returned.
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
begin
  return public.perm_run_changes_reviewed(p_studio, p_changes, p_reason, p_confirmed, p_expected_version, p_require_version, p_commit, null)
         - 'review' - 'review_version' - 'review_hash';
end;
$$;

-- The preview a page can trust: it takes the version the page's values were read at and refuses stale_version when it differs (the check runs when
-- commit is false), and it returns the review table and hash.
create or replace function public.preview_role_changes_at(p_studio uuid, p_changes jsonb, p_expected_version bigint)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$ select public.perm_run_changes_reviewed(p_studio, p_changes, null, false, p_expected_version, true, false, null) $$;

-- The save that requires BOTH the version and the review hash. Owner and studio first; the hash is only compared, never trusted.
create or replace function public.save_role_permissions_reviewed(
  p_studio uuid, p_expected_version bigint, p_changes jsonb, p_reason text, p_sensitive_confirmed boolean, p_review_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  a record;
  v_version bigint;
  v_keys text[];
begin
  select * into a from public.perm_actor(p_studio);
  if not found or a.role <> 'owner' then return public.perm_fail('refused'); end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then return public.perm_fail('invalid_changes'); end if;
  if p_expected_version is null then return public.perm_fail('version_required'); end if;
  if p_review_hash is null or btrim(p_review_hash) = '' then return public.perm_fail('review_hash_required'); end if;
  -- WHAT A REFUSAL LEAVES BEHIND: this default policy row (basis existing_snapshot, version 0) is written before the checks below, for a studio that has
  -- none yet, and it stays when the save is then refused (review_changed, stale_version, a validation code). It is the row any later save or read would
  -- create, changes no one's access, and is the only write a refused save can make: no role rows, no audit row, no version bump.
  insert into public.studio_permission_policy (studio_id, basis, version) values (p_studio, 'existing_snapshot', 0) on conflict do nothing;
  select spp.version into v_version from public.studio_permission_policy spp where spp.studio_id = p_studio for update;
  if p_expected_version <> v_version then return public.perm_fail('stale_version', null, null, v_version); end if;
  -- A release cannot commit between the recompute and the commit below: it waits for these share locks.
  select coalesce(array_agg(distinct k), '{}'::text[]) into v_keys
    from jsonb_each(p_changes) r(role, v), lateral jsonb_object_keys(case when jsonb_typeof(r.v) = 'object' then r.v else '{}'::jsonb end) k;
  perform 1 from public.permission_key_release rel where rel.key = any (public.perm_review_involved(v_keys)) order by rel.key for share;
  return public.perm_run_changes_reviewed(p_studio, p_changes, p_reason, p_sensitive_confirmed, p_expected_version, true, true, p_review_hash);
end;
$$;

revoke all on function public.perm_review_involved(text[]) from public, anon, authenticated, service_role;
revoke all on function public.perm_review_timing(boolean, text, text, text, text, text, boolean, boolean) from public, anon, authenticated, service_role;
revoke all on function public.perm_review_hash_input(uuid, bigint, jsonb, jsonb, boolean) from public, anon, authenticated, service_role;
revoke all on function public.perm_review_hash(uuid, bigint, jsonb, jsonb, boolean) from public, anon, authenticated, service_role;
revoke all on function public.perm_run_changes_reviewed(uuid, jsonb, text, boolean, bigint, boolean, boolean, text) from public, anon, authenticated, service_role;
revoke all on function public.perm_run_changes(uuid, jsonb, text, boolean, bigint, boolean, boolean) from public, anon, authenticated, service_role;
revoke all on function public.preview_role_changes_at(uuid, jsonb, bigint) from public, anon, authenticated, service_role;
revoke all on function public.save_role_permissions_reviewed(uuid, bigint, jsonb, text, boolean, text) from public, anon, authenticated, service_role;
grant execute on function public.preview_role_changes_at(uuid, jsonb, bigint) to authenticated;
grant execute on function public.save_role_permissions_reviewed(uuid, bigint, jsonb, text, boolean, text) to authenticated;

commit;
