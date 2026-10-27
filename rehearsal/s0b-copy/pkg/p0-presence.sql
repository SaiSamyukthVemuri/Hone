-- S0B (P0) PRE-RESTORE: which optional objects exist on the source project. One SELECT, catalog only.
-- Returns extension names and versions plus yes/no flags. No customer values, no row counts.
-- The per-object counts (p1..p6) are run only for objects this file reports as present.
select
  (select coalesce(string_agg(e.extname || ' ' || e.extversion, ', ' order by e.extname), '') from pg_extension e) as extensions,
  exists (select 1 from pg_extension e where e.extname = 'pg_net')   as ext_pg_net,
  exists (select 1 from pg_extension e where e.extname = 'http')     as ext_http,
  exists (select 1 from pg_extension e where e.extname = 'pg_cron')  as ext_pg_cron,
  to_regclass('cron.job') is not null                      as has_cron_job,
  to_regclass('net.http_request_queue') is not null        as has_net_http_request_queue,
  to_regclass('net._http_response') is not null            as has_net_http_response,
  to_regclass('supabase_functions.hooks') is not null      as has_supabase_functions_hooks,
  to_regclass('vault.secrets') is not null                 as has_vault_secrets,
  to_regclass('storage.objects') is not null               as has_storage_objects,
  to_regclass('auth.users') is not null                    as has_auth_users;
