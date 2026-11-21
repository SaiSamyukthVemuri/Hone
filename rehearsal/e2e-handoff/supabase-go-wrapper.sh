#!/bin/sh
# REHEARSAL - NEVER MERGE. Stands in for supabase-go in the E2E-HANDOFF rehearsal ONLY. It never reaches a hosted project:
#   db query --linked -f <S0 gate file>    -> a canned result (the hosted S0a reads are stubbed: there is no hosted data)
#   db query --linked -f <S1 gate file>    -> the REAL darwin supabase-go v2.102.0 (dce26b75) with --db-url set to the throwaway local database
#   db push --db-url <anything> [flags]    -> the REAL supabase-go with --db-url replaced by the throwaway local database
# Anything else is refused. The target comes from $HOME/hone-s1/e2e-target (a loopback URL without a password).
H="$HOME/hone-s1"
REAL="$H/supabase-cli/real/supabase-go"
LOG="$H/e2e-calls.log"
T=$(cat "$H/e2e-target" 2>/dev/null) || { echo "e2e wrapper: no e2e-target" >&2; exit 9; }
case "$T" in postgresql://*@127.0.0.1:*) ;; *) echo "e2e wrapper: the target is not loopback" >&2; exit 9 ;; esac
ORIG="$*"
sub=""; file=""; flag=""; prev=""
for a in "$@"; do
  case "$a" in db) sub=db ;; query) [ "$sub" = db ] && sub="db query" ;; push) [ "$sub" = db ] && sub="db push" ;; esac
  [ "$prev" = "-f" ] && file="$a"
  case "$a" in --dry-run) flag="$flag dry-run" ;; --yes) flag="$flag yes" ;; esac
  prev="$a"
done
case "$sub" in "db query"|"db push") ;; *) echo "e2e wrapper: refused: $ORIG" >&2; exit 9 ;; esac
echo "$(date -u +%H:%M:%S) $sub $(basename "${file:-}") $flag" >> "$LOG"
if [ "$sub" = "db query" ]; then
  case "$file" in
    */window-reads/*.sql) cat "$H/e2e-canned/$(basename "$file" .sql).json"; exit $? ;;
    */window-reads-s1/*.sql) ;;
    *) echo "e2e wrapper: refused query file: $file" >&2; exit 9 ;;
  esac
fi
n=$#; skip=0; i=0
while [ $i -lt $n ]; do
  a="$1"; shift; i=$((i+1))
  if [ $skip = 1 ]; then skip=0; set -- "$@" "$T"; continue; fi
  case "$a" in
    --linked) set -- "$@" --db-url "$T" ;;
    --db-url) skip=1; set -- "$@" --db-url ;;
    *) set -- "$@" "$a" ;;
  esac
done
[ -z "${SUPABASE_DB_PASSWORD:-}" ] || PGPASSWORD="$SUPABASE_DB_PASSWORD"
export PGPASSWORD
unset SUPABASE_DB_PASSWORD SUPABASE_ACCESS_TOKEN
exec "$REAL" "$@"
