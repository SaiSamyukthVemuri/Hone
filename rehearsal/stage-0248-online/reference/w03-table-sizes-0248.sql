-- 0248-ONLY STAGE SIBLING of w03-table-sizes.sql (derived by make-window-0248.py): the chain guard moved from hosted 0212 to hosted 0246 and its column
-- is named at_hosted_0246. Every other line, INCLUDING the comments that describe 0212, is the original text.
-- ===========================================================================
-- GATE W3: size of the existing tables the S1 statement_timeout reasoning names
-- (S0a window read; rollout 0213-0246). Proposed by Machines, assigned by OPS.
--
-- RUN ONLY VIA: run-window-read.sh w03-table-sizes.sql
-- One SELECT over pg_class and the session settings. Returns, per table: its
-- name, whether it exists, pg_total_relation_size in bytes (table + indexes +
-- toast) and reltuples (the planner's approximate row count; -1 means the table
-- has never been analysed, so the byte size is the gate, not the row count).
-- No row data, no names of people or studios, no ids. Nothing is written.
--
-- The ten tables are those 0213-0246 alter or index while they hold data, each
-- under a lock that blocks the table until its statement finishes:
--   appointments, appointment_audit              (0220 checks)
--   email_outbound_messages                      (0221 check)
--   payment_charge_attempts                      (0214, 0240 checks)
--   appointment_settlements, studio_payment_settings (0214)
--   clients                                      (0231 index)
--   client_intake_forms                          (0243, 0246)
--   treatment_images                             (0232)
--   client_payment_methods                       (0245 index)
-- treatment_setup_readings is not listed: 0223 creates it, so it is absent and
-- empty at hosted 0212.
--
-- The two settings are what THIS connection runs under, recorded so the S1
-- statement can name the values it relies on (decision 5: no unnamed defaults).
--
-- EXPECTED PASS: 10 rows; present = true on every row; total_bytes <= 536870912
--   (512 MiB) on every row; at_hosted_0246 = 1. The settings are information.
-- STOP CONDITION: any table over 512 MiB (a single-pass scan could not be
--   assumed to finish inside the proposed 120 s statement_timeout: re-derive the
--   value with Sam); a table that is missing; a row count other than 10; or a
--   chain_guard error (history not at 0212: run G2 and stop).
-- ===========================================================================
with chain_guard as (
  select 1 / (case when (select max(version) from supabase_migrations.schema_migrations) = '0246'
                   then 1 else 0 end) as at_hosted_0246
),
named(table_name) as (
  values ('appointments'), ('appointment_audit'), ('email_outbound_messages'),
         ('payment_charge_attempts'), ('appointment_settlements'), ('studio_payment_settings'),
         ('clients'), ('client_intake_forms'), ('treatment_images'), ('client_payment_methods')
)
select
  g.at_hosted_0246,
  n.table_name,
  c.oid is not null                         as present,
  pg_total_relation_size(c.oid)             as total_bytes,
  c.reltuples::bigint                       as approx_rows,
  current_setting('statement_timeout')      as statement_timeout,
  current_setting('lock_timeout')           as lock_timeout
from chain_guard g
cross join named n
left join pg_class c on c.oid = to_regclass('public.' || n.table_name)
order by n.table_name;
