-- S0B (P9) event triggers. A trigger counts as PLATFORM only by identity: it is owned by a supabase_* role, or its function is owned by a
-- supabase_* role, or its function is a member of an extension. A name never excludes it. event_triggers_exact_platform_names is information only:
-- how many carry one of the usual platform names (so the first read shows what production has). Counts only.
select count(*) as event_triggers_all,
  count(*) filter (where not (
      exists (select 1 from pg_roles r where r.oid = e.evtowner and r.rolname ~ '^supabase_')
      or exists (select 1 from pg_proc p join pg_roles r on r.oid = p.proowner where p.oid = e.evtfoid and r.rolname ~ '^supabase_')
      or exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = e.evtfoid and d.deptype = 'e')
  )) as event_triggers_other,
  count(*) filter (where e.evtname in ('pgrst_ddl_watch', 'pgrst_drop_watch', 'issue_graphql_placeholder', 'issue_pg_cron_access', 'issue_pg_graphql_access', 'issue_pg_net_access', 'graphql_watch_ddl', 'graphql_watch_drop', 'pgaudit_ddl_command_end', 'pgaudit_sql_drop')) as event_triggers_exact_platform_names
from pg_event_trigger e;
