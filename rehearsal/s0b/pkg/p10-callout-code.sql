-- S0B (P10) code that can call out, found by its source text: non-system, non-extension functions whose source mentions net.http_*,
-- http_request, http_get/post/put/delete or extensions.http, and user triggers that run such a function or the platform webhook function.
-- Platform schemas are excluded. Counts only; no name and no source text is returned.
with fn as (
  select p.oid
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname !~ '^pg_' and n.nspname not in ('information_schema', 'supabase_functions', 'net', 'cron', 'vault', 'extensions', 'graphql', 'graphql_public', 'realtime', 'storage', 'auth', 'pgbouncer', 'pgsodium', 'pgsodium_masks', 'supabase_migrations', '_realtime', '_analytics')
    and p.prokind in ('f', 'p')
    and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
    and p.prosrc ~* '(net\.http_|http_request|http_get|http_post|http_put|http_delete|extensions\.http)'
)
select (select count(*) from fn) as functions_calling_http,
  (select count(*) from pg_trigger t
    where not t.tgisinternal
      and (t.tgfoid in (select oid from fn)
        or exists (select 1 from pg_proc pr join pg_namespace pn on pn.oid = pr.pronamespace
                   where pr.oid = t.tgfoid and pn.nspname = 'supabase_functions' and pr.proname = 'http_request'))) as triggers_calling_http;
