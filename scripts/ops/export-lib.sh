#!/usr/bin/env bash
# Pure helpers for the encrypted-export tools (logical-export.sh, object-export.sh,
# verify-export.sh, export-restore.sh), in their own file so
# tests/scripts/export-tools.test.ts can run them on fixtures.
# Sourced, never executed; no side effects at load.
#
# Design source: 01-ops/RECOVERY-LAYERS-PLAN.md (sections 2, 4, 5, 7). Every
# check here prints counts, names of tables and pass/fail, NEVER a row, a path
# or a key.

US=$'\x1f' # unit separator: object paths may contain '|' and spaces

export_fail() { printf 'EXPORT FAIL: %s\n' "$*" >&2; exit 1; }
export_log() { printf '[export %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

# host of a URL, without credentials or port ("postgresql://u:p@h:5432/db" -> h).
host_of() {
  local s="${1#*://}"
  s="${s#*@}"; s="${s%%/*}"; s="${s%%:*}"
  printf '%s' "$s"
}

is_loopback_host() { case "$1" in 127.0.0.1|localhost|::1|'[::1]') return 0;; *) return 1;; esac; }

# The operator typed a project ref; every URL the tool will touch must name it.
# Loopback is accepted only in rehearsal mode (EXPORT_REHEARSAL=1). Returns 0/1.
url_matches_ref() {
  local url="$1" ref="$2" host
  [ -n "$ref" ] || return 1
  host="$(host_of "$url")"
  if [ "${EXPORT_REHEARSAL:-}" = 1 ] && is_loopback_host "$host"; then return 0; fi
  case "$host" in *"$ref"*) return 0;; *) return 1;; esac
}

# Percent-encode a Storage object path for a URL ('/' kept).
urlencode_path() {
  local LC_ALL=C s="$1" i c out="" h
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_/-]) out+="$c";;
      *) printf -v h '%%%02X' "'$c"; out+="$h";;
    esac
  done
  printf '%s' "$out"
}

# --- markers (V3) ----------------------------------------------------------
# A marker file is written ATOMICALLY (tmp then mv) by a reader running inside
# `tee >(...)`, so its mere existence means the reader finished.

# marker_count FILE: the integer in it, or empty when absent/not an integer.
marker_count() {
  local v
  [ -f "$1" ] || return 0
  v="$(tr -d '[:space:]' <"$1")"
  case "$v" in ''|*[!0-9]*) return 0;; esac
  printf '%s' "$v"
}

# wait_marker FILE [SECONDS]: wait for the atomic write; returns 1 on timeout.
wait_marker() {
  local f="$1" n="${2:-60}" i
  for ((i = 0; i < n * 10; i++)); do
    [ -f "$f" ] && return 0
    sleep 0.1
  done
  return 1
}

# gate_markers DIR: public-clients, auth-identities and storage-objects must
# each be an integer >= 1, or the export is discarded (PLAN V3). Prints each
# failing marker; returns 1 on any.
gate_markers() {
  local dir="$1" m v bad=0
  for m in public-clients auth-identities storage-objects; do
    v="$(marker_count "$dir/markers/$m.count")"
    if [ -z "$v" ] || [ "$v" -lt 1 ]; then echo "marker $m is ${v:-missing}, need >= 1"; bad=1; fi
  done
  return "$bad"
}

# gate_sizes DIR: every *.age part is non-empty.
gate_sizes() {
  local dir="$1" f bad=0
  for f in "$dir"/*.age; do
    [ -s "$f" ] || { echo "part $(basename "$f") is empty"; bad=1; }
  done
  return "$bad"
}

# tables_equal A B: two sorted-unique table-name files are identical. Prints the
# difference (names only) on mismatch.
tables_equal() {
  if ! diff <(sort -u "$1") <(sort -u "$2") >/dev/null; then
    diff <(sort -u "$1") <(sort -u "$2") | sed -n 's/^[<>] /  /p'
    return 1
  fi
}

# --- V1: ciphertext hashes ---------------------------------------------------
hash_record() { (cd "$1" && sha256sum -- *.age >hashes.sha256); }
hash_verify() { (cd "$1" && sha256sum --check --quiet hashes.sha256); }

# --- V2: manifest comparison ---------------------------------------------------
# compare_manifests BEFORE AFTER: row count and md5 of every table, with
# storage.objects compared by COUNT only (its restore refreshes timestamps,
# version and etag; the drill does the same). Returns 0 when identical.
compare_manifests() {
  local before="$1" after="$2" cb ca
  if ! diff -u <(grep -v '^storage\.objects ' "$before") <(grep -v '^storage\.objects ' "$after"); then
    echo "row fingerprints differ"; return 1
  fi
  cb="$(grep '^storage\.objects ' "$before" | sed -E 's/ md5=.*//')"
  ca="$(grep '^storage\.objects ' "$after" | sed -E 's/ md5=.*//')"
  [ -n "$cb" ] && [ "$cb" = "$ca" ] || { echo "storage.objects count differs: '$cb' vs '$ca'"; return 1; }
}

# --- object manifest (section 5) -----------------------------------------------
# One line per object: index<US>path<US>size<US>sha256.
# object_manifest_check FILE EXPECTED_COUNT: the line count equals the listed
# object count, every hash is 64 hex, and no index repeats. Returns 0/1.
object_manifest_check() {
  local content n
  content="$(cat "$1")"   # read ONCE: the caller may pass a process substitution
  local expected="$2"
  n="$(printf '%s\n' "$content" | grep -c . || true)"
  [ "$n" = "$expected" ] || { echo "manifest has $n line(s), $expected object(s) were listed"; return 1; }
  if printf '%s\n' "$content" | awk -F "$US" 'NF != 4 || $4 !~ /^[0-9a-f]{64}$/ || $3 !~ /^[0-9]+$/ { bad = 1 } END { exit bad }'; then :; else
    echo "manifest has a malformed line"; return 1
  fi
  [ "$(printf '%s\n' "$content" | cut -d "$US" -f1 | sort -u | wc -l | tr -d ' ')" = "$n" ] || { echo "manifest repeats an index"; return 1; }
}

# --- one snapshot, held open (PLAN section 2: dump parts and the V2 counts must
# describe the same instant) -------------------------------------------------
# snap_open opens a REPEATABLE READ READ ONLY transaction through the command
# words in PSQL_CMD (an array), exports its snapshot id into SNAPSHOT_ID, and
# keeps the session open for pg_dump --snapshot and for snap_query. The session
# must outlive every dump, so snap_close is the LAST step.
snap_open() {
  coproc SNAP { "${PSQL_CMD[@]}" -qAtX -F "$US" -v ON_ERROR_STOP=1; }
  printf '%s\n' "begin isolation level repeatable read read only;" >&"${SNAP[1]}"
  printf '%s\n' "select pg_export_snapshot();" >&"${SNAP[1]}"
  local line
  SNAPSHOT_ID=""
  while IFS= read -r -u "${SNAP[0]}" line; do
    case "$line" in [0-9A-F]*-[0-9A-F]*) SNAPSHOT_ID="$line"; break;; esac
  done
  [ -n "$SNAPSHOT_ID" ] || export_fail "no snapshot id from the database session"
}

# snap_query ONE_LINE_SQL: runs one statement and leaves its result lines in the
# array SNAP_OUT (no row content is ever logged by the callers). The statement
# must be one line. It must run in the MAIN shell, never in a pipeline or a
# command substitution: bash closes the coproc descriptors in those subshells.
snap_query() {
  local line
  SNAP_OUT=()
  printf '%s\n' "$1" >&"${SNAP[1]}"
  printf '%s\n' "select 'EXPORT-EOF';" >&"${SNAP[1]}"
  while IFS= read -r -u "${SNAP[0]}" line; do
    [ "$line" = "EXPORT-EOF" ] && return 0
    SNAP_OUT+=("$line")
  done
  export_fail "the database session ended during a query"
}

snap_close() {
  printf '%s\n' "commit;" >&"${SNAP[1]}" 2>/dev/null || true
  eval "exec ${SNAP[1]}>&-" 2>/dev/null || true
  wait "$SNAP_PID" 2>/dev/null || true
}

# The V2 fingerprint query: per table, count(*) and an order-independent md5 of
# the row text. EXACTLY the drill's manifest() (scripts/ops/restore-drill.sh),
# on one line so snap_query can send it.
MANIFEST_SQL="select format('%s.%s rows=%s md5=%s', schemaname, relname, n, h) from (select t.schemaname, t.relname, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', t.schemaname, t.relname), false, true, '')))[1]::text as n, (xpath('/row/h/text()', query_to_xml(format('select md5(coalesce(string_agg(x::text, %L order by x::text), %L)) as h from %I.%I x', E'\\n', '', t.schemaname, t.relname), false, true, '')))[1]::text as h from pg_stat_user_tables t where t.schemaname = 'public' or (t.schemaname = 'storage' and t.relname in ('buckets', 'objects')) or (t.schemaname = 'auth' and t.relname <> 'schema_migrations')) s order by 1;"

# The commands behind the two connections. PRODUCTION: pg_dump/psql with the
# URL the operator typed. REHEARSAL (EXPORT_REHEARSAL=1) may override both with
# EXPORT_PG_DUMP / EXPORT_PSQL, so a CI job can reach a throwaway database in a
# container; outside rehearsal an override is refused.
export_configure_commands() {
  if [ -n "${EXPORT_PG_DUMP:-}${EXPORT_PSQL:-}" ] && [ "${EXPORT_REHEARSAL:-}" != 1 ]; then
    export_fail "EXPORT_PG_DUMP / EXPORT_PSQL are rehearsal-only (EXPORT_REHEARSAL=1)"
  fi
  if [ -n "${EXPORT_PG_DUMP:-}" ]; then read -r -a PGDUMP_CMD <<<"$EXPORT_PG_DUMP"; else PGDUMP_CMD=(pg_dump "$DB_URL"); fi
  if [ -n "${EXPORT_PSQL:-}" ]; then read -r -a PSQL_CMD <<<"$EXPORT_PSQL"; else PSQL_CMD=(psql "$DB_URL"); fi
}

# Prompt for a secret without echo and without a file or argument.
read_secret() { # read_secret VARNAME PROMPT
  local v
  [ -r /dev/tty ] || export_fail "no terminal to read $1 from; it is never taken from a file or an argument"
  printf '%s' "$2" >/dev/tty
  IFS= read -r -s v </dev/tty; printf '\n' >/dev/tty
  [ -n "$v" ] || export_fail "$1 was empty"
  printf -v "$1" '%s' "$v"
}

# secret_input VAR PROMPT: outside rehearsal the secret MUST be typed (an
# already-set variable is refused, so a secret an agent session holds is never
# used); in rehearsal (CI, synthetic) it must come from the environment.
secret_input() {
  local name="$1"
  if [ "${EXPORT_REHEARSAL:-}" = 1 ]; then
    [ -n "${!name:-}" ] || export_fail "rehearsal needs $name in the environment"
    return 0
  fi
  [ -z "${!name:-}" ] || export_fail "$name is set in the environment; secrets are typed at a prompt (unset it)"
  read_secret "$name" "$2"
}
