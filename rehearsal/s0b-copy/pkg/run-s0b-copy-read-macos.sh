#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# S0B COPY-POOLER VARIANT of run-window-read-macos.sh (471ecb9d): for the S0b RESTORED project's reads ONLY. Differences: the pooler tail is
# aws-0-us-east-1 (the restored project's session pooler), and it REFUSES the production ref outright, so it can never read production.
# macOS / bash 3.2 VARIANT of run-window-read.sh (RUNNER-MACOS). It sits BESIDE the pinned
# runner and replaces nothing: same manifest, same gate files, same refusals, same lexical
# check. Differences (each proved by run-window-read-macos.test.sh):
#   - hashing: sha256sum when present, otherwise `shasum -a 256`; identical parsing;
#   - HONE_SUPABASE_BIN is MANDATORY and is gated by its SHA-256, not by running it: the file must
#     hash to the constant SUPABASE_GO_SHA256 below (the darwin_arm64 supabase-go of v2.102.0). The
#     binary is never executed before that hash is checked, and `--version` is never called: in
#     v2.102.0 the --version flag always fetches the latest release from GitHub
#     (apps/cli-go/cmd/root.go, shouldFetchRelease), a network call this runner must not make;
#   - the CLI call is exactly
#       env -u GITHUB_TOKEN -u GH_TOKEN SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 \
#         "$HONE_SUPABASE_BIN" --agent no db query --linked -o json -f <file>
#     `--agent no` is the root flag (values yes|no|auto) that turns off agent-mode output: in agent
#     mode the result is wrapped in an "untrusted data" envelope object instead of a bare array.
#     The run is REFUSED (exit 3, result kept) unless the output is a JSON array of objects.
#     compare-preflight accepts a bare array or an object with a "rows" array, and rejects an
#     error payload with no rows, so a bare array is what it expects;
#   - ./supabase/.temp/cli-latest must exist, contain exactly v2.102.0 and be younger than 9 hours:
#     the CLI re-fetches the latest release (a GitHub call) and rewrites that file when it is missing
#     or older than 10 hours, and prints an upgrade notice when it names a newer version;
#   - refuses ANY SUPABASE_* environment variable except SUPABASE_DB_PASSWORD, SUPABASE_ACCESS_TOKEN and
#     SUPABASE_TELEMETRY_DISABLED (forced to 1 on the call).
#     The Go CLI reads its project ref from viper PROJECT_ID (env SUPABASE_PROJECT_ID) BEFORE
#     supabase/.temp/project-ref, which would bypass the ref-equality guard below; SUPABASE_PROFILE,
#     SUPABASE_WORKDIR and SUPABASE_PROJECT_REF steer the same lookups;
#   - hosted-write guards: SUPABASE_DB_PASSWORD must be set and non-empty. Why, from v2.102.0 source:
#     `db query --linked` itself runs the query through the Management API (query.RunLinked ->
#     V1RunAQuery), BUT the root PersistentPreRunE (apps/cli-go/cmd/root.go:93-120) calls
#     flags.ParseDatabaseConfig for EVERY command first. For --linked with no DB_PASSWORD that
#     reaches NewDbConfigWithPassword -> initLoginRole (V1CreateLoginRole, creating a temporary
#     login role: a hosted write) and, on the pooler path, initPoolerLogin (which also un-bans IPs
#     after 3 failed connects). Past --linked reads printed "Initialising login role..." for exactly
#     this reason. A second prerequisite, not checked here (it can live in the keyring): a Supabase
#     access token (SUPABASE_ACCESS_TOKEN, the keyring, or ~/.supabase/access-token; never printed).
#     ./supabase/.temp/pooler-url must be exactly the aws-1-us-east-1 session pooler on 5432 for
#     postgres.<project-ref>, with no password;
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
#   the CLI call described above
# and nothing else: never --local, never --db-url, never psql.
# With HONE_WINDOW_RESULT_DIR set, the result and a capture sidecar (<name>.meta.json:
# sql/result/runner/manifest sha256, start and capture time, exit code) are written there.
# Otherwise output goes to stdout for the operator to keep privately. It contains counts,
# ordinals, version strings and catalog names only.
# ---------------------------------------------------------------------------
set -euo pipefail

# The one binary this runner will run: supabase-go for darwin_arm64 from supabase_2.102.0_darwin_arm64.tar.gz.
# A test may substitute this constant ONLY in a test copy of this file; there is no environment override.
SUPABASE_GO_SHA256=dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b

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
[ "$HONE_WINDOW_PROJECT_REF" != "alhhybgqdmcdyzpybykj" ] || refuse "this S0b copy runner never reads the production project"
pooler_tail="@aws-0-us-east-1.pooler.supabase.com:5432/postgres"
case "$pooler" in
  "postgresql://postgres.$HONE_WINDOW_PROJECT_REF$pooler_tail"|"postgres://postgres.$HONE_WINDOW_PROJECT_REF$pooler_tail") ;;
  *) refuse "supabase/.temp/pooler-url is not exactly the aws-0-us-east-1 session pooler (port 5432, user postgres.<project-ref>, no password, database postgres)" ;;
esac

for v in SUPABASE_DB_URL DATABASE_URL PGHOST PGHOSTADDR PGDATABASE PGSERVICE E2E_SUPABASE_URL HONE_LOCAL_DB_URL; do
  [ -z "$(printenv "$v" 2>/dev/null || true)" ] || refuse "$v is set; unset every other database target first"
done

# SUPABASE_* environment: the CLI binds every SUPABASE_<NAME> to its flags and config (viper). Only the
# three named below may be present (SUPABASE_TELEMETRY_DISABLED is forced to 1 on the call anyway); SUPABASE_PROJECT_ID would override the project ref the guard above checked.
for v in $(env | sed -n 's/^\(SUPABASE_[A-Za-z0-9_]*\)=.*/\1/p'); do
  case "$v" in SUPABASE_DB_PASSWORD|SUPABASE_ACCESS_TOKEN|SUPABASE_TELEMETRY_DISABLED) ;; *) refuse "$v is set; the CLI would read it (project ref, profile or workdir bypass); unset it" ;; esac
done

# The CLI is told the version it is, so it makes no release lookup: cli-latest must be fresh and name v2.102.0.
[ -f supabase/.temp/cli-latest ] || refuse "./supabase/.temp/cli-latest is missing (seed it with v2.102.0 first)"
[ "$(tr -d '[:space:]' < supabase/.temp/cli-latest)" = "v2.102.0" ] || refuse "./supabase/.temp/cli-latest must contain exactly v2.102.0"
[ -z "$(find supabase/.temp/cli-latest -mmin +540 2>/dev/null)" ] || refuse "./supabase/.temp/cli-latest is older than 9 hours (the CLI would fetch the latest release and rewrite it); re-seed it"

# The CLI. HONE_SUPABASE_BIN is mandatory and must BE the pinned supabase-go: it is hashed, never executed first.
[ -n "${HONE_SUPABASE_BIN:-}" ] || refuse "HONE_SUPABASE_BIN is not set (it is mandatory; there is no npx fallback)"
[ -f "$HONE_SUPABASE_BIN" ] && [ -x "$HONE_SUPABASE_BIN" ] || refuse "HONE_SUPABASE_BIN is not an executable file"
[ "$(sha256_of "$HONE_SUPABASE_BIN")" = "$SUPABASE_GO_SHA256" ] || refuse "HONE_SUPABASE_BIN does not hash to the pinned supabase-go ($SUPABASE_GO_SHA256)"
cli_desc="the pinned supabase-go"
run_cli() { env -u GITHUB_TOKEN -u GH_TOKEN SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 "$HONE_SUPABASE_BIN" --agent no db query --linked -o json -f "$1"; }
# The result must be a JSON array of objects (lexical check on the whitespace-stripped text; the comparator parses it fully).
result_is_array() { c="$(LC_ALL=C tr -d '[:space:]' < "$1")"; case "$c" in "[]"|"[{"*"}]") return 0 ;; *) return 1 ;; esac; }

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
  if [ "$rc" -eq 0 ] && ! result_is_array "$tmp"; then echo "run-window-read: REFUSED: the CLI output is not a JSON array of objects (agent-mode envelope or error text); exit_code recorded as 3" >&2; rc=3; fi
  captured="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  result_sha="$(sha256_of "$tmp")"
  mv "$tmp" "$outdir/$stem.json"
  printf '{"file":"%s","sql_sha256":"%s","result_sha256":"%s","started_at_utc":"%s","captured_at_utc":"%s","exit_code":%s,"runner_sha256":"%s","manifest_sha256":"%s"}\n' \
    "$name" "$expected_sha" "$result_sha" "$started" "$captured" "$rc" "$runner_sha" "$manifest_sha" > "$outdir/$stem.meta.json"
  exit "$rc"
fi

echo "run-window-read: $name sha256 ok; linked ref matches; running read-only via --linked ($cli_desc)" >&2
out="$(mktemp "${TMPDIR:-/tmp}/run-window-read.XXXXXX")"
rc=0
run_cli "$file" > "$out" || rc=$?
if [ "$rc" -eq 0 ] && ! result_is_array "$out"; then
  rm -f "$out"; echo "run-window-read: REFUSED: the CLI output is not a JSON array of objects (agent-mode envelope or error text)" >&2; exit 3
fi
cat "$out"; rm -f "$out"
exit "$rc"
