#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# The ONLY sanctioned way to run a window-reads/*.sql gate file.
#
#   cd <the operator's linked Hone checkout>     # holds supabase/.temp/project-ref
#   HONE_WINDOW_PROJECT_REF=<expected ref, supplied privately> \
#     /path/to/window-reads/run-window-read.sh g11-0244-legacy-laser-types.sql
#
# Refuses (exit 2, before any CLI call) unless ALL of these hold:
#   - exactly one argument naming a file in this directory listed in MANIFEST.sha256,
#     and the file's sha256 matches the manifest (no edits at the window);
#   - the file, comments removed, is ONE statement starting with SELECT or WITH,
#     with no write/DDL/transaction/session keyword;
#   - HONE_WINDOW_PROJECT_REF is set and equals ./supabase/.temp/project-ref
#     (the ref itself is never printed);
#   - no other database target is set in the environment.
# Then it runs exactly:
#   npx --yes supabase@2.102.0 db query --linked -o json -f <file>
# and nothing else: never --local, never --db-url, never psql.
# With HONE_WINDOW_RESULT_DIR set, the result and a capture sidecar (<name>.meta.json:
# sql/result/runner/manifest sha256, start and capture time, exit code) are written there.
# Otherwise output goes to stdout for the operator to keep privately. It contains counts,
# ordinals, version strings and catalog names only.
# ---------------------------------------------------------------------------
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
refuse() { echo "run-window-read: REFUSED: $*" >&2; exit 2; }

[ "$#" -eq 1 ] || refuse "exactly one argument (a gate file name) is required"
name="$(basename -- "$1")"
file="$here/$name"
[ -f "$file" ] || refuse "no such gate file in $here: $name"

expected_sha="$(awk -v n="$name" '$2 == n { print $1 }' "$here/MANIFEST.sha256")"
[ -n "$expected_sha" ] || refuse "$name is not listed in MANIFEST.sha256"
actual_sha="$(sha256sum "$file" | awk '{ print $1 }')"
[ "$actual_sha" = "$expected_sha" ] || refuse "$name sha256 does not match MANIFEST.sha256 (edited?)"

# Lexical read-only check on the statement text with comments removed.
# String literals are blanked first (a privilege name such as 'EXECUTE' is data).
body="$(sed -e "s/'[^']*'/''/g" -e 's/--.*$//' "$file" | tr '\n' ' ' | tr 'A-Z' 'a-z')"
case "$body" in */\**) refuse "block comments are not allowed" ;; esac
semis="$(printf '%s' "$body" | tr -cd ';' | wc -c)"
[ "$semis" -le 1 ] || refuse "more than one statement"
trimmed="$(printf '%s' "$body" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*;[[:space:]]*$//')"
case "$trimmed" in *';'*) refuse "a semicolon before the end" ;; esac
case "$trimmed" in select\ *|with\ *) ;; *) refuse "the statement must start with SELECT or WITH" ;; esac
if printf '%s' "$trimmed" | grep -E -q '\b(insert|update|delete|merge|truncate|alter|create|drop|grant|revoke|copy|call|do|execute|prepare|set|reset|begin|start|commit|rollback|savepoint|release|vacuum|analyze|cluster|reindex|refresh|lock|listen|notify|unlisten|discard|load|security|comment|import|into)\b'; then
  refuse "a write, DDL, transaction or session keyword is present"
fi
if printf '%s' "$trimmed" | grep -E -q '\b(set_config|nextval|setval|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_advisory[a-z_]*|lo_[a-z_]+|dblink[a-z_]*|pg_read_[a-z_]*|pg_write_[a-z_]*|pg_stat_reset[a-z_]*|pg_sleep[a-z_]*|txid_current|pg_current_xact_id|pg_notify)\b'; then
  refuse "a side-effecting function is present"
fi

[ -n "${HONE_WINDOW_PROJECT_REF:-}" ] || refuse "HONE_WINDOW_PROJECT_REF is not set"
[ -f supabase/.temp/project-ref ] || refuse "run from the linked checkout: ./supabase/.temp/project-ref is missing"
linked="$(tr -d '[:space:]' < supabase/.temp/project-ref)"
[ "$linked" = "$HONE_WINDOW_PROJECT_REF" ] || refuse "the linked project ref does not match HONE_WINDOW_PROJECT_REF"

for v in SUPABASE_DB_URL DATABASE_URL PGHOST PGHOSTADDR PGDATABASE PGSERVICE E2E_SUPABASE_URL HONE_LOCAL_DB_URL; do
  [ -z "${!v:-}" ] || refuse "$v is set; unset every other database target first"
done

# ---------------------------------------------------------------------------
# CAPTURE (compare-preflight binds results to THIS window through it).
# With HONE_WINDOW_RESULT_DIR set to an existing directory, the result is written
# to <dir>/<name without .sql>.json and a sidecar <dir>/<same>.meta.json records
# when and what was captured. Neither file may already exist: a stale result is
# never overwritten, so an old file cannot be mistaken for this run's. Without the
# variable the result goes to stdout as before, and compare-preflight will not
# accept it (no sidecar).
# ---------------------------------------------------------------------------
if [ -n "${HONE_WINDOW_RESULT_DIR:-}" ]; then
  outdir="$HONE_WINDOW_RESULT_DIR"
  [ -d "$outdir" ] || refuse "HONE_WINDOW_RESULT_DIR is not an existing directory"
  stem="${name%.sql}"
  [ ! -e "$outdir/$stem.json" ] && [ ! -e "$outdir/$stem.meta.json" ] || refuse "a result for $stem already exists in HONE_WINDOW_RESULT_DIR (never overwritten)"
  runner_sha="$(sha256sum "$here/run-window-read.sh" | cut -d' ' -f1)"
  manifest_sha="$(sha256sum "$here/MANIFEST.sha256" | cut -d' ' -f1)"
  tmp="$(mktemp "$outdir/.$stem.XXXXXX")"
  started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "run-window-read: $name sha256 ok; linked ref matches; running read-only via --linked; capturing to $outdir" >&2
  rc=0
  npx --yes supabase@2.102.0 db query --linked -o json -f "$file" > "$tmp" || rc=$?
  captured="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  result_sha="$(sha256sum "$tmp" | cut -d' ' -f1)"
  mv "$tmp" "$outdir/$stem.json"
  printf '{"file":"%s","sql_sha256":"%s","result_sha256":"%s","started_at_utc":"%s","captured_at_utc":"%s","exit_code":%s,"runner_sha256":"%s","manifest_sha256":"%s"}\n' \
    "$name" "$expected_sha" "$result_sha" "$started" "$captured" "$rc" "$runner_sha" "$manifest_sha" > "$outdir/$stem.meta.json"
  exit "$rc"
fi

echo "run-window-read: $name sha256 ok; linked ref matches; running read-only via --linked" >&2
exec npx --yes supabase@2.102.0 db query --linked -o json -f "$file"
