-- ===========================================================================
-- GATE W3 (0254 ONLINE STAGE): size of the five tables the sealed 0254 changes policies or triggers on, plus the session settings.
-- Derived from w03-table-sizes-0248.sql (82ff0460): chain guard hosted 0248 (column at_hosted_0248), table set changed.
-- RUN ONLY VIA: run-window-read-macos.sh w03-table-sizes-0254.sql
-- One SELECT over pg_class and the session settings: name, present, pg_total_relation_size, reltuples, statement_timeout, lock_timeout. No row data,
-- no names of people or studios, no ids. Nothing is written. EXPECTED: 5 rows, at_hosted_0248 = 1, present true. The settings are information;
-- the apply script's own rule requires a readable statement_timeout of 1 ms .. 2 min.
-- ===========================================================================
with chain_guard as (
  select 1 / (case when (select max(version) from supabase_migrations.schema_migrations) = '0248'
                   then 1 else 0 end) as at_hosted_0248
),
named(table_name) as (
  values ('payment_charge_attempts'), ('manual_fee_charge_attempts'), ('appointment_settlements'),
         ('client_pricing'), ('client_pinned_notes')
)
select
  g.at_hosted_0248,
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
