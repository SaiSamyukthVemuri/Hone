-- ===========================================================================
-- GATE G12: 0243 preflight prediction, SECURITY DEFINER functions that mention
-- client_intake_forms (S0a window read; owner Team)
-- Source: decision package A1 "G12" (same pg_proc predicate), plus the three
-- EXECUTE checks that 0243's own preflight applies (#1035 cdf8ae21,
-- 0243:214-256: any such definer other than write_intake_revision and the
-- exempt 0216 receptionist_client_contacts must not be executable by anon,
-- authenticated or service_role, or 0243 raises "Unexpected callable intake
-- definer requires review.").
--
-- RUN ONLY VIA: run-window-read.sh g12-0243-intake-definers.sql
-- One SELECT over pg_catalog only: function signatures, owner role and
-- booleans. No table data.
--
-- EXPECTED PASS: callable_total = 0 (no listed function is executable by any of
--   the three roles), at_hosted_0212 = 1. Zero listed functions returns one row
--   with a null signature and definers_total = 0, which also passes.
-- STOP CONDITION: callable_total > 0. 0243's preflight is predicted to refuse
--   and S1 would stop at 0243. Team decides before S1.
-- LIMIT: this reads hosted 0212. Migrations 0213-0242 run before 0243's
--   preflight and may create, replace or revoke such functions. Team's per-row
--   analysis covers that delta; this read covers only the pre-existing set.
-- ===========================================================================
with chain_guard as (
  select 1 / (case when (select max(version) from supabase_migrations.schema_migrations) = '0212'
                   then 1 else 0 end) as at_hosted_0212
),
d as (
  select
    p.oid::regprocedure::text                                   as signature,
    p.proowner::regrole::text                                   as owner,
    pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')          as anon_exec,
    pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_exec,
    pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')  as service_role_exec
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef
    and p.prosrc ~* '(^|[^a-z0-9_])client_intake_forms([^a-z0-9_]|$)'
)
select
  g.at_hosted_0212,
  d.signature, d.owner, d.anon_exec, d.authenticated_exec, d.service_role_exec,
  (d.anon_exec or d.authenticated_exec or d.service_role_exec)                                     as callable,
  count(d.signature) over ()                                                                       as definers_total,
  count(d.signature) filter (where d.anon_exec or d.authenticated_exec or d.service_role_exec) over () as callable_total
from chain_guard g left join d on true
order by d.signature;
