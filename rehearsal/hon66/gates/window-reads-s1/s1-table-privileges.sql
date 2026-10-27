-- ===========================================================================
-- S1 READ-BACK (window-s1read.sh): table privileges the comparator pins AFTER the S1 apply
-- (0242 closes direct generic audit inserts: authenticated must NOT hold INSERT on audit_logs, service_role must).
-- One SELECT over pg_catalog only (has_table_privilege). No writes, no table data, no identifiers.
-- The (table, role, privilege) list is EXACTLY baseline BASELINE-W1-MACOS-CANDIDATE-3.json (efc94a51...) s1.table_privileges;
-- window-s1read.sh refuses if the two ever differ. The comparator (S1-3) reads these rows as table_privileges.
--
-- RUN ONLY VIA: run-window-read-macos.sh s1-table-privileges.sql (window-s1read.sh does this)
-- Chain guard: an error "division by zero" means history max is not 0246: stop.
-- ===========================================================================
with chain_guard as (
  select 1 / (case when (select max(version) from supabase_migrations.schema_migrations) = '0246'
                   then 1 else 0 end) as at_hosted_0246
)
select
  g.at_hosted_0246,
  t.table_name,
  t.role_name,
  t.privilege,
  pg_catalog.has_table_privilege(t.role_name, pg_catalog.to_regclass('public.' || t.table_name), t.privilege) as held
from chain_guard g
cross join (values
    ('audit_logs', 'authenticated', 'insert'),
    ('audit_logs', 'service_role', 'insert')
  ) as t(table_name, role_name, privilege)
order by t.table_name, t.role_name, t.privilege;
