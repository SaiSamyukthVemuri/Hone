-- S0B (P10) code that can call out, found by its source text: functions and procedures whose source mentions net.http_*, http_request,
-- http_get/post/put/delete, extensions.http, dblink or pg_background, and user triggers that run such a function or the platform webhook function.
-- Only pg_* and information_schema are skipped by schema. A function is skipped only by identity: it is a member of an extension, or it is owned
-- by a supabase_* role. A function a person created in extensions, net, storage or any other platform schema is therefore scanned.
-- Blind spot, stated: a call assembled at run time from a string cannot be found by any source scan; the cron, queue, hook, vault, foreign
-- server and subscription counts are the other half of the control. Counts only; no name and no source text is returned.
with fn as (
  select p.oid
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
    and p.prokind in ('f', 'p')
    and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
    and not exists (select 1 from pg_roles r where r.oid = p.proowner and r.rolname ~ '^supabase_')
    and p.prosrc ~* '(net\.http_|http_request|http_get|http_post|http_put|http_delete|extensions\.http|dblink|pg_background)'
)
select (select count(*) from fn) as functions_calling_http,
  (select count(*) from pg_trigger t
    where not t.tgisinternal
      and (t.tgfoid in (select oid from fn)
        or exists (select 1 from pg_proc pr join pg_namespace pn on pn.oid = pr.pronamespace
                   where pr.oid = t.tgfoid and pn.nspname = 'supabase_functions' and pr.proname = 'http_request'))) as triggers_calling_http;
