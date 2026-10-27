# Row-4 fallback: create ONE named restore point (restore-point.sh)

**This script is a provider WRITE. It is prepared only. Do not run it until OPS has told you to.** It records a name in the project's
WAL stream (the same thing as a manual restore point); it changes no table and no row. It is the route for row 4 when the dashboard's
latest recovery point does not catch up to the selected time: row 4 then uses the basis `named_restore_point`.

## 1. Download (one line, one paste). Downloading does not run anything.

    ( set -u; S=$(mktemp -d) && D=sam@100.123.145.56:/home/sam/hone-handoffs/2026-10-18/machines/restore-point && scp -q "$D/restore-point.sh" "$S/" && { [ "$(shasum -a 256 "$S/restore-point.sh" | cut -d" " -f1)" = "4181f006bc22a8388def32a07d3344e26d1048d4cfd4c76440c79c554afdf9fa" ] || { echo "STOP: sha256 mismatch for restore-point.sh"; exit 1; }; } && [ -d "$HOME/hone-s1" ] && mkdir -p "$HOME/hone-s1/pitr-status" && cp "$S/restore-point.sh" "$HOME/hone-s1/pitr-status/restore-point.sh" && chmod 0755 "$HOME/hone-s1/pitr-status/restore-point.sh" && echo "restore-point.sh: sha256 OK, installed (NOT run)" ) || echo "STOP: download, sha256 check or install failed; run nothing"

It must end with `restore-point.sh: sha256 OK, installed (NOT run)`. Any `STOP:` line means nothing was installed.

| installed file | sha256 |
|---|---|
| `restore-point.sh` | `4181f006bc22a8388def32a07d3344e26d1048d4cfd4c76440c79c554afdf9fa` |

## 2. When and how (only after OPS says go)

1. Run `window-row4.sh` as usual; it prints the selected time (UTC). Keep that screen.
2. In a second Terminal tab: `bash ~/hone-s1/pitr-status/restore-point.sh`
3. It prints one line and waits. Type exactly: `I AUTHORIZE ONE NAMED RESTORE POINT ON PROJECT alhhybgqdmcdyzpybykj`
   Anything else stops it before a single request is sent.
4. Type the selected time (copy it from the row-4 screen). It must be within the last 60 minutes and not in the future.
5. Type the Supabase access token (hidden). The token needs the project backups write permission.
6. It sends ONE `POST /v1/projects/<ref>/database/backups/restore-point` with a name of the form `hs1-YYYYMMDDHHMMSS` (18 characters; the API
   limit is 20), then checks the status every 5 seconds, at most 60 times (5 minutes), until the platform says `AVAILABLE`.
7. On success it prints `ROW 4 VALUES (basis named_restore_point): restore_point_name=... restore_point_status=AVAILABLE
   restore_point_completed_at_utc=...`. Type those three values into row 4 when it asks.

## 3. If it stops

- The POST is never repeated. If the script says the POST failed, timed out, or returned anything but 201, the point **may or may not exist**:
  do not run it again; tell OPS, who reads the state first (a GET with `?name=`).
- `FAILED`, `REMOVED`, still `PENDING` after 5 minutes, or a completed time before the selected time: stop, do not create another without OPS.
- Evidence is kept in `~/hone-s1/restore-point.XXXXXX` (mode 0700): the responses and a one-line sidecar. The token is never written there.

## 4. What it is made of

supabase-go v2.102.0 has no restore-point command (it registers only `backups list` and `backups restore`), so the script makes the two
HTTPS calls itself with the system `curl`, token read privately and passed to curl on a pipe, never on a command line.
