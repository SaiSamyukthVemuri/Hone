#!/bin/sh
# REHEARSAL - NEVER MERGE. Stands in for supabase-go in the S0B rehearsal ONLY. It never reaches a hosted project.
#   db query --linked -f <S0B read file>  -> the REAL darwin supabase-go v2.102.0 (dce26b75) with --db-url set to a throwaway LOCAL database.
# Which database: the project ref in ./supabase/.temp/project-ref of the CURRENT DIRECTORY (the linked dir the runner was started in):
#   the production ref -> database "postgres" (stands in for production); the restored ref -> the database named in $HOME/hone-s1/e2e-restored-db.
# The password the script typed (SUPABASE_DB_PASSWORD) is passed as PGPASSWORD, so a wrong password for a database fails like a real one.
# Anything else is refused.
H="$HOME/hone-s1"
REAL="$H/supabase-cli/real/supabase-go"
LOG="$H/e2e-calls.log"
PRODREF=alhhybgqdmcdyzpybykj
RESTREF=$(cat "$H/e2e-restored-ref") || exit 9
ORIG="$*"
ref=$(cat ./supabase/.temp/project-ref 2>/dev/null) || { echo "s0b wrapper: no project-ref in the current directory" >&2; exit 9; }
case "$ref" in
  "$PRODREF") db=postgres ;;
  "$RESTREF") db=$(cat "$H/e2e-restored-db") || exit 9 ;;
  *) echo "s0b wrapper: unknown project ref" >&2; exit 9 ;;
esac
T="postgresql://postgres.$ref@127.0.0.1:55432/$db?sslmode=require"
sub=""; file=""; prev=""
for a in "$@"; do
  case "$a" in db) sub=db ;; query) [ "$sub" = db ] && sub="db query" ;; esac
  [ "$prev" = "-f" ] && file="$a"
  prev="$a"
done
[ "$sub" = "db query" ] || { echo "s0b wrapper: refused: $ORIG" >&2; exit 9; }
case "$file" in "$H"/s0b-*/*.sql|"$H"/s0b/*.sql) ;; *) echo "s0b wrapper: refused query file: $file" >&2; exit 9 ;; esac
echo "$(date -u +%H:%M:%S) $ref $db $(basename "$file")" >> "$LOG"
[ ! -e "$H/e2e-fake-loginrole" ] || { echo "Initialising login role postgres" >&2; exit 1; }   # REHEARSAL: stands for the CLI login-role text path
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
