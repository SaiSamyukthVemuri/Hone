-- ===========================================================================
-- OPEN TRANSACTIONS: pg_stat_activity read at S1 start (rollout 0213-0246)
-- W-2 (1035-ROLLOUT-PACKAGE-FINAL.md 5.1, A4 "Open transactions"): no
-- transaction older than 60 s on the lock-scanned tables. Table list from
-- ROLLOUT-0213-0246-DECISION-PACKAGE.md Part II section 5 "Locks" (which says
-- "these include"; the owner extends the list if a file scans another table).
--
-- RUN ONLY VIA: run-window-read.sh <this file>
-- One SELECT over pg_stat_activity, pg_locks and pg_catalog only. Returns
-- counts and ages per table. It never returns a pid, user, role, address,
-- application name or query text. The read's own backend is excluded.
--
-- A transaction is matched to a table by any lock it holds or awaits on that
-- table, or on an index of it. pg_stat_activity alone cannot say which tables
-- a transaction touches.
--
-- Guarded like the other S0a files: refuses (division by zero) unless hosted
-- history max is 0212, because it is read at S1 START, before any apply.
--
-- EXPECTED PASS: 10 rows, at_hosted_0212 = 1, old_xact_backends = 0 on every
--   row. Other columns are information for the operator.
-- STOP CONDITION: old_xact_backends > 0 on any row. Do not start S1. Each file
--   also carries a 5 s lock_timeout, so a missed blocker rolls back that file.
-- ===========================================================================
with chain_guard as (
  select 1 / (case when (select max(version) from supabase_migrations.schema_migrations) = '0212'
                   then 1 else 0 end) as at_hosted_0212
),
scanned(table_name) as (
  values
    ('payment_charge_attempts'),
    ('appointment_settlements'),
    ('sessions'),
    ('practitioners'),
    ('appointments'),
    ('appointment_audit'),
    ('email_outbound_messages'),
    ('sms_outbound_messages'),
    ('clients'),
    ('client_intake_forms')
),
backends as (
  select a.pid,
         a.xact_start,
         a.state,
         extract(epoch from (now() - a.xact_start)) as xact_age_seconds
    from pg_catalog.pg_stat_activity a
   where a.pid <> pg_catalog.pg_backend_pid()
     and a.datname = pg_catalog.current_database()
     and a.xact_start is not null
),
holders as (
  select distinct s.table_name, b.pid, b.xact_age_seconds, b.state, l.granted
    from scanned s
    join pg_catalog.pg_namespace n on n.nspname = 'public'
    join pg_catalog.pg_class t on t.relnamespace = n.oid and t.relname = s.table_name
    join pg_catalog.pg_locks l
      on l.database = (select d.oid from pg_catalog.pg_database d where d.datname = pg_catalog.current_database())
     and (l.relation = t.oid
          or l.relation in (select i.indexrelid from pg_catalog.pg_index i where i.indrelid = t.oid))
    join backends b on b.pid = l.pid
)
select
  g.at_hosted_0212,
  s.table_name,
  exists (select 1 from pg_catalog.pg_class t join pg_catalog.pg_namespace n on n.oid = t.relnamespace
           where n.nspname = 'public' and t.relname = s.table_name)                      as table_present,
  (select count(distinct h.pid) from holders h
    where h.table_name = s.table_name and h.xact_age_seconds > 60)                      as old_xact_backends,
  (select count(distinct h.pid) from holders h
    where h.table_name = s.table_name and h.xact_age_seconds > 60
      and h.state = 'idle in transaction')                                               as old_idle_in_xact_backends,
  (select count(distinct h.pid) from holders h
    where h.table_name = s.table_name and not h.granted)                                 as waiting_backends,
  (select count(distinct h.pid) from holders h where h.table_name = s.table_name)        as any_xact_backends,
  (select coalesce(round(max(h.xact_age_seconds)), 0) from holders h
    where h.table_name = s.table_name)                                                   as oldest_xact_age_seconds,
  (select count(*) from backends b where b.xact_age_seconds > 60)                       as old_xact_backends_database_wide
from chain_guard g cross join scanned s
order by s.table_name;
