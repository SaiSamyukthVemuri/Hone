#!/bin/sh
# REHEARSAL - NEVER MERGE. Stands in for supabase-go in the PITR-STATUS rehearsal ONLY. It never reaches a hosted project:
#   --agent no backups list --project-ref <ref> -o json   -> the stub Management API JSON in $HOME/hone-s1/pitr-backups-stub.json
#   --agent no db query --linked -o json -f <gate file>   -> the REAL darwin supabase-go (dce26b75) with --db-url set to the throwaway local database
# Anything else is refused (exit 9) and logged. The database target (a loopback URL, no password) is in $HOME/hone-s1/pitr-target.
H="$HOME/hone-s1"; REAL="$H/supabase-cli/real/supabase-go"; LOG="$H/pitr-calls.log"
ORIG="$*"
case " $ORIG " in
  *" backups list "*)
    case " $ORIG " in *" restore "*) echo "$(date -u +%H:%M:%S) REFUSED $ORIG" >> "$LOG"; echo "wrapper: refused" >&2; exit 9 ;; esac
    [ -n "${SUPABASE_ACCESS_TOKEN:-}" ] || { echo "wrapper: no access token" >&2; exit 9; }
    echo "$(date -u +%H:%M:%S) backups list" >> "$LOG"
    [ -f "$H/pitr-backups-fail" ] && { echo "Unexpected error: Bearer $SUPABASE_ACCESS_TOKEN rejected for postgresql://u:p@h/db" >&2; exit 1; }
    cat "$H/pitr-backups-stub.json"; exit $? ;;
  *" db query "*) ;;
  *) echo "$(date -u +%H:%M:%S) REFUSED $ORIG" >> "$LOG"; echo "wrapper: refused" >&2; exit 9 ;;
esac
T=$(cat "$H/pitr-target" 2>/dev/null) || { echo "wrapper: no target" >&2; exit 9; }
case "$T" in postgresql://*@127.0.0.1:*) ;; *) echo "wrapper: the target is not loopback" >&2; exit 9 ;; esac
file=""; prev=""
for a in "$@"; do [ "$prev" = "-f" ] && file="$a"; prev="$a"; done
case "$(basename "$file")" in pitr-wal-status.sql|pitr-ready-count.sql) ;; *) echo "wrapper: refused query file" >&2; exit 9 ;; esac
echo "$(date -u +%H:%M:%S) db query $(basename "$file")" >> "$LOG"
n=$#; i=0
while [ $i -lt $n ]; do a="$1"; shift; i=$((i+1)); case "$a" in --linked) set -- "$@" --db-url "$T" ;; *) set -- "$@" "$a" ;; esac; done
[ -z "${SUPABASE_DB_PASSWORD:-}" ] || PGPASSWORD="$SUPABASE_DB_PASSWORD"
export PGPASSWORD
unset SUPABASE_DB_PASSWORD SUPABASE_ACCESS_TOKEN
exec "$REAL" "$@"
