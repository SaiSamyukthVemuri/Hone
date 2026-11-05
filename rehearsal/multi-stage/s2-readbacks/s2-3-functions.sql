-- S2 (0274) FUNCTIONS (run BEFORE apply and AFTER apply). READ-ONLY, ONE STATEMENT. Catalog metadata and counts only; no client row, no name, no id.
-- DRAFT, unreviewed. Run only through run-window-read-macos.sh under the operator per-run approval.
-- The four functions 0274 creates or closes, plus the S1 functions it must leave unchanged: existence, owner, definer flag,
-- config, md5(prosrc), and who can EXECUTE. Before apply the three new 0274 functions are absent. After: the three
-- executable by authenticated only; receptionist_calendar (0266's) executable by NOBODY.
with expected(sig) as (
  values
  ('public.receptionist_client_directory(uuid,text,text[],text,integer,integer)'),
  ('public.receptionist_calendar_v2(uuid,timestamptz,timestamptz)'),
  ('public.receptionist_studio_timezone(uuid)'),
  ('public.can_use_client_legal_identity(uuid)'),
  ('public.client_legal_identities_guard()'),
  ('public.can_read_client_legal_identity(uuid)'),
  ('public.set_receptionist_legal_name_access(uuid,boolean)'),
  ('public.receptionist_client_contacts_v2(uuid,text,integer)'),
  ('public.client_legal_name_access_audit_immutable()'),
  ('public.receptionist_client_contacts(uuid,text,integer)'),
  ('public.receptionist_calendar(uuid,timestamptz,timestamptz)')
)
select e.sig,
       to_regprocedure(e.sig) is not null as fn_exists,
       p.proowner::regrole::text as owner,
       p.prosecdef as security_definer,
       p.provolatile as volatility,
       p.proconfig as config,
       md5(p.prosrc) as body_md5,
       exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_can_execute,
       has_function_privilege('anon', to_regprocedure(e.sig), 'execute') as anon_can_execute,
       has_function_privilege('authenticated', to_regprocedure(e.sig), 'execute') as authenticated_can_execute,
       has_function_privilege('service_role', to_regprocedure(e.sig), 'execute') as service_role_can_execute
  from expected e
  left join pg_proc p on p.oid = to_regprocedure(e.sig)
 order by e.sig;
