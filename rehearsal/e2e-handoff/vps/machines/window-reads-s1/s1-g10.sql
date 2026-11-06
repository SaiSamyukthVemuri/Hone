-- ===========================================================================
-- S1 READ-BACK, G10 equivalent: the 7 CHECK constraints that 0214, 0218, 0220 and 0221 drop
-- BY NAME and re-add are present AFTER the S1 apply (window-s1read.sh)
-- Derived from machines/window-reads/g10-constraint-names.sql (87dffeb4...): the SAME 7
-- (table, name) pairs and the same SELECT; the only change is the chain guard, which now
-- requires hosted history max = 0246 (that file carries a guard for the pre-S1 max and would refuse here).
--
-- RUN ONLY VIA: run-window-read-macos.sh s1-g10.sql (window-s1read.sh does this)
-- One SELECT over pg_catalog only. Returns schema names and CHECK definitions;
-- no table data.
--
-- EXPECTED PASS: 7 rows, present = true on every row, present_total = 7, at_hosted_0246 = 1.
--   An error "division by zero" means history max is not 0246: stop.
-- STOP CONDITION: present_total < 7. other_checks_on_key_column is INFORMATION ONLY.
-- ===========================================================================
with chain_guard as (
  select 1 / (case when (select max(version) from supabase_migrations.schema_migrations) = '0246'
                   then 1 else 0 end) as at_hosted_0246
),
expected(migration, table_name, key_column, constraint_name) as (
  values
    ('0214', 'payment_charge_attempts', 'currency',     'payment_charge_attempts_currency_check'),
    ('0214', 'appointment_settlements', 'currency',     'appointment_settlements_currency_check'),
    ('0218', 'pending_invitations',     'role',         'pending_invitations_role_check'),
    ('0220', 'appointments',            'cancelled_by', 'appointments_cancelled_by_check'),
    ('0220', 'appointment_audit',       'actor_type',   'appointment_audit_actor_type_check'),
    ('0220', 'appointment_audit',       'actor_id',     'appointment_audit_actor_id_type_ck'),
    ('0221', 'email_outbound_messages', 'purpose',      'email_outbound_messages_purpose_ck')
),
found as (
  select e.*,
    (select k.oid from pg_catalog.pg_constraint k
       join pg_catalog.pg_class c on c.oid = k.conrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = e.table_name and k.conname = e.constraint_name
        and k.contype = 'c') as con_oid,
    (select count(*) from pg_catalog.pg_constraint k
       join pg_catalog.pg_class c on c.oid = k.conrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attname = e.key_column
      where n.nspname = 'public' and c.relname = e.table_name and k.contype = 'c'
        and a.attnum = any(k.conkey)
        and k.conname not in (select x.constraint_name from expected x)) as other_checks_on_key_column
  from expected e
)
select
  g.at_hosted_0246,
  f.migration, f.table_name, f.constraint_name,
  f.con_oid is not null                                          as present,
  count(*) filter (where f.con_oid is not null) over ()          as present_total,
  case when f.con_oid is not null then pg_catalog.pg_get_constraintdef(f.con_oid) end as hosted_definition,
  f.other_checks_on_key_column
from chain_guard g cross join found f
order by f.migration, f.table_name, f.constraint_name;
