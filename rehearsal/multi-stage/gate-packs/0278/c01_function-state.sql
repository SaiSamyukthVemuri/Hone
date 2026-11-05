-- 0278 READ-BACK (PREPARATION ONLY / HELD). Read-only. Expect exactly six rows; compare to the sealed values in verify-body.js.part.
select p.proname, count(*) over (partition by p.proname) as overloads, pg_catalog.md5(p.prosrc) as md5, p.prosecdef as definer,
       coalesce((select c from unnest(p.proconfig) c where c like 'search_path=%'), '') as search_path,
       pg_catalog.has_function_privilege('anon', p.oid, 'execute') as anon_exec,
       pg_catalog.has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec,
       pg_catalog.has_function_privilege('service_role', p.oid, 'execute') as service_role_exec
  from pg_catalog.pg_proc p
 where p.pronamespace = 'public'::pg_catalog.regnamespace
   and p.proname in ('authorize_schedule_writer', 'upsert_availability_day_locked', 'delete_availability_day_locked',
                     'upsert_availability_override_locked', 'delete_availability_override_locked', 'save_weekly_availability_as')
 order by 1
