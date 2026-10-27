-- S0B-DIAG2 (D2) the definition of the platform function public.rls_auto_enable() and its ensure_rls trigger. Exactly one row.
-- Platform code: no customer data, no secret. Read-only: one SELECT over pg_proc, pg_namespace, pg_event_trigger, pg_roles.
-- The wrapper refuses unless prosrc_md5 equals the md5 the earlier diagnostic returned, and prints nothing else if the definition
-- contains password, secret, token or key=.
select pg_get_functiondef(p.oid) as definition,
  md5(p.prosrc) as prosrc_md5,
  p.prosecdef as security_definer,
  p.proconfig::text as proconfig,
  p.provolatile::text as provolatile,
  e.evttags::text as evttags,
  e.evtenabled::text as evtenabled,
  ro.rolname as evtowner_role,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_run,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_run,
  has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_can_run
from pg_event_trigger e
join pg_proc p on p.oid = e.evtfoid
join pg_namespace n on n.oid = p.pronamespace
join pg_roles ro on ro.oid = e.evtowner
where e.evtname = 'ensure_rls' and n.nspname = 'public' and p.proname = 'rls_auto_enable' and p.pronargs = 0;
