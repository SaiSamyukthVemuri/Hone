-- DOWN for 0287_roles_permission_engine (HELD, not applied anywhere). NOT a migration: supabase never runs this directory.
-- Run by an operator, once, inside the maintenance window, only after the app is on a build that has the engine-absent fallback
-- (requirePermission treats a missing has_studio_permission as "engine not installed": it keeps today's legacy checks and alerts the
-- operator once; it does not refuse anyone). With that fallback, dropping the engine returns the studio to legacy behaviour, not a lockout.
--
-- WHAT THIS DESTROYS: every stored role permission, the policy version, the ship gates, the catalog copy and permission_audit (the
-- append-only history of who changed what). Export permission_audit first if it must be kept; the audit triggers refuse UPDATE, DELETE
-- and TRUNCATE but a DROP is not one of them. It touches nothing else: 0287 changed no existing table except adding one AFTER INSERT
-- trigger on public.studios, which is removed here. No source column is dropped.
begin;
set local lock_timeout = '5s';

drop trigger if exists studios_permission_policy_seed_trg on public.studios;

-- Tables first: the audit table's triggers depend on a helper function, so the function cannot be dropped before the table.
drop table if exists public.permission_key_activation;
drop table if exists public.permission_key_release;
drop table if exists public.permission_audit;
drop table if exists public.permission_ship_gates;
drop table if exists public.studio_role_permissions;
drop table if exists public.studio_permission_policy;
drop table if exists public.permission_narrowings;
drop table if exists public.permission_catalog;

drop function if exists public.change_staff_role(uuid, uuid, text, text, text);
drop function if exists public.list_permission_audit(uuid, integer, bigint);
drop function if exists public.effective_access(uuid, uuid);
drop function if exists public.get_role_permissions(uuid);
drop function if exists public.adopt_new_defaults(uuid, bigint, text);
drop function if exists public.preview_adopt_new_defaults(uuid);
drop function if exists public.reset_role_to_defaults(uuid, text, bigint, text);
drop function if exists public.preview_activation(uuid);
drop function if exists public.activate_released_permissions(uuid, text[], bigint, text);
drop function if exists public.preview_reset(uuid, text);
drop function if exists public.save_role_permissions(uuid, bigint, jsonb, text, boolean);
drop function if exists public.preview_role_changes(uuid, jsonb);
drop function if exists public.has_studio_permission(uuid, text, uuid, uuid, uuid);

-- Internal helpers: dropped by name so a signature tweak in the held migration cannot leave one behind.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('perm_actor', 'perm_affected_people', 'perm_base_scope', 'perm_diff', 'perm_effective_map', 'perm_effective_scope',
                         'perm_fail', 'perm_rank', 'perm_reason_ok', 'perm_run_basis', 'perm_run_changes', 'perm_run_activation', 'perm_scope_source',
                         'permission_audit_append_only', 'studios_permission_policy_seed')
  loop
    execute format('drop function if exists %s', r.sig);
  end loop;
end $$;

commit;
