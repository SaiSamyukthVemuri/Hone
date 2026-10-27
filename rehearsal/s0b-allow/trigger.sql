create event trigger ensure_rls on ddl_command_end when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') execute function public.rls_auto_enable();
