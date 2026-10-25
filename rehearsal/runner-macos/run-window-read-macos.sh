#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# macOS / bash 3.2 VARIANT of run-window-read.sh (RUNNER-MACOS). It sits BESIDE the pinned
# runner and replaces nothing: same manifest, same gate files, same refusals, same lexical
# check. Differences (each proved by run-window-read-macos.test.sh):
#   - hashing: sha256sum when present, otherwise `shasum -a 256`; identical parsing;
#   - HONE_SUPABASE_BIN: when set, the CLI is "$HONE_SUPABASE_BIN" db query --linked -o json -f
#     <file> (no npx, no Node), and the run is REFUSED unless that binary's --version prints
#     exactly 2.102.0. Unset, it falls back to the pinned npx line, as before;
#   - hosted-write guards: SUPABASE_DB_PASSWORD must be set and non-empty, and ./supabase/.temp/pooler-url
#     must be exactly the aws-1-us-east-1 session pooler on 5432 for postgres.<project-ref>, no password;
#   - bash 3.2 and BSD tools: no ${!v}, no \b in grep, no GNU-only flags, wc -c padding stripped,
#     LC_ALL=C on the text filters; the sidecar's runner sha is THIS file's own hash.
#
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

# Hash helper: GNU sha256sum when present, else BSD/macOS `shasum -a 256`. Prints the bare hex digest.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{ print $1 }'
  else echo "run-window-read: REFUSED: neither sha256sum nor shasum is available" >&2; exit 2
  fi
}

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
refuse() { echo "run-window-read: REFUSED: $*" >&2; exit 2; }

[ "$#" -eq 1 ] || refuse "exactly one argument (a gate file name) is required"
name="$(basename -- "$1")"
file="$here/$name"
[ -f "$file" ] || refuse "no such gate file in $here: $name"

expected_sha="$(awk -v n="$name" '$2 == n { print $1 }' "$here/MANIFEST.sha256")"
[ -n "$expected_sha" ] || refuse "$name is not listed in MANIFEST.sha256"
actual_sha="$(sha256_of "$file")"
[ "$actual_sha" = "$expected_sha" ] || refuse "$name sha256 does not match MANIFEST.sha256 (edited?)"

# Lexical read-only check on the statement text with comments removed.
# String literals are blanked first (a privilege name such as 'EXECUTE' is data).
body="$(LC_ALL=C sed -e "s/'[^']*'/''/g" -e 's/--.*$//' "$file" | LC_ALL=C tr '\n' ' ' | LC_ALL=C tr 'A-Z' 'a-z')"
case "$body" in */\**) refuse "block comments are not allowed" ;; esac
semis="$(printf '%s' "$body" | tr -cd ';' | wc -c | tr -d '[:space:]')"
[ "$semis" -le 1 ] || refuse "more than one statement"
trimmed="$(printf '%s' "$body" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*;[[:space:]]*$//')"
case "$trimmed" in *';'*) refuse "a semicolon before the end" ;; esac
case "$trimmed" in select\ *|with\ *) ;; *) refuse "the statement must start with SELECT or WITH" ;; esac
has_word() { printf '%s' "$trimmed" | LC_ALL=C grep -E -q "(^|[^a-z0-9_])($1)([^a-z0-9_]|\$)"; }
if has_word '(insert|update|delete|merge|truncate|alter|create|drop|grant|revoke|copy|call|do|execute|prepare|set|reset|begin|start|commit|rollback|savepoint|release|vacuum|analyze|cluster|reindex|refresh|lock|listen|notify|unlisten|discard|load|security|comment|import|into)'; then
  refuse "a write, DDL, transaction or session keyword is present"
fi
if has_word '(set_config|nextval|setval|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_advisory[a-z_]*|lo_[a-z_]+|dblink[a-z_]*|pg_read_[a-z_]*|pg_write_[a-z_]*|pg_stat_reset[a-z_]*|pg_sleep[a-z_]*|txid_current|pg_current_xact_id|pg_notify)'; then
  refuse "a side-effecting function is present"
fi

[ -n "${HONE_WINDOW_PROJECT_REF:-}" ] || refuse "HONE_WINDOW_PROJECT_REF is not set"
[ -f supabase/.temp/project-ref ] || refuse "run from the linked checkout: ./supabase/.temp/project-ref is missing"
linked="$(tr -d '[:space:]' < supabase/.temp/project-ref)"
[ "$linked" = "$HONE_WINDOW_PROJECT_REF" ] || refuse "the linked project ref does not match HONE_WINDOW_PROJECT_REF"

# Hosted-write guards (RUNNER-MACOS addendum). With --linked and NO database password, CLI 2.102.0
# calls the Management API to create a temporary login role (a hosted write), and on the pooler path
# may also un-ban IPs. So: a password must be present (presence only; its value is never read or
# printed), and the linked pooler URL must be the verified session pooler, port 5432, with the
# project's own user and no password embedded. Neither the URL nor the password is ever echoed.
[ -n "$(printenv SUPABASE_DB_PASSWORD 2>/dev/null || true)" ] || refuse "SUPABASE_DB_PASSWORD is not set or is empty (without it the CLI creates a login role, a hosted write)"
case "$HONE_WINDOW_PROJECT_REF" in *[!a-z0-9]*) refuse "HONE_WINDOW_PROJECT_REF is not a plain lower-case project ref" ;; esac
[ -f supabase/.temp/pooler-url ] || refuse "./supabase/.temp/pooler-url is missing"
pooler="$(tr -d '[:space:]' < supabase/.temp/pooler-url)"
pooler_tail="@aws-1-us-east-1.pooler.supabase.com:5432/postgres"
case "$pooler" in
  "postgresql://postgres.$HONE_WINDOW_PROJECT_REF$pooler_tail"|"postgres://postgres.$HONE_WINDOW_PROJECT_REF$pooler_tail") ;;
  *) refuse "supabase/.temp/pooler-url is not exactly the aws-1-us-east-1 session pooler (port 5432, user postgres.<project-ref>, no password, database postgres)" ;;
esac

for v in SUPABASE_DB_URL DATABASE_URL PGHOST PGHOSTADDR PGDATABASE PGSERVICE E2E_SUPABASE_URL HONE_LOCAL_DB_URL; do
  [ -z "$(printenv "$v" 2>/dev/null || true)" ] || refuse "$v is set; unset every other database target first"
done

# The CLI. HONE_SUPABASE_BIN names a verified binary (no npx, no Node); it must report exactly
# 2.102.0. Otherwise the pinned npx line is used, as in the pinned runner.
if [ -n "${HONE_SUPABASE_BIN:-}" ]; then
  [ -f "$HONE_SUPABASE_BIN" ] && [ -x "$HONE_SUPABASE_BIN" ] || refuse "HONE_SUPABASE_BIN is not an executable file"
  bin_version="$("$HONE_SUPABASE_BIN" --version 2>/dev/null || true)"
  [ "$bin_version" = "2.102.0" ] || refuse "HONE_SUPABASE_BIN --version must print exactly 2.102.0"
  cli_desc="the verified binary"
  run_cli() { "$HONE_SUPABASE_BIN" db query --linked -o json -f "$1"; }
else
  cli_desc="npx supabase@2.102.0"
  run_cli() { npx --yes supabase@2.102.0 db query --linked -o json -f "$1"; }
fi

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
  runner_sha="$(sha256_of "${BASH_SOURCE[0]}")"
  manifest_sha="$(sha256_of "$here/MANIFEST.sha256")"
  tmp="$(mktemp "$outdir/.$stem.XXXXXX")"
  started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "run-window-read: $name sha256 ok; linked ref matches; running read-only via --linked ($cli_desc); capturing to $outdir" >&2
  rc=0
  run_cli "$file" > "$tmp" || rc=$?
  captured="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  result_sha="$(sha256_of "$tmp")"
  mv "$tmp" "$outdir/$stem.json"
  printf '{"file":"%s","sql_sha256":"%s","result_sha256":"%s","started_at_utc":"%s","captured_at_utc":"%s","exit_code":%s,"runner_sha256":"%s","manifest_sha256":"%s"}\n' \
    "$name" "$expected_sha" "$result_sha" "$started" "$captured" "$rc" "$runner_sha" "$manifest_sha" > "$outdir/$stem.meta.json"
  exit "$rc"
fi

echo "run-window-read: $name sha256 ok; linked ref matches; running read-only via --linked ($cli_desc)" >&2
run_cli "$file"
