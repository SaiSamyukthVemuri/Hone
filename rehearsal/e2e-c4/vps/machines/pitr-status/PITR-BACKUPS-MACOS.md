# PITR backups read (pitr-backups.sh): the latest COMPLETED base backup and the PITR flags

Prepared for Sam. Read-only. It is the only source of the base backup (the dashboard does not show it). Nothing here has run on the
hosted project. It changes nothing in `window-reads/`.

## 1. Download (one line, one paste)

The line copies ONE file from the VPS, checks its sha256 BEFORE installing, then installs it into `~/hone-s1/pitr-status/`
(a new folder; no other file on the Mac is touched).

    ( set -u; S=$(mktemp -d) && D=sam@100.123.145.56:/home/sam/hone-handoffs/2026-10-18/machines/pitr-status && scp -q "$D/pitr-backups.sh" "$S/" && { [ "$(shasum -a 256 "$S/pitr-backups.sh" | cut -d" " -f1)" = "85407d0b01d11497161c1c9d0374751ecaec80faed9609f2d4f073d71fe49413" ] || { echo "STOP: sha256 mismatch for pitr-backups.sh"; exit 1; }; } && [ -d "$HOME/hone-s1" ] && mkdir -p "$HOME/hone-s1/pitr-status" && cp "$S/pitr-backups.sh" "$HOME/hone-s1/pitr-status/pitr-backups.sh" && chmod 0755 "$HOME/hone-s1/pitr-status/pitr-backups.sh" && echo "pitr-backups.sh: sha256 OK, installed" ) || echo "STOP: download, sha256 check or install failed; run nothing"

It must end with `pitr-backups.sh: sha256 OK, installed`. Any `STOP:` line means nothing was installed: do not run the script.

| installed file | sha256 |
|---|---|
| `pitr-backups.sh` | `85407d0b01d11497161c1c9d0374751ecaec80faed9609f2d4f073d71fe49413` |

## 2. Run

    bash ~/hone-s1/pitr-status/pitr-backups.sh

You type only the Supabase access token (hidden). It refuses before any call unless this Mac, `supabase-go` (sha256 dce26b75...) and your
environment (no SUPABASE_*, PG*, proxy or similar variables, checked by name) are as expected. It then runs exactly one command,
`supabase-go --agent no backups list --project-ref <the project> -o json`, and refuses any argument: it will never run `backups restore`
or anything else.

**What that command does, from the supabase/cli v2.102.0 source:** one HTTPS GET to the Management API
(`/v1/projects/<ref>/database/backups`). The command has no database flags, so the CLI's database-config step does nothing: no database
connection, no password, no temporary login role, no unban. Run with the real binary against a stand-in API, the rehearsal saw exactly one
request (the script seeds `supabase/.temp/linked-project.json` in its private folder; without it the CLI adds one more read-only GET,
`/v1/projects/<ref>`, for its telemetry cache).

## 3. What it prints

- `pitr_enabled` and `walg_enabled`;
- `physical_backup_data` earliest and latest physical backup, as the raw Unix seconds and converted to UTC (with the age of the latest);
- every backup: `status`, `inserted_at` and `is_physical_backup`;
- the latest COMPLETED physical backup (a newer FAILED or logical entry is skipped).

It prints no other field. The full JSON and a one-line sidecar (hashes and times) are saved in a fresh private folder
`~/hone-s1/pitr-backups.XXXXXX` (mode 0700). Refresh the Supabase dashboard page before you compare its numbers with this output.
The last line is `PITR BACKUPS READ COMPLETE`. Anything else: stop and report the STOP line; do not run it again before OPS has read it.
