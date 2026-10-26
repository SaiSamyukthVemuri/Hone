-- ===========================================================================
-- PITR READY COUNT (optional companion of pitr-wal-status.sql): how many WAL files wait in the archive_status folder with the suffix .ready,
-- i.e. are complete but not yet shipped. One SELECT; reads only the names of files in the archive status folder (pg_ls_archive_statusdir,
-- which needs the pg_monitor role or an explicit grant). It is a SEPARATE file because a refusal there must not void the main reading:
-- if it is denied, pitr-wal-twice.sh records "not readable" for that reading and goes on. Insurance: the count is REQUIRED (must be 0)
-- only when last_archived_wal is a .backup or .history label; otherwise supplementary. Returns two integers; no file names.
--
-- RUN ONLY VIA: run-window-read-macos.sh pitr-ready-count.sql (pitr-wal-twice.sh does this right after each main reading).
-- ===========================================================================
select
  count(*) filter (where f.name like '%.ready') as ready_count,
  count(*)                                      as status_files
from pg_ls_archive_statusdir() f;
