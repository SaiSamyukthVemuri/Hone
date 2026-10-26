# PITR status reads (two read-only tools)

Prepared for Sam. Nothing here has run on the hosted project. Both tools are read-only and are not part of the cutover until OPS and
Insurance have approved them. Neither changes anything in `window-reads/`. They print what the platform and the database say; the
rule that separates an idle server from a stalled archiver is Insurance's (PITR-IDLE-RULE) and is evaluated later by the comparator.

## 1. Download (one line, one paste)

The line copies six files from the VPS, checks each one's sha256 BEFORE installing any, then installs them into
`~/hone-s1/pitr-status/` (a new folder; no other file on the Mac is touched).

    ( set -u; S=$(mktemp -d) && D=sam@100.123.145.56:/home/sam/hone-handoffs/2026-10-18/machines/pitr-status && scp -q "$D/pitr-backups.sh" "$D/pitr-wal-twice.sh" "$D/run-window-read-macos.sh" "$D/MANIFEST.sha256" "$D/pitr-wal-status.sql" "$D/pitr-ready-count.sql" "$S/" && for p in pitr-backups.sh:c19a00321a8be38b5b373b4f2f53c0c88c94f1e615eb1efc4d7ba2fa4a7e8184 pitr-wal-twice.sh:eb77e8f1d9dccf388a8663e450fa82ad5c614fa90c2692fe6f32977deb352503 run-window-read-macos.sh:471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357 MANIFEST.sha256:089226bd6fee358c73e0ada7202362ed492e73778ca450b27ecaa625c62b371e pitr-wal-status.sql:c91d7a497ce3b04b88aedd72c8b2729694b65c3c5cc2f051837e3f2365ad8cd5 pitr-ready-count.sql:339dd620685294375450206a312483165e3de938ee7eed54756ad5d33d2a523d; do [ "$(shasum -a 256 "$S/${p%%:*}" | cut -d" " -f1)" = "${p#*:}" ] || { echo "STOP: sha256 mismatch for ${p%%:*}"; exit 1; }; done && [ -d "$HOME/hone-s1" ] && mkdir -p "$HOME/hone-s1/pitr-status" && for f in pitr-backups.sh pitr-wal-twice.sh run-window-read-macos.sh MANIFEST.sha256 pitr-wal-status.sql pitr-ready-count.sql; do cp "$S/$f" "$HOME/hone-s1/pitr-status/$f" || exit 1; done && chmod 0755 "$HOME/hone-s1/pitr-status/pitr-backups.sh" "$HOME/hone-s1/pitr-status/pitr-wal-twice.sh" "$HOME/hone-s1/pitr-status/run-window-read-macos.sh" && echo "pitr-backups.sh, pitr-wal-twice.sh, runner, manifest and the two PITR gate files: sha256 OK, installed" ) || echo "STOP: download, sha256 check or install failed; run nothing"

It must end with `sha256 OK, installed`. Any `STOP:` line means nothing was installed: do not run either script.

| installed file | sha256 |
|---|---|
| `pitr-backups.sh` | `c19a00321a8be38b5b373b4f2f53c0c88c94f1e615eb1efc4d7ba2fa4a7e8184` |
| `pitr-wal-twice.sh` | `eb77e8f1d9dccf388a8663e450fa82ad5c614fa90c2692fe6f32977deb352503` |
| `run-window-read-macos.sh` | `471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357` |
| `MANIFEST.sha256` | `089226bd6fee358c73e0ada7202362ed492e73778ca450b27ecaa625c62b371e` |
| `pitr-wal-status.sql` | `c91d7a497ce3b04b88aedd72c8b2729694b65c3c5cc2f051837e3f2365ad8cd5` |
| `pitr-ready-count.sql` | `339dd620685294375450206a312483165e3de938ee7eed54756ad5d33d2a523d` |

## 2. Tool 1: the backups and PITR status from the Management API (the only source of the base backup)

    bash ~/hone-s1/pitr-status/pitr-backups.sh

You type only the Supabase access token (hidden). It runs exactly one command, `supabase-go backups list --project-ref <the project> -o json`,
and refuses any argument (it will never run `backups restore` or anything else). It needs no database password and opens no database
connection (from the v2.102.0 source: that command has no database flags, so the CLI's login-role and unban code is never reached;
it is one HTTPS GET to the Management API). It prints `pitr_enabled`, `walg_enabled`, the earliest and latest physical backup times
(converted to UTC), every backup's `status`, `inserted_at` and `is_physical_backup`, and the latest COMPLETED physical backup. The JSON and a
one-line sidecar are saved in a fresh private folder `~/hone-s1/pitr-backups.XXXXXX`. Refresh the Supabase dashboard page before you
compare it with the output.

## 3. Tool 2: the WAL archiver and write position, twice

    bash ~/hone-s1/pitr-status/pitr-wal-twice.sh

You type the access token and the database password (both hidden; the password is only checked for presence, which is what stops the CLI
from creating a login role). It reads `pitr-wal-status.sql` (one SELECT over system views; no user table, no chain guard) through the
verified runner, then `pitr-ready-count.sql` (the number of WAL files waiting to be shipped; if the database role may not read it, that is
recorded and the run goes on). It then waits N seconds and reads both again, where **N = max(600, T + 180)** and T is the server's
`archive_timeout` in seconds as read the first time (about 10 to 23 minutes; it counts down; keep the Terminal open). If T is 0 or above 1200
the idle proof is closed: it stops after the first reading with exit 3 and "IDLE PATH CLOSED"; the route is then the named restore point.

It prints both readings side by side, the interval measured by the database clock, the Mac-versus-database clock difference, the changes
in archived and failed counts, and an `INDICATION:` line (IDLE_PROVEN, ACTIVE_HEALTHY, STALLED or UNKNOWN, with the reasons) that follows
Insurance's rule. The indication is not the gate. It does not use the commit counter, which always moves.

It can run at any time. Each reading is two logins, so a full run is four logins. A failed login writes
`~/hone-s1/pitr-status/FAILED-LOGIN` and every later run refuses until Sam decides. Do not retry, do not reset the password, do not unban.

## 4. If something stops

Stop and report the STOP line. Do not run a script again before OPS has read it.
