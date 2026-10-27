#!/bin/bash
# hone-release action: heartbeat (E4 option (b), "recorded heartbeat write"). It writes ONE transactional WAL message (pg_logical_emit_message: no table,
# no row, no schema object) to the approved target so the provider's latest recovery point can advance past a stamp the apply can check. It runs only
# under an unexpired APPROVED-PACKAGE with quiet_db_mode=heartbeat, once per approval, and records HEARTBEAT in the release state. It is a (tiny)
# production WRITE and the third consumer of the database password (apply, heartbeat). Connection form and TLS are the apply's: the direct host,
# verify-full against the pinned CA, server-side timeouts.
set -u
umask 077
STATE=/var/lib/hone-release/state
LIBEXEC=/usr/local/libexec/hone-release
APPROVAL=/etc/hone-release/APPROVED-PACKAGE
BIN=$LIBEXEC/bin/supabase-go
GO_SHA=174a90e23b8dfe9ab4e2d2c2e91d4b6b2520fe5be968721555727f16c1bab43c
CA=$LIBEXEC/ca/supabase-prod-ca-2021.crt
CA_SHA=700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7
die() { echo "STOP: $*" >&2; exit 1; }
[ "${HONE_RELEASE_ACTION:-}" = heartbeat ] || die "not started by the launcher for the heartbeat action"
{ IFS= read -r PW <&3; } 2>/dev/null || die "no database password on fd 3"
exec 3<&-
[ -n "$PW" ] || die "empty database password"
[ -f "$APPROVAL" ] && [ ! -L "$APPROVAL" ] && [ "$(stat -c %u "$APPROVAL")" = 0 ] && [ $(( 8#$(stat -c %a "$APPROVAL") & 8#022 )) = 0 ] || die "no root-owned APPROVED-PACKAGE"
g() { sed -n "s/^$1=//p" "$APPROVAL" | head -1; }
[ "$(g quiet_db_mode)" = heartbeat ] || die "the approval does not select quiet_db_mode=heartbeat"
[ "$(g connection_mode)" = direct ] || die "the heartbeat is written only on the direct connection form"
now=$(date -u +%s); exp=$(date -u -d "$(g expires_at)" +%s 2>/dev/null) || die "cannot read expires_at"
[ "$exp" -gt "$now" ] || die "the approval has expired"
ID=$(g approval_id); printf '%s' "$ID" | grep -Eq '^[A-Za-z0-9._-]{4,64}$' || die "approval_id is malformed"
[ ! -e "$STATE/heartbeat-done-$ID" ] || die "the heartbeat was already written for approval $ID (once per approval)"
URL=$(g target_url); HOST=$(g db_host); REF=$(g project_ref)
printf '%s' "$HOST" | grep -Eq "^db\.$REF\.supabase\.co:5432\$" || die "the approved host is not the exact direct host"
[ -f "$BIN" ] && [ ! -L "$BIN" ] && [ "$(sha256sum "$BIN" | cut -d' ' -f1)" = "$GO_SHA" ] || die "supabase-go missing or sha256 mismatch"
[ -f "$CA" ] && [ ! -L "$CA" ] && [ "$(sha256sum "$CA" | cut -d' ' -f1)" = "$CA_SHA" ] || die "the pinned CA is missing or its sha256 differs"
WORK=$(mktemp -d /var/lib/hone-release/work/hb.XXXXXX) || die "no work dir"
mkdir -p "$WORK/supabase/.temp" && printf '%s\n' v2.102.0 > "$WORK/supabase/.temp/cli-latest"
t=$(date -u +%Y-%m-%dT%H:%M:%SZ); : > "$STATE/heartbeat-done-$ID"
rc=0
( cd "$WORK" && PGPASSWORD="$PW" PGSSLMODE=verify-full PGSSLROOTCERT="$CA" SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 timeout 60 "$BIN" db query --db-url "$URL" "select pg_logical_emit_message(true, 'hone-release-heartbeat', '$ID')::text as heartbeat_lsn" ) </dev/null > "$WORK/out.txt" 2> "$WORK/err.txt" || rc=$?
PW=""; unset PW
if [ "$rc" != 0 ]; then tail -n 4 "$WORK/err.txt" | LC_ALL=C sed -E 's#postgres(ql)?://[^ ]*#<url>#g; s#[A-Za-z0-9.-]*\.supabase\.(com|co)[:0-9]*#<host>#g' >&2; die "the heartbeat write failed (exit $rc); no HEARTBEAT was recorded and it is not retried by this action"; fi
printf 'HEARTBEAT at=%s approval=%s\n' "$t" "$ID" > "$STATE/HEARTBEAT.tmp" && mv -f "$STATE/HEARTBEAT.tmp" "$STATE/HEARTBEAT"
echo "HEARTBEAT recorded at $t. The apply will STOP unless the provider's latest recovery point reaches this time (read-backups again after it advances)."
