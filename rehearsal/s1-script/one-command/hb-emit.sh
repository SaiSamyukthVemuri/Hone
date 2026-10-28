#!/bin/bash
# REHEARSAL - NEVER MERGE. Hone ONE-COMMAND STAGE: the OPTIONAL heartbeat, ONE statement per call, and only ever called by the runner's row-4 wait when the
# plan has HEARTBEAT=wal_message (a disclosed production write that Insurance must review and Sam must approve in his own words).
#   usage: hb-emit.sh GO REF POOLER LABEL      stdin line 1 = the database password (never an argument, never the environment of anything but the one CLI child)
# The statement is  select pg_logical_emit_message(true, 'hone-stage-0248', LABEL):  it appends ONE logical-decoding message to the write-ahead log. It creates no
# table, no row, no function, no schema change and touches no customer data; it only gives the provider's WAL archiver something to archive. Nothing else runs.
set -u
umask 077
[ $# -eq 4 ] || { echo "usage: hb-emit.sh GO REF POOLER LABEL" >&2; exit 2; }
GO=$1; REF=$2; POOLER=$3; LABEL=$4
printf '%s' "$LABEL" | grep -Eq '^[A-Za-z0-9._-]{1,40}$' || { echo "bad label" >&2; exit 2; }
IFS= read -r PW || exit 2
[ -n "$PW" ] || exit 2
D=$(mktemp -d) || exit 2
trap 'PW=""; rm -rf "$D"' EXIT
( cd "$D" && PGPASSWORD="$PW" SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 env -u GITHUB_TOKEN -u GH_TOKEN \
    "$GO" --agent no db query --db-url "postgresql://postgres.$REF@$POOLER:5432/postgres?sslmode=require" -o json \
    "select pg_logical_emit_message(true, 'hone-stage-0248', '$LABEL')" ) </dev/null
