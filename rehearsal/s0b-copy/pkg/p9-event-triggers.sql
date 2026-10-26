-- S0B (P9) event triggers. A trigger counts as PLATFORM only by identity: it is owned by a supabase_* role, or its function is owned by a
-- supabase_* role, or its function is a member of an extension. A name never excludes it. event_triggers_exact_platform_names is information only:
-- how many carry one of the usual platform names (so the first read shows what production has). Counts only.
-- ONE pinned exception (S0B-ALLOWLIST): the documented platform helper ensure_rls -> public.rls_auto_enable() is excluded from event_triggers_other
-- ONLY when ALL of this holds (anything else, including the same function behind a second trigger name, still counts as other):
--   trigger: evtname ensure_rls, evtevent ddl_command_end, evtenabled O, evttags exactly ARRAY[CREATE TABLE, CREATE TABLE AS, SELECT INTO] in this order, owner postgres;
--   function: schema public, name rls_auto_enable, no arguments, returns event_trigger, plpgsql, owner postgres, security definer,
--             volatile, proconfig exactly {search_path=pg_catalog}, md5(prosrc) 99be20677b456ea8d3be47bdd44fb369, not an extension member.
-- event_triggers_pinned_allowlisted counts the triggers that matched the pin and event_triggers_allowlisted_md5 lists the md5 of the admitted function(s)
-- (information; null when none matched).
select count(*) as event_triggers_all,
  count(*) filter (where not (
      exists (select 1 from pg_roles r where r.oid = e.evtowner and r.rolname ~ '^supabase_')
      or exists (select 1 from pg_proc p join pg_roles r on r.oid = p.proowner where p.oid = e.evtfoid and r.rolname ~ '^supabase_')
      or exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = e.evtfoid and d.deptype = 'e')
      or pin.matched
  )) as event_triggers_other,
  count(*) filter (where pin.matched) as event_triggers_pinned_allowlisted,
  string_agg(distinct pin.fn_md5, ',') filter (where pin.matched) as event_triggers_allowlisted_md5,
  count(*) filter (where e.evtname in ('pgrst_ddl_watch', 'pgrst_drop_watch', 'issue_graphql_placeholder', 'issue_pg_cron_access', 'issue_pg_graphql_access', 'issue_pg_net_access', 'graphql_watch_ddl', 'graphql_watch_drop', 'pgaudit_ddl_command_end', 'pgaudit_sql_drop')) as event_triggers_exact_platform_names
from pg_event_trigger e
cross join lateral (
  select coalesce(
    e.evtname = 'ensure_rls' and e.evtevent = 'ddl_command_end' and e.evtenabled = 'O'
    and e.evttags = array['CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO']::text[]
    and exists (select 1 from pg_roles r where r.oid = e.evtowner and r.rolname = 'postgres')
    and exists (
      select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_language l on l.oid = p.prolang
      join pg_roles r on r.oid = p.proowner
      where p.oid = e.evtfoid
        and n.nspname = 'public' and p.proname = 'rls_auto_enable' and p.pronargs = 0
        and p.prorettype = 'event_trigger'::regtype
        and l.lanname = 'plpgsql' and r.rolname = 'postgres'
        and p.prosecdef and p.provolatile = 'v'
        and p.proconfig = array['search_path=pg_catalog']::text[]
        and md5(p.prosrc) = '99be20677b456ea8d3be47bdd44fb369'
        and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
    ), false) as matched,
    (select md5(f.prosrc) from pg_proc f where f.oid = e.evtfoid) as fn_md5
) pin;
