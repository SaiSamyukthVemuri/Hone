-- REHEARSAL - NEVER MERGE. A synthetic look-alike of the platform ensure_rls event trigger and public.rls_auto_enable(). Not the real function.
create function public.rls_auto_enable() returns event_trigger language plpgsql security definer set search_path = pg_catalog as $f$
declare cmd record;
begin
  for cmd in select * from pg_event_trigger_ddl_commands() where command_tag in ('CREATE TABLE') and schema_name = 'public' loop
    execute format('alter table if exists %s enable row level security', cmd.object_identity);
  end loop;
end $f$;
create event trigger ensure_rls on ddl_command_end when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') execute function public.rls_auto_enable();
