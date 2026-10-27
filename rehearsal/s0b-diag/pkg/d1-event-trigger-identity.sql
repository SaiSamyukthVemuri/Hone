-- S0B-DIAG (D1) identity of EVERY event trigger, names and booleans only. No source text is returned: prosrc is reduced to an md5 and to
-- booleans computed here. Read-only: one SELECT over pg_event_trigger, pg_proc, pg_roles, pg_namespace, pg_language, pg_depend.
--   source_mentions_callout       net.http_*, http_request, http_get/post/put/delete, extensions.http, dblink, pg_background
--   source_mentions_enable_rls    the text enable row level security
--   source_has_execute_dynamic    the word execute followed by a space (a dynamically built statement)
--   is_exact_platform_name        one of the ten usual platform names, as the pre-check p9 defines it (information only)
select e.evtname as evtname, e.evtevent as evtevent, e.evtenabled::text as evtenabled,
  coalesce(cardinality(e.evttags), 0) as evttags_count,
  ro.rolname as trigger_owner_role,
  fn.nspname || '.' || p.proname as function_name,
  rp.rolname as function_owner_role,
  l.lanname as language,
  exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e') as function_is_extension_member,
  md5(p.prosrc) as prosrc_md5,
  (p.prosrc ~* '(net\.http_|http_request|http_get|http_post|http_put|http_delete|extensions\.http|dblink|pg_background)') as source_mentions_callout,
  (p.prosrc ~* 'enable row level security') as source_mentions_enable_rls,
  (p.prosrc ~* 'execute ') as source_has_execute_dynamic,
  (e.evtname in ('pgrst_ddl_watch', 'pgrst_drop_watch', 'issue_graphql_placeholder', 'issue_pg_cron_access', 'issue_pg_graphql_access', 'issue_pg_net_access', 'graphql_watch_ddl', 'graphql_watch_drop', 'pgaudit_ddl_command_end', 'pgaudit_sql_drop')) as is_exact_platform_name
from pg_event_trigger e
join pg_roles ro on ro.oid = e.evtowner
join pg_proc p on p.oid = e.evtfoid
join pg_namespace fn on fn.oid = p.pronamespace
join pg_roles rp on rp.oid = p.proowner
join pg_language l on l.oid = p.prolang
order by e.evtname;
