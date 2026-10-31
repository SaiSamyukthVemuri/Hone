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

# --- one strict connection-URL parser (Codex P1/P2 on 1432d095/7f5246be) -------------
# libpq lets a URL's query string override its authority (?host=, ?hostaddr=, ?port=,
# ?dbname=, ?user=, ?service=, ?password=; host= may even list several hosts), so a ref
# check that reads only the authority can pass a disposable host while libpq connects to
# production. Every host check, the production-host guard and the argv the tools build
# therefore come from THIS parser, which is fail-closed:
#   * scheme postgresql/postgres (database) or http/https (Storage), nothing else;
#   * the authority is everything up to the first '/', '?' or '#'; at most ONE '@'
#     (an unencoded '@' in a password is refused: write %40);
#   * the host is a plain hostname or a bracketed IPv6 literal: no ',' (multi-host), no '%'
#     (percent-encoded host), no '/' (socket directory), no empty host;
#   * the port is digits; the database name is [A-Za-z0-9_.-]*;
#   * the ONLY query parameter allowed is sslmode=<a fixed value>; host, hostaddr, port,
#     dbname, user, service, password and anything else is refused, and so is a '#'.
# On success it sets CONN_SCHEME CONN_USER CONN_PASS (decoded) CONN_HOST CONN_PORT CONN_DB
# CONN_SSLMODE; on refusal it returns 1 with CONN_REASON.
parse_conn_url() {
  local url="$1" rest authority afterauth userinfo hostport path query ats pair
  CONN_SCHEME="" CONN_USER="" CONN_PASS="" CONN_USER_RAW="" CONN_HOST="" CONN_PORT="" CONN_DB="" CONN_SSLMODE="" CONN_REASON=""
  case "$url" in
    postgresql://*|postgres://*|http://*|https://*) CONN_SCHEME="${url%%://*}";;
    *) CONN_REASON="unsupported scheme"; return 1;;
  esac
  rest="${url#*://}"
  case "$rest" in *[[:space:]]*|*\\*|*"#"*) CONN_REASON="whitespace, backslash or fragment in the URL"; return 1;; esac
  authority="${rest%%[/?]*}"; afterauth="${rest#"$authority"}"
  path="${afterauth%%\?*}"; query=""
  if [[ "$afterauth" == *\?* ]]; then query="${afterauth#*\?}"; fi
  ats="${authority//[^@]/}"
  [ "${#ats}" -le 1 ] || { CONN_REASON="more than one '@' in the authority (encode '@' in a password as %40)"; return 1; }
  if [[ "$authority" == *@* ]]; then
    userinfo="${authority%@*}"; hostport="${authority##*@}"
    case "$CONN_SCHEME" in http|https) CONN_REASON="credentials in a Storage URL"; return 1;; esac
    CONN_USER_RAW="${userinfo%%:*}"
    # A '%' must start a valid two-hex-digit escape (and not %00): a malformed one is
    # refused, never mangled into a different password (Insurance N4).
    local pctcheck="${userinfo//%[0-9A-Fa-f][0-9A-Fa-f]/}"
    [[ "$pctcheck" != *%* ]] || { CONN_REASON="a malformed percent sign in the credentials (write a literal '%' as %25)"; return 1; }
    case "$userinfo" in *%00*) CONN_REASON="an encoded NUL in the credentials"; return 1;; esac
    CONN_USER="$(urldecode "$CONN_USER_RAW")"
    if [[ "$userinfo" == *:* ]]; then CONN_PASS="$(urldecode "${userinfo#*:}")"; fi
  else
    hostport="$authority"
  fi
  if [[ "$hostport" =~ ^\[([0-9A-Fa-f:.]+)\](:([0-9]{1,5}))?$ ]]; then
    CONN_HOST="[${BASH_REMATCH[1]}]"; CONN_PORT="${BASH_REMATCH[3]}"
  elif [[ "$hostport" =~ ^([A-Za-z0-9.-]+)(:([0-9]{1,5}))?$ ]]; then
    CONN_HOST="${BASH_REMATCH[1]}"; CONN_PORT="${BASH_REMATCH[3]}"
  else
    CONN_REASON="the host is not a single plain hostname (no list, no percent-encoding, no socket path)"; return 1
  fi
  if [ -n "$CONN_PORT" ] && { [ "$((10#$CONN_PORT))" -lt 1 ] || [ "$((10#$CONN_PORT))" -gt 65535 ]; }; then CONN_REASON="port out of range"; return 1; fi
  case "$CONN_SCHEME" in
    postgresql|postgres)
      [[ "$path" =~ ^(/([A-Za-z0-9_.-]*))?$ ]] || { CONN_REASON="the database name has characters outside [A-Za-z0-9_.-]"; return 1; }
      CONN_DB="${BASH_REMATCH[2]}"
      if [ -n "$query" ]; then
        local -a pairs; IFS='&' read -r -a pairs <<<"$query"
        for pair in "${pairs[@]}"; do
          case "$pair" in
            sslmode=disable|sslmode=allow|sslmode=prefer|sslmode=require|sslmode=verify-ca|sslmode=verify-full)
              [ -z "$CONN_SSLMODE" ] || { CONN_REASON="sslmode given twice"; return 1; }
              CONN_SSLMODE="${pair#sslmode=}";;
            *) CONN_REASON="a connection-string parameter other than sslmode (host, hostaddr, port, dbname, user, service, password ... all override the checked authority)"; return 1;;
          esac
        done
      fi;;
    *)
      [[ "$path" =~ ^(/[A-Za-z0-9._~%/-]*)?$ ]] || { CONN_REASON="unexpected characters in the Storage URL path"; return 1; }
      [ -z "$query" ] || { CONN_REASON="a query string in a Storage URL"; return 1; };;
  esac
  # N1: the Storage URL carries the service-role key and every object, so it is https;
  # plain http exists only for the CI rehearsal's loopback.
  if [ "$CONN_SCHEME" = http ] && ! { is_rehearsal && is_loopback_host "$CONN_HOST"; }; then
    CONN_REASON="a Storage URL must be https (http is accepted only for the CI rehearsal's loopback)"; return 1
  fi
  return 0
}

# host of a URL as the strict parser reads it (without credentials or port). Empty when the
# URL is refused, and an empty host never names a ref, so every caller fails closed.
host_of() {
  parse_conn_url "$1" || return 0
  printf '%s' "$CONN_HOST"
}

# require_conn_url URL WHAT: refuse, loudly and by reason, any URL the strict parser refuses.
require_conn_url() {
  parse_conn_url "$1" || export_fail "$2 refused: $CONN_REASON"
}

# libpq reads PGHOST / PGHOSTADDR / PGPORT / PGSERVICE / ... from the environment too
# (PGHOSTADDR overrides the address a checked host resolves to), so none may be set.
export_guard_libpq_env() {
  local v
  for v in PGHOST PGHOSTADDR PGPORT PGSERVICE PGSERVICEFILE PGDATABASE PGUSER PGOPTIONS PGSSLMODE PGSSLROOTCERT PGSSLCERT PGSSLKEY PGPASSFILE PGGSSENCMODE PGSYSCONFDIR; do
    [ -z "${!v:-}" ] || export_fail "$v is set in the environment; libpq would let it override the checked target; unset it"
  done
}

is_loopback_host() { case "$1" in 127.0.0.1|localhost|::1|'[::1]') return 0;; *) return 1;; esac; }

# --- rehearsal mode exists ONLY in a GitHub Actions job ---------------------------
# EXPORT_REHEARSAL=1 lets a CI job use a loopback target, take secrets from the
# environment and point the two commands at a container. None of that may be
# reachable on an operator's machine, so it requires GITHUB_ACTIONS=true too, and
# every rehearsal-only variable is refused without it (Privacy PEER-1155 M1).
is_rehearsal() { [ "${EXPORT_REHEARSAL:-}" = 1 ] && [ "${GITHUB_ACTIONS:-}" = true ]; }

export_guard_rehearsal() {
  if [ -n "${EXPORT_REHEARSAL:-}${EXPORT_REHEARSAL_REF:-}${EXPORT_PG_DUMP:-}${EXPORT_PSQL:-}${EXPORT_TEST_HOOK_AFTER_LIST:-}${EXPORT_TEST_HOOK_AFTER_UPLOAD:-}" ] && ! is_rehearsal; then
    export_fail "the EXPORT_REHEARSAL* / EXPORT_PG_DUMP / EXPORT_PSQL / EXPORT_TEST_HOOK_* variables exist only for the CI rehearsal (EXPORT_REHEARSAL=1 and GITHUB_ACTIONS=true); refusing"
  fi
}

# rehearsal_override_ok TOOL WORD...: the ONLY command an override may be is
# `docker exec -i supabase_db_<rehearsal ref> <TOOL> -U postgres -d postgres`,
# plus, for pg_dump, --exclude-table=... controls. Any other target, option or
# program (another container, -h, -e, a script) is refused.
rehearsal_override_ok() {
  local tool="$1"; shift
  local -a w=("$@")
  [ "${w[0]:-}" = docker ] && [ "${w[1]:-}" = exec ] && [ "${w[2]:-}" = "-i" ] || return 1
  [ -n "${EXPORT_REHEARSAL_REF:-}" ] && [ "${w[3]:-}" = "supabase_db_${EXPORT_REHEARSAL_REF}" ] || return 1
  [ "${w[4]:-}" = "$tool" ] && [ "${w[5]:-}" = "-U" ] && [ "${w[6]:-}" = postgres ] && [ "${w[7]:-}" = "-d" ] && [ "${w[8]:-}" = postgres ] || return 1
  local i
  for ((i = 9; i < ${#w[@]}; i++)); do
    [ "$tool" = pg_dump ] && [[ "${w[$i]}" == --exclude-table=* ]] || return 1
  done
}

# A host carries the project ref when ONE of its dot-separated labels IS the ref
# (db.<ref>.supabase.co, <ref>.supabase.co), not when the ref is a substring of a
# label (Privacy PEER-1155 L2).
host_has_label() { case ".$1." in *".$2."*) return 0;; *) return 1;; esac; }

# N2: outside the CI rehearsal's loopback a host names the ref only in the two Supabase
# forms this tool uses, EXACTLY: db.<ref>.supabase.co (database) and <ref>.supabase.co
# (Storage). A host that merely contains the ref as a label (db.<ref>.attacker.example,
# <ref>.attacker.example, a.b.<ref>.supabase.co) is refused. The pooler form
# (aws-N-<region>.pooler.supabase.com, ref in the user name) is NOT used by these tools
# (a pooled session cannot hold the export snapshot) and is refused.
host_is_supabase_form() { [ "$1" = "db.$2.supabase.co" ] || [ "$1" = "$2.supabase.co" ]; }

# The operator typed a project ref; every URL the tool will touch must name it.
# Loopback is accepted only in rehearsal mode AND only for the one ref the
# rehearsal declares (EXPORT_REHEARSAL_REF), so a wrong typed ref is refused in
# rehearsal exactly as it is in production. Returns 0/1.
url_matches_ref() {
  local url="$1" ref="$2" host
  [ -n "$ref" ] || return 1
  parse_conn_url "$url" || return 1
  host="$CONN_HOST"
  if is_rehearsal && is_loopback_host "$host" && [ "$ref" = "${EXPORT_REHEARSAL_REF:-}" ]; then return 0; fi
  host_has_label "$host" "$ref" && host_is_supabase_form "$host" "$ref"
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
# difference (names only) on mismatch. A missing file is a mismatch, never "empty".
tables_equal() {
  [ -f "$1" ] && [ -f "$2" ] || { echo "  a table list is missing"; return 1; }
  if ! diff <(sort -u "$1") <(sort -u "$2") >/dev/null; then
    diff <(sort -u "$1") <(sort -u "$2") | sed -n 's/^[<>] /  /p'
    return 1
  fi
}

# --- V1: ciphertext hashes ---------------------------------------------------
hash_record() { (cd "$1" && sha256sum -- *.age >hashes.sha256); }
hash_verify() { (cd "$1" && sha256sum --check --quiet hashes.sha256); }
# hash_record_objects DIR: hashes manifest.age and every objects/*.age. The names go through
# the printf BUILTIN and xargs, never as one exec argument list, so a bucket with tens of
# thousands of objects cannot fail with "Argument list too long" (Codex P2 4371423762).
hash_record_objects() { (cd "$1" && printf '%s\0' manifest.age objects/*.age | xargs -0 sha256sum -- >hashes.sha256); }

# --- V2: manifest comparison ---------------------------------------------------
# compare_manifests BEFORE AFTER: row count and md5 of every table, with
# storage.objects compared by COUNT only (its restore refreshes timestamps,
# version and etag; the drill does the same). Returns 0 when identical.
compare_manifests() {
  local before="$1" after="$2" cb ca
  [ -s "$before" ] && [ -s "$after" ] || { echo "a manifest is missing or empty"; return 1; }
  if ! diff -u <(grep -v '^storage\.objects ' "$before") <(grep -v '^storage\.objects ' "$after"); then
    echo "row fingerprints differ"; return 1
  fi
  cb="$(grep '^storage\.objects ' "$before" | sed -E 's/ md5=.*//')"
  ca="$(grep '^storage\.objects ' "$after" | sed -E 's/ md5=.*//')"
  [ -n "$cb" ] && [ "$cb" = "$ca" ] || { echo "storage.objects count differs: '$cb' vs '$ca'"; return 1; }
}

# --- object manifest (section 5) -----------------------------------------------
# MANIFEST_VERSION 2. The decrypted manifest is:
#   manifest-version=2
#   index<US>path<US>size<US>sha256<US>content-type     (one line per object)
#   count=N total_bytes=T
# The content type is the object's original storage.objects metadata.mimetype: a
# restore uploads with it and verifies the restored metadata equals it (Codex P2
# 4371272761). A version-1 manifest (no version line, four fields) is refused by name.
MANIFEST_VERSION=2

# object_manifest_check FILE EXPECTED_COUNT: the line count equals the listed
# object count, every line has five fields, every hash is 64 hex, every content
# type is type/subtype, and no index repeats. Returns 0/1.
object_manifest_check() {
  local content n
  content="$(cat "$1")"   # read ONCE: the caller may pass a process substitution
  local expected="$2"
  n="$(printf '%s\n' "$content" | grep -c . || true)"
  [ "$n" = "$expected" ] || { echo "manifest has $n line(s), $expected object(s) were listed"; return 1; }
  if printf '%s\n' "$content" | awk -F "$US" 'NF != 5 || $4 !~ /^[0-9a-f]{64}$/ || $3 !~ /^[0-9]+$/ || $5 !~ /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/ { bad = 1 } END { exit bad }'; then :; else
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
  coproc SNAP { with_pgpass "${PSQL_CMD[@]}" -qAtX -F "$US" -v ON_ERROR_STOP=1; }
  # Bash UNSETS $SNAP_PID and the $SNAP array the moment the coprocess exits, and under
  # `set -u` any later expansion of them aborts the tool (Codex P2 4371272758). Keep the
  # PID and both descriptors in plain variables, taken before anything else runs.
  SNAP_WAIT_PID="${SNAP_PID:-}"
  SNAP_IN="${SNAP[1]:-}"
  SNAP_OUT_FD="${SNAP[0]:-}"
  SNAP_IS_OPEN=1
  [ -n "$SNAP_IN" ] && [ -n "$SNAP_OUT_FD" ] || export_fail "the database session did not start"
  printf '%s\n' "begin isolation level repeatable read read only;" >&"$SNAP_IN"
  printf '%s\n' "select pg_export_snapshot();" >&"$SNAP_IN"
  local line
  SNAPSHOT_ID=""
  # Bounded: a session that never answers must not hang the tool (-t 120 ends the loop).
  while IFS= read -r -t 120 -u "$SNAP_OUT_FD" line; do
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
  printf '%s\n' "$1" >&"$SNAP_IN"
  printf '%s\n' "select 'EXPORT-EOF';" >&"$SNAP_IN"
  while IFS= read -r -u "$SNAP_OUT_FD" line; do
    [ "$line" = "EXPORT-EOF" ] && return 0
    SNAP_OUT+=("$line")
  done
  export_fail "the database session ended during a query"
}

snap_close() {
  [ "${SNAP_IS_OPEN:-}" = 1 ] || return 0
  SNAP_IS_OPEN=0
  printf '%s\n' "commit;" >&"$SNAP_IN" 2>/dev/null || true
  eval "exec ${SNAP_IN}>&-" 2>/dev/null || true
  [ -z "$SNAP_WAIT_PID" ] || wait "$SNAP_WAIT_PID" 2>/dev/null || true
}

# The V2 fingerprint query: per table, count(*) and an order-independent md5 of
# the row text. EXACTLY the drill's manifest() (scripts/ops/restore-drill.sh),
# on one line so snap_query can send it.
MANIFEST_SQL="select format('%s.%s rows=%s md5=%s', schemaname, relname, n, h) from (select t.schemaname, t.relname, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', t.schemaname, t.relname), false, true, '')))[1]::text as n, (xpath('/row/h/text()', query_to_xml(format('select md5(coalesce(string_agg(x::text, %L order by x::text), %L)) as h from %I.%I x', E'\\n', '', t.schemaname, t.relname), false, true, '')))[1]::text as h from pg_stat_user_tables t where t.schemaname = 'public' or (t.schemaname = 'storage' and t.relname in ('buckets', 'objects')) or (t.schemaname = 'auth' and t.relname <> 'schema_migrations')) s order by 1;"

# --- secrets never go in argv (Privacy PEER-1155 M2) -------------------------------
# The connection string is split: the command gets it WITHOUT the password, and
# the password reaches psql/pg_dump only as PGPASSWORD in that one child's
# environment (with_pgpass). The service-role key goes to curl through a private
# 0600 header file (-H @file), never on a command line. /proc/<pid>/cmdline and
# `ps` therefore show neither.
DB_URL_NOPASS="" DB_PASS="" DB_SSLMODE=""
EXPORT_SECRET_FILES=()
EXPORT_WORKDIRS=()

urldecode() { local LC_ALL=C; printf '%b' "${1//%/\\x}"; }

split_db_url() {
  # The argv is REBUILT from the parsed pieces: scheme, user, host, port, database. No query
  # string and no password ever reaches psql/pg_dump; sslmode travels as PGSSLMODE.
  parse_conn_url "$DB_URL" || export_fail "the connection string is refused: $CONN_REASON"
  case "$CONN_SCHEME" in postgresql|postgres) ;; *) export_fail "the connection string must be postgresql://";; esac
  DB_PASS="$CONN_PASS"; DB_SSLMODE="$CONN_SSLMODE"
  # N3: outside the CI rehearsal's loopback the connection is verify-full, never weaker.
  # A weaker sslmode in the URL is refused. Supabase's database certificate chains to
  # Supabase's own CA, which system trust stores do not hold, so verify-full needs that CA
  # in libpq's default root file (~/.postgresql/root.crt); the tool does not accept
  # PGSSLROOTCERT (refused above), so the operator installs it there. Without it the tool
  # refuses rather than falling back to an unverified TLS mode.
  if ! { is_rehearsal && is_loopback_host "$CONN_HOST"; }; then
    [ -z "$CONN_SSLMODE" ] || [ "$CONN_SSLMODE" = verify-full ] || export_fail "sslmode=$CONN_SSLMODE is weaker than verify-full; refusing"
    [ -s "${HOME:-/nonexistent}/.postgresql/root.crt" ] || export_fail "verify-full needs the Supabase root CA in \$HOME/.postgresql/root.crt (the tool accepts no other root and no weaker mode); refusing"
    DB_SSLMODE=verify-full
  fi
  DB_URL_NOPASS="$CONN_SCHEME://${CONN_USER_RAW:+$CONN_USER_RAW@}$CONN_HOST${CONN_PORT:+:$CONN_PORT}${CONN_DB:+/$CONN_DB}"
}

# with_pgpass COMMAND...: run COMMAND with PGPASSWORD in ITS environment only.
with_pgpass() {
  # PGPASSFILE=/dev/null: a ~/.pgpass entry can never supply a password the operator did not type.
  if [ -n "$DB_PASS" ] && [ -n "${DB_SSLMODE:-}" ]; then PGPASSFILE=/dev/null PGSSLMODE="$DB_SSLMODE" PGPASSWORD="$DB_PASS" "$@"
  elif [ -n "$DB_PASS" ]; then PGPASSFILE=/dev/null PGPASSWORD="$DB_PASS" "$@"
  elif [ -n "${DB_SSLMODE:-}" ]; then PGPASSFILE=/dev/null PGSSLMODE="$DB_SSLMODE" "$@"
  else PGPASSFILE=/dev/null "$@"; fi
}

# make_auth_header_file: writes the Storage API headers for SERVICE_KEY to a
# private file (mode 0600, on tmpfs when XDG_RUNTIME_DIR is one) and sets
# AUTH_HDR_FILE. Removed by export_cleanup_secrets. Use: curl -H @"$AUTH_HDR_FILE".
make_auth_header_file() {
  local dir="${XDG_RUNTIME_DIR:-}"
  { [ -n "$dir" ] && [ -d "$dir" ] && [ -w "$dir" ]; } || dir="${TMPDIR:-/tmp}"
  AUTH_HDR_FILE="$(umask 077; mktemp "$dir/export-hdr.XXXXXX")"
  EXPORT_SECRET_FILES+=("$AUTH_HDR_FILE")
  printf 'Authorization: Bearer %s\napikey: %s\n' "$SERVICE_KEY" "$SERVICE_KEY" >"$AUTH_HDR_FILE"
}

export_cleanup_secrets() {
  if [ "${#EXPORT_SECRET_FILES[@]}" -gt 0 ]; then rm -f "${EXPORT_SECRET_FILES[@]}" 2>/dev/null || true; fi
  if [ "${#EXPORT_WORKDIRS[@]}" -gt 0 ]; then rm -rf "${EXPORT_WORKDIRS[@]}" 2>/dev/null || true; fi
}

# private_workdir: a 0700 directory for DECRYPTED material (object paths carry studio and
# client identifiers). It is made on a per-user tmpfs (XDG_RUNTIME_DIR, else /dev/shm), never
# under the default TMPDIR or /tmp, is removed by export_cleanup_secrets on any exit, and the
# tool refuses when no such place exists (Codex P2 on 29c80788). Sets WORKDIR.
private_workdir() {
  local base="${XDG_RUNTIME_DIR:-}"
  { [ -n "$base" ] && [ -d "$base" ] && [ -w "$base" ]; } || base=/dev/shm
  { [ -d "$base" ] && [ -w "$base" ]; } || export_fail "no private tmpfs for decrypted working files (XDG_RUNTIME_DIR or /dev/shm); refusing rather than using the default temp directory"
  WORKDIR="$(umask 077; mktemp -d "$base/export-work.XXXXXX")" || export_fail "could not make the private working directory"
  chmod 700 "$WORKDIR"
  EXPORT_WORKDIRS+=("$WORKDIR")
}

# The EXIT trap of the two export tools: close the database session, remove the
# secret files, and on ANY failure before the receipt delete the partial output
# (Privacy PEER-1155 L3): a half-written export must never be mistaken for one.
# Set EXPORT_OUT (and EXPORT_OUT_CREATED=1 when the tool made the directory).
export_on_exit() {
  local rc=$?
  snap_close
  export_cleanup_secrets
  [ -z "${TMP:-}" ] || rm -rf "$TMP"
  if [ "$rc" -ne 0 ] && [ -n "${EXPORT_OUT:-}" ] && [ -d "$EXPORT_OUT" ] && [ ! -f "$EXPORT_OUT/receipt.txt" ]; then
    export_log "removing the partial output"
    if [ "${EXPORT_OUT_CREATED:-}" = 1 ]; then rm -rf "$EXPORT_OUT"; else find "$EXPORT_OUT" -mindepth 1 -delete 2>/dev/null || true; fi
  fi
}

# The commands behind the two connections. PRODUCTION: pg_dump/psql with the
# URL the operator typed, WITHOUT its password. REHEARSAL (CI only) may override
# both, but only with the one allow-listed docker-exec form (rehearsal_override_ok).
export_configure_commands() {
  export_guard_rehearsal
  export_guard_libpq_env
  # With BOTH commands overridden (the CI rehearsal's docker-exec form) no URL reaches libpq.
  if [ -n "${EXPORT_PG_DUMP:-}" ] && [ -n "${EXPORT_PSQL:-}" ]; then DB_PASS="" DB_SSLMODE=""; else split_db_url; fi
  if [ -n "${EXPORT_PG_DUMP:-}" ]; then
    read -r -a PGDUMP_CMD <<<"$EXPORT_PG_DUMP"
    rehearsal_override_ok pg_dump "${PGDUMP_CMD[@]}" || export_fail "EXPORT_PG_DUMP is not the allow-listed rehearsal form (docker exec -i supabase_db_<rehearsal ref> pg_dump -U postgres -d postgres); refusing"
  else
    PGDUMP_CMD=(pg_dump "$DB_URL_NOPASS")
  fi
  if [ -n "${EXPORT_PSQL:-}" ]; then
    read -r -a PSQL_CMD <<<"$EXPORT_PSQL"
    rehearsal_override_ok psql "${PSQL_CMD[@]}" || export_fail "EXPORT_PSQL is not the allow-listed rehearsal form (docker exec -i supabase_db_<rehearsal ref> psql -U postgres -d postgres); refusing"
  else
    PSQL_CMD=(psql "$DB_URL_NOPASS")
  fi
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
  if is_rehearsal; then
    [ -n "${!name:-}" ] || export_fail "rehearsal needs $name in the environment"
    return 0
  fi
  [ -z "${!name:-}" ] || export_fail "$name is set in the environment; secrets are typed at a prompt (unset it)"
  read_secret "$name" "$2"
}

# read_object_manifest DIR IDENTITY: decrypt manifest.age with its exit status
# CHECKED (a <(...) process substitution would swallow a failed decryption and
# leave an empty list), then validate it BEFORE anything is uploaded or called
# good: the declared count line is present, equals the number of lines, is at
# least 1 (an export of zero objects is not an object export), and every line is
# well formed. Sets MANIFEST (array) and MANIFEST_DECLARED. On any problem it
# prints the reason on stdout and returns 1 (the caller decides how to stop).
read_object_manifest() {
  local dir="$1" id="$2" raw
  MANIFEST=(); MANIFEST_DECLARED=""; MANIFEST_REASON=""
  raw="$(age -d -i "$id" "$dir/manifest.age" 2>/dev/null)" || { MANIFEST_REASON="the identity does not decrypt manifest.age"; return 1; }
  local first
  first="$(printf '%s\n' "$raw" | head -n 1)"
  case "$first" in
    "manifest-version=$MANIFEST_VERSION") ;;
    manifest-version=*) MANIFEST_REASON="unsupported manifest version '${first#manifest-version=}' (this tool reads version $MANIFEST_VERSION)"; return 1;;
    *) MANIFEST_REASON="old-format manifest: no manifest-version line (version 1 recorded no content types); re-export with the current object-export.sh"; return 1;;
  esac
  MANIFEST_DECLARED="$(printf '%s\n' "$raw" | sed -n 's/^count=\([0-9]*\) .*/\1/p')"
  [ -n "$MANIFEST_DECLARED" ] || { MANIFEST_REASON="the manifest declares no object count"; return 1; }
  [ "$MANIFEST_DECLARED" -ge 1 ] || { MANIFEST_REASON="the manifest declares $MANIFEST_DECLARED objects: not a valid object export"; return 1; }
  local line
  while IFS= read -r line; do
    case "$line" in count=*|manifest-version=*|'') ;; *) MANIFEST+=("$line");; esac
  done <<<"$raw"
  [ "${#MANIFEST[@]}" = "$MANIFEST_DECLARED" ] || { MANIFEST_REASON="the manifest lists ${#MANIFEST[@]} object(s) but declares $MANIFEST_DECLARED"; return 1; }
  local why
  why="$(object_manifest_check <(printf '%s\n' "${MANIFEST[@]}") "$MANIFEST_DECLARED")" || { MANIFEST_REASON="$why"; return 1; }
}

# manifest_field LINE N: field N (1 index, 2 path, 3 size, 4 sha256, 5 content type)
# of a manifest line. Pure parameter expansion; no subprocess sees the line.
manifest_field() {
  local rest="$1" n="$2" i
  for ((i = 1; i < n; i++)); do rest="${rest#*"$US"}"; done
  if [ "$n" -lt 5 ]; then printf '%s' "${rest%%"$US"*}"; else printf '%s' "$rest"; fi
}

# pick_sample N K LARGEST SEED: K distinct indices of 0..N-1, chosen WITHOUT
# replacement across the WHOLE range (a seeded partial Fisher-Yates in awk), then
# LARGEST once if it is not already among them. K is capped at N, so the output has
# at most K+1 lines and the work is bounded by N. One index per line.
# It deliberately does not use $RANDOM: that is 0..32767, so `% N` never reaches an
# index above 32767 and a loop that waits for K distinct values never ends when K
# exceeds that (Codex P2 4371357978).
pick_sample() {
  awk -v n="$1" -v k="$2" -v largest="$3" -v seed="$4" 'BEGIN {
    if (k > n) k = n
    srand(seed)
    for (i = 0; i < n; i++) a[i] = i
    for (i = 0; i < k; i++) {
      j = i + int(rand() * (n - i))
      t = a[i]; a[i] = a[j]; a[j] = t
      print a[i]; seen[a[i]] = 1
    }
    if (largest >= 0 && largest < n && !(largest in seen)) print largest
  }'
}
