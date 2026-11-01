-- S2 (0274) TABLE GRANTS AND COUNTS (run BEFORE apply and AFTER apply). READ-ONLY, ONE STATEMENT. Privilege and count metadata only.
-- Machine-checked by check-expected-s2.py as exact SET EQUALITY (Insurance F-1(a)): a missing expected privilege and an
-- unexpected extra one both fail. 0274 changes no table, so this must be identical before and after.
select 'table privilege ' || c.relname || ' ' || coalesce(r.rolname, 'PUBLIC') as item, a.privilege_type as value
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
  left join pg_roles r on r.oid = a.grantee
 where n.nspname = 'public'
   and c.relname in ('client_legal_identities', 'studio_legal_name_access', 'client_legal_name_access_audit')
   and (r.rolname is null or r.rolname in ('anon', 'authenticated', 'service_role'))
union all
select 'sequence privilege ' || c.relname || ' ' || coalesce(r.rolname, 'PUBLIC'), a.privilege_type
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(coalesce(c.relacl, acldefault('S', c.relowner))) a
  left join pg_roles r on r.oid = a.grantee
 where n.nspname = 'public' and c.relkind = 'S' and c.relname = 'client_legal_name_access_audit_id_seq'
   and (r.rolname is null or r.rolname in ('anon', 'authenticated', 'service_role'))
union all
select 'rows in client_legal_identities (must be 0)', count(*)::text from public.client_legal_identities
union all
select 'rows in studio_legal_name_access (must be 0)', count(*)::text from public.studio_legal_name_access
union all
select 'rows in client_legal_name_access_audit (must be 0)', count(*)::text from public.client_legal_name_access_audit
union all
select 'clients with a preferred name (must be 0)', count(*)::text from public.clients where preferred_name is not null
 order by 1, 2;
