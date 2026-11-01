#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Encrypted logical export of the database (RECOVERY-LAYERS-PLAN.md, layer 2).
#
# Produces, in --out DIR, one `age`-encrypted file per part, and NEVER a
# plaintext file:
#   public-data.sql.age   pg_dump --data-only --schema=public
#   auth-data.sql.age     every auth table except auth.schema_migrations
#   storage-meta.sql.age  storage.buckets and storage.objects ROWS (not bytes)
#   schema-only.sql.age   schema only, for drift evidence
#   manifest.age          the V2 fingerprint (per table: count and md5)
#   hashes.sha256         V1: sha256 of every ciphertext
#   markers/              V3 counts and table NAMES; no row content
#   receipt.txt           V7 input: hashes, counts, snapshot, durations
#
# Three dump parts and the fingerprint are taken in ONE snapshot, so the counts
# describe the same instant as the rows. Two dumps for public and auth/storage
# on purpose: with pg_dump a --table option overrides --schema.
#
# SECRETS. The connection string is typed at a prompt (never an argument, file
# or environment variable of an agent). Only the PUBLIC age recipient is given.
# No plaintext, key or connection string is written anywhere.
#
# Usage:
#   logical-export.sh --out DIR --recipient AGE_PUBLIC_KEY --expect-ref PROJECT_REF
#
# REHEARSAL (EXPORT_REHEARSAL=1 AND GITHUB_ACTIONS=true, CI only, synthetic data):
# DB_URL may come from the environment, a loopback URL satisfies --expect-ref for
# the one declared rehearsal ref, and EXPORT_PG_DUMP / EXPORT_PSQL may be the
# allow-listed `docker exec` form only. Outside a CI job every one is refused.
# See export-rehearsal.sh.
#
# NO SECRET IN ARGV. The password is split off the connection string and given to
# pg_dump/psql only as PGPASSWORD in that child's environment.
# ---------------------------------------------------------------------------
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/ops/export-lib.sh
. "$HERE/export-lib.sh"

OUT="" RECIPIENT="" REF=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2;;
    --recipient) RECIPIENT="$2"; shift 2;;
    --expect-ref) REF="$2"; shift 2;;
    *) export_fail "unknown argument: $1";;
  esac
done
[ -n "$OUT" ] && [ -n "$RECIPIENT" ] && [ -n "$REF" ] || export_fail "usage: --out DIR --recipient AGE_PUBLIC_KEY --expect-ref PROJECT_REF"
case "$RECIPIENT" in age1*) ;; *) export_fail "the recipient must be an age PUBLIC key (age1...)";; esac
command -v age >/dev/null || export_fail "age is not installed"
export_guard_rehearsal   # rehearsal switches exist only in the CI rehearsal
trap export_on_exit EXIT   # closes the session, removes secret files, deletes a partial output on any failure
export_signal_traps   # an interrupt exits non-zero, so the trap above removes the partial output

secret_input DB_URL "Database connection string (input hidden): "
require_conn_url "$DB_URL" "the connection string"
url_matches_ref "$DB_URL" "$REF" || export_fail "the connection string's host does not name project ref '$REF'; refusing"
export_configure_commands

if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then export_fail "$OUT exists and is not empty"; fi
[ -e "$OUT" ] || EXPORT_OUT_CREATED=1
EXPORT_OUT="$OUT"
mkdir -p "$OUT/markers"

T0=$(date +%s)
export_log "target host: $(host_of "$DB_URL") (ref check passed)"
snap_open
export_log "snapshot taken"

# chk: write ONE integer marker, atomically; discards every row.
chk() { # chk REGEX MARKER
  local n; n="$(grep -c "$1" || true)"
  printf '%s\n' "$n" >"$OUT/markers/$2.count.tmp" && mv "$OUT/markers/$2.count.tmp" "$OUT/markers/$2.count"
}
# names: write the TABLE NAMES (never a row) that a COPY / CREATE TABLE stream
# mentions: field FIELD of each line matching REGEX, sorted and unique.
names() { # names REGEX FIELD MARKER
  grep -E "$1" | awk -v f="$2" '{print $f}' | sed -E 's/\($//' | sort -u >"$OUT/markers/$3.tables.tmp" \
    && mv "$OUT/markers/$3.tables.tmp" "$OUT/markers/$3.tables"
}

dump_part() { # dump_part FILE COUNT_REGEX COUNT_MARKER NAMES_REGEX NAMES_FIELD NAMES_MARKER pg_dump-args...
  local file="$1" cre="$2" cm="$3" nre="$4" nf="$5" nm="$6"; shift 6
  if [ -n "$cm" ]; then
    with_pgpass "${PGDUMP_CMD[@]}" --snapshot="$SNAPSHOT_ID" "$@" \
      | tee >(chk "$cre" "$cm") >(names "$nre" "$nf" "$nm") \
      | age -r "$RECIPIENT" -o "$OUT/$file"
  else
    with_pgpass "${PGDUMP_CMD[@]}" --snapshot="$SNAPSHOT_ID" "$@" \
      | tee >(names "$nre" "$nf" "$nm") \
      | age -r "$RECIPIENT" -o "$OUT/$file"
  fi
}

export_log "part 1: public data"
dump_part public-data.sql.age '^COPY public\.clients ' public-clients '^COPY public\.' 2 public --data-only --schema=public
export_log "part 2: every auth table except its migration history"
dump_part auth-data.sql.age '^COPY auth\.identities ' auth-identities '^COPY auth\.' 2 auth --data-only --schema=auth --exclude-table=auth.schema_migrations
export_log "part 3: storage metadata rows (a separate call: --table overrides --schema)"
dump_part storage-meta.sql.age '^COPY storage\.objects ' storage-objects '^COPY storage\.' 2 storage-meta --data-only --table=storage.buckets --table=storage.objects
export_log "part 4: schema only (drift evidence)"
dump_part schema-only.sql.age '' '' '^CREATE TABLE ' 3 schema --schema-only --schema=public --schema=auth --schema=storage

for m in public-clients auth-identities storage-objects; do wait_marker "$OUT/markers/$m.count" || export_fail "marker $m never completed"; done
for m in public auth storage-meta schema; do wait_marker "$OUT/markers/$m.tables" || export_fail "table list $m never completed"; done

export_log "V2: fingerprint in the same snapshot"
snap_query "$MANIFEST_SQL"
[ "${#SNAP_OUT[@]}" -ge 1 ] || export_fail "the fingerprint query returned no table"
printf '%s\n' "${SNAP_OUT[@]}" | age -r "$RECIPIENT" -o "$OUT/manifest.age"
snap_close

# --- V3: completeness, on the streamed plaintext's markers -----------------------
fail=0
gate_markers "$OUT" || fail=1
gate_sizes "$OUT" || fail=1
# The table list of each data part equals the schema-only dump's, for the two
# schemas that are exported whole (auth minus its migration history).
grep -E '^public\.' "$OUT/markers/schema.tables" >"$OUT/markers/schema-public.tables" || true
grep -E '^auth\.' "$OUT/markers/schema.tables" | grep -v '^auth\.schema_migrations$' >"$OUT/markers/schema-auth.tables" || true
tables_equal "$OUT/markers/public.tables" "$OUT/markers/schema-public.tables" || { echo "public table list differs from the schema-only dump"; fail=1; }
tables_equal "$OUT/markers/auth.tables" "$OUT/markers/schema-auth.tables" || { echo "auth table list differs from the schema-only dump"; fail=1; }
if [ "$fail" != 0 ]; then
  export_log "COMPLETENESS GATE FAILED: discarding the export"
  find "$OUT" -type f -delete
  export_fail "export discarded (V3)"
fi

hash_record "$OUT"   # V1
{
  echo "export=logical"
  echo "created_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "snapshot=$SNAPSHOT_ID"
  echo "public_clients_marker=$(marker_count "$OUT/markers/public-clients.count")"
  echo "auth_identities_marker=$(marker_count "$OUT/markers/auth-identities.count")"
  echo "storage_objects_marker=$(marker_count "$OUT/markers/storage-objects.count")"
  echo "public_tables=$(wc -l <"$OUT/markers/public.tables" | tr -d ' ')"
  echo "auth_tables=$(wc -l <"$OUT/markers/auth.tables" | tr -d ' ')"
  echo "duration_seconds=$(( $(date +%s) - T0 ))"
  echo "--- sha256 of each ciphertext (V1)"
  cat "$OUT/hashes.sha256"
} >"$OUT/receipt.txt"
export_log "PASS: $(wc -l <"$OUT/hashes.sha256" | tr -d ' ') encrypted parts, hashes recorded, receipt.txt written"
