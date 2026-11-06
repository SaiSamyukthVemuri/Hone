-- ===========================================================================
-- GATE G10: hosted names of the 7 pre-existing CHECK constraints that 0214,
-- 0218, 0220 and 0221 drop BY NAME and re-add (S0a window read)
-- Source: decision package A1 (census "Last query (G10)") and Part II section 6
-- G10; same 7 (table, name) pairs as insurance/1035-HOSTED-OBJECT-CENSUS.sql
-- (sha256 bef4d9d8...), here one row per constraint so a failure names itself.
-- Drop statements at #1035 cdf8ae21:
--   0214:369 payment_charge_attempts_currency_check     (default inline name)
--   0214:375 appointment_settlements_currency_check     (named, 0187)
--   0218:52  pending_invitations_role_check             (default inline name)
--   0220:104 appointments_cancelled_by_check            (default inline name)
--   0220:133 appointment_audit_actor_type_check         (default inline name)
--   0220:141 appointment_audit_actor_id_type_ck         (named, 0174)
--   0221:48  email_outbound_messages_purpose_ck         (named, 0212; dropped
--            WITHOUT "if exists", so a different name fails 0221 outright)
--
-- RUN ONLY VIA: run-window-read.sh g10-constraint-names.sql
-- One SELECT over pg_catalog only. Returns schema names and CHECK definitions;
-- no table data.
--
-- EXPECTED PASS: 7 rows, present = true on every row, present_total = 7,
--   at_hosted_0212 = 1.
-- STOP CONDITION: present_total < 7. The hosted name differs, so the old
--   narrower check would survive beside the new one (or 0221 errors). Do not
--   start S1. other_checks_on_key_column is INFORMATION ONLY (not a gate): a
--   value > 0 is a differently-named CHECK on the same column, which the owner
--   reviews for the same survive-beside risk.
-- ===========================================================================
with chain_guard as (
  select 1 / (case when (select max(version) from supabase_migrations.schema_migrations) = '0212'
                   then 1 else 0 end) as at_hosted_0212
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
  g.at_hosted_0212,
  f.migration, f.table_name, f.constraint_name,
  f.con_oid is not null                                          as present,
  count(*) filter (where f.con_oid is not null) over ()          as present_total,
  case when f.con_oid is not null then pg_catalog.pg_get_constraintdef(f.con_oid) end as hosted_definition,
  f.other_checks_on_key_column
from chain_guard g cross join found f
order by f.migration, f.table_name, f.constraint_name;
