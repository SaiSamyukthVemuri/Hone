-- S1 (0258+0266+0272) FUNCTIONS (run BEFORE apply and AFTER apply). READ-ONLY, ONE STATEMENT. Catalog metadata and counts only; no client row, no name, no id.
-- DRAFT, unreviewed. Run only through run-window-read-macos.sh under the operator per-run approval.
-- The functions 0258, 0266 and 0272 create or change, and the v1 receptionist functions 0266 closes or
-- replaces: existence, owner, definer flag, config, a fingerprint of the body, and who can EXECUTE
-- (body md5 is md5(prosrc); expected values are in the request; PUBLIC from the raw ACL; anon, authenticated, service_role effective). Before apply the new ones
-- are absent. After: can_use_/can_read_client_legal_identity, set_receptionist_legal_name_access and
-- receptionist_client_contacts_v2 executable by authenticated only; client_legal_identities_guard and the
-- audit guard executable by nobody but the owner; v1 receptionist_client_contacts executable by NOBODY
-- but the owner; v1 receptionist_calendar executable by authenticated only.
with expected(sig) as (
  values
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
