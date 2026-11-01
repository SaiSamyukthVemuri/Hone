-- S1 (0258+0266+0272) POST-APPLY OBJECTS (run AFTER apply only; the new tables must exist). READ-ONLY, ONE STATEMENT. Catalog metadata and counts only; no client row, no name, no id.
-- DRAFT, unreviewed. Run only through run-window-read-macos.sh under the operator per-run approval.
-- Expected after a correct apply: the three tables exist, owned by the migration role, RLS on and not
-- forced; clients.preferred_name exists, nullable, with its shape constraint VALIDATED; every row count
-- below is 0 (the receptionist legal-name switch is OFF everywhere; no identity or audit row exists; no
-- client has a preferred name yet). Policies and triggers are shown by name AND by an md5 of their
-- definition text (hashes only, no text), so a policy or trigger REPLACED by 0266 or 0272 is told apart
-- from the one it replaced; also the audit sequence privileges, the foreign keys of client_legal_identities
-- and the indexes of the audit table. Expected hashes are in the request, confirmed on the rehearsal stack.
select 'table ' || c.relname as item,
       (c.relowner::regrole::text || ' rls=' || c.relrowsecurity::text || ' forced=' || c.relforcerowsecurity::text) as value
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('client_legal_identities', 'studio_legal_name_access', 'client_legal_name_access_audit')
union all
select 'column clients.preferred_name',
       (data_type || ' nullable=' || is_nullable)
  from information_schema.columns
 where table_schema = 'public' and table_name = 'clients' and column_name = 'preferred_name'
union all
select 'constraint ' || conname, 'validated=' || convalidated::text
  from pg_constraint
 where conname = 'clients_preferred_name_shape'
union all
select 'trigger ' || t.tgname || ' on ' || c.relname, 'enabled=' || t.tgenabled::text || ' def_md5=' || md5(pg_get_triggerdef(t.oid))
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
 where not t.tgisinternal
   and c.relname in ('client_legal_identities', 'client_legal_name_access_audit')
union all
select 'policy ' || p.tablename || '.' || p.policyname,
       (p.cmd || ' roles=' || p.roles::text || ' permissive=' || p.permissive
        || ' def_md5=' || md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')))
  from pg_policies p
 where p.schemaname = 'public'
   and p.tablename in ('client_legal_identities', 'studio_legal_name_access', 'client_legal_name_access_audit')
union all
select 'table privilege ' || c.relname || ' ' || coalesce(r.rolname, 'PUBLIC'), a.privilege_type
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
  left join pg_roles r on r.oid = a.grantee
 where n.nspname = 'public'
   and c.relname in ('client_legal_identities', 'studio_legal_name_access', 'client_legal_name_access_audit')
union all
select 'sequence privilege ' || c.relname || ' ' || coalesce(r.rolname, 'PUBLIC'), a.privilege_type
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(coalesce(c.relacl, acldefault('S', c.relowner))) a
  left join pg_roles r on r.oid = a.grantee
 where n.nspname = 'public' and c.relkind = 'S' and c.relname = 'client_legal_name_access_audit_id_seq'
union all
select 'foreign key ' || k.conname, ('validated=' || k.convalidated::text || ' def_md5=' || md5(pg_get_constraintdef(k.oid)))
  from pg_constraint k
  join pg_class c on c.oid = k.conrelid
 where c.relname in ('client_legal_identities', 'studio_legal_name_access', 'client_legal_name_access_audit') and k.contype = 'f'
union all
select 'index ' || i.indexname || ' on ' || i.tablename, md5(i.indexdef)
  from pg_indexes i
 where i.schemaname = 'public' and i.tablename in ('client_legal_identities', 'studio_legal_name_access', 'client_legal_name_access_audit')
union all
select 'rows in client_legal_identities (must be 0)', count(*)::text from public.client_legal_identities
union all
select 'rows in studio_legal_name_access (must be 0)', count(*)::text from public.studio_legal_name_access
union all
select 'rows in client_legal_name_access_audit (must be 0)', count(*)::text from public.client_legal_name_access_audit
union all
select 'clients with a preferred name (must be 0)', count(*)::text from public.clients where preferred_name is not null
 order by 1, 2;
