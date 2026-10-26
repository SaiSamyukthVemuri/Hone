-- S0B (V2) catalog fingerprint. Run against production and against the restored project; the two must be equal.
-- Not time filtered. Rows: kind=schema (tables, functions, policies per non-system schema), kind=rls (one row per
-- public table: RLS enabled, RLS forced), kind=fingerprint (md5 over the public function definitions and over the
-- public policy definitions). Names, counts and md5 digests only; no row data.
select 'schema' as kind, n.nspname::text as name,
  (select count(*) from pg_class c where c.relnamespace = n.oid and c.relkind in ('r', 'p')) as n1,
  (select count(*) from pg_proc p where p.pronamespace = n.oid) as n2,
  (select count(*) from pg_policy po join pg_class c on c.oid = po.polrelid where c.relnamespace = n.oid) as n3,
  null::text as md5
from pg_namespace n
where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
union all
select 'rls', c.relname::text, c.relrowsecurity::int, c.relforcerowsecurity::int, 0, null::text
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p')
union all
select 'fingerprint', 'public_functions', count(*), 0, 0,
  md5(string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' || p.prosrc, E'\n'
      order by p.proname, pg_get_function_identity_arguments(p.oid)))
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind in ('f', 'p')
union all
select 'fingerprint', 'public_policies', count(*), 0, 0,
  md5(string_agg(pol.policyname || '|' || pol.tablename || '|' || pol.cmd || '|' || coalesce(pol.qual, '') || '|' || coalesce(pol.with_check, ''), E'\n'
      order by pol.policyname, pol.tablename, pol.cmd))
from pg_policies pol
where pol.schemaname = 'public'
order by 1, 2;
