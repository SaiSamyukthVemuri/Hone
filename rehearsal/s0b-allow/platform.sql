-- REHEARSAL - NEVER MERGE. Six platform-style event triggers (usual names, function owned by a supabase_admin-like role). Synthetic bodies.
create role supabase_admin superuser nologin;
create role rh_other superuser nologin;
create function extensions.rh_noop() returns event_trigger language plpgsql as $f$ begin null; end $f$;
alter function extensions.rh_noop() owner to supabase_admin;
create event trigger pgrst_ddl_watch on ddl_command_end execute function extensions.rh_noop();
create event trigger pgrst_drop_watch on sql_drop execute function extensions.rh_noop();
create event trigger issue_graphql_placeholder on sql_drop when tag in ('DROP EXTENSION') execute function extensions.rh_noop();
create event trigger issue_pg_graphql_access on ddl_command_end when tag in ('CREATE FUNCTION') execute function extensions.rh_noop();
create event trigger issue_pg_cron_access on ddl_command_end when tag in ('CREATE EXTENSION') execute function extensions.rh_noop();
create event trigger issue_pg_net_access on ddl_command_end when tag in ('CREATE EXTENSION') execute function extensions.rh_noop();
alter event trigger pgrst_ddl_watch owner to supabase_admin;
alter event trigger pgrst_drop_watch owner to supabase_admin;
alter event trigger issue_graphql_placeholder owner to supabase_admin;
alter event trigger issue_pg_graphql_access owner to supabase_admin;
alter event trigger issue_pg_cron_access owner to supabase_admin;
alter event trigger issue_pg_net_access owner to supabase_admin;
