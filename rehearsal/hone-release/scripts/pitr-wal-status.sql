-- ===========================================================================
-- PITR WAL STATUS: is the WAL archiver healthy, and is the server writing WAL? (Insurance PITR-IDLE-RULE, reads.required_fields)
-- One SELECT over system catalogs, statistics views and read-only WAL functions. NO user table is read, on purpose: a first read of a heap
-- page can emit a hint-bit WAL record and move the position being measured. There is NO chain guard (it would read schema_migrations).
-- Returns text, integers and booleans only: UTC times, WAL positions and file names, counters, server settings.
-- No identifiers, no row data, no archive_command text.
--
-- RUN ONLY VIA: run-window-read-macos.sh pitr-wal-status.sql (pitr-wal-twice.sh does this, twice, N seconds apart, one fresh login each).
-- A value that cannot be read makes the whole statement fail (permission denied): that closes the idle path; do not retry.
--
-- COLUMNS
--   db_now_utc                       the database clock (UTC text, seconds)
--   postmaster_start_utc             server start time: a restart, resize or failover changes it
--   in_recovery                      must be false (a standby has no WAL position of its own)
--   lsn_write / lsn_insert / lsn_flush   pg_current_wal_lsn, pg_current_wal_insert_lsn, pg_current_wal_flush_lsn (text)
--   cur_wal_file / cur_wal_offset    pg_walfile_name_offset(pg_current_wal_lsn()): segment file name (with timeline) and byte offset
--   archived_count, last_archived_wal, last_archived_utc, failed_count, last_failed_wal, last_failed_utc, archiver_stats_reset_utc   pg_stat_archiver
--   archive_mode / wal_level / checkpoint_timeout / wal_segment_size    current_setting text
--   archive_timeout_s                archive_timeout in whole SECONDS (from pg_settings; current_setting would return text with a unit)
--   wal_segment_size_bytes           from pg_settings, an integer
--   next_xid                         pg_snapshot_xmax(pg_current_snapshot()): moves only when a writing transaction starts
--   xact_commit, xact_rollback       DIAGNOSTIC ONLY, not a gate: every read and every platform health check commits a transaction
-- ===========================================================================
select
  to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')                       as db_now_utc,
  to_char(pg_postmaster_start_time() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')  as postmaster_start_utc,
  pg_is_in_recovery()                                                                    as in_recovery,
  pg_current_wal_lsn()::text                                                             as lsn_write,
  pg_current_wal_insert_lsn()::text                                                      as lsn_insert,
  pg_current_wal_flush_lsn()::text                                                       as lsn_flush,
  w.file_name                                                                            as cur_wal_file,
  w.file_offset::text                                                                    as cur_wal_offset,
  a.archived_count,
  a.last_archived_wal,
  to_char(a.last_archived_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')         as last_archived_utc,
  a.failed_count,
  a.last_failed_wal,
  to_char(a.last_failed_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')           as last_failed_utc,
  to_char(a.stats_reset at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')                as archiver_stats_reset_utc,
  current_setting('archive_mode')                                                        as archive_mode,
  (select s.setting::int from pg_settings s where s.name = 'archive_timeout')            as archive_timeout_s,
  current_setting('wal_level')                                                           as wal_level,
  current_setting('checkpoint_timeout')                                                  as checkpoint_timeout,
  current_setting('wal_segment_size')                                                    as wal_segment_size,
  (select s.setting::bigint from pg_settings s where s.name = 'wal_segment_size')        as wal_segment_size_bytes,
  pg_snapshot_xmax(pg_current_snapshot())::text                                          as next_xid,
  (select d.xact_commit   from pg_stat_database d where d.datname = current_database())  as xact_commit,
  (select d.xact_rollback from pg_stat_database d where d.datname = current_database())  as xact_rollback
from pg_stat_archiver a, pg_walfile_name_offset(pg_current_wal_lsn()) w;
