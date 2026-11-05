-- ===========================================================================
-- OPEN TRANSACTIONS (0257 ONLINE STAGE): pg_stat_activity at the start of the 0257 apply.
-- Derived from s1-open-transactions-0254.sql (c35d0958): the chain guard is hosted 0248 (column at_hosted_0248) and the scanned set is the ONE table
-- the sealed 0257 takes an ACCESS EXCLUSIVE lock on (ALTER TABLE ... ADD COLUMN, DROP/ADD CONSTRAINT): studio_payment_jurisdiction_changes.
-- The new command (CREATE FUNCTION) takes no table lock.
-- Rule: no transaction older than 60 s touching it (a long reader would queue the ALTER and, behind it, every new read, until the sealed lock_timeout
-- of 5 s aborts the whole transaction). RUN ONLY VIA: run-window-read-macos.sh s1-open-transactions-0257.sql
-- One SELECT over pg_stat_activity, pg_locks and pg_catalog. Counts and ages only; no pid, user, address or query text. Nothing is written.
-- EXPECTED PASS: 1 row, at_hosted_0248 = 1, table_present true, old_xact_backends = 0.
-- ===========================================================================
with chain_guard as (
  select 1 / (case when (select max(version) from supabase_migrations.schema_migrations) = '0248'
                   then 1 else 0 end) as at_hosted_0248
),
scanned(table_name) as (
  values
    ('studio_payment_jurisdiction_changes')
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
  g.at_hosted_0248,
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
