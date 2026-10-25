#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Restore an encrypted export INTO A DISPOSABLE PROJECT (RECOVERY-LAYERS-PLAN.md
# sections 4 V4 and 7). Never over production: --production-ref is REQUIRED and
# the target's host must not contain it; --target-ref must be named by the target.
#
#   export-restore.sh logical DIR --identity KEY --target-ref R --production-ref P
#       truncates the migration-seeded rows, loads public, auth and storage-meta
#       with session_replication_role = replica in ONE transaction, then
#       recomputes the V2 fingerprint and compares it to the manifest inside the
#       export (storage.objects by count). Run AFTER the target was built from
#       the repository migrations at the export's migration head.
#   export-restore.sh objects DIR --identity KEY --target-ref R --production-ref P --storage-url U [--bucket B]
#       re-uploads every object to the same path, then reads each back and
#       compares its sha256 with the manifest.
#
# Secrets (the target connection string, the target service-role key) are typed
# at prompts. REHEARSAL (EXPORT_REHEARSAL=1) takes DB_URL / SERVICE_KEY from the
# environment, accepts a loopback target, and may use EXPORT_PSQL.
# ---------------------------------------------------------------------------
set -euo pipefail
umask 077
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/ops/export-lib.sh
. "$HERE/export-lib.sh"

KIND="${1:-}"; DIR="${2:-}"; shift 2 || true
ID="" TREF="" PREF="" STORAGE_URL="" BUCKET="treatment-images"
while [ $# -gt 0 ]; do
  case "$1" in
    --identity) ID="$2"; shift 2;;
    --target-ref) TREF="$2"; shift 2;;
    --production-ref) PREF="$2"; shift 2;;
    --storage-url) STORAGE_URL="${2%/}"; shift 2;;
    --bucket) BUCKET="$2"; shift 2;;
    *) export_fail "unknown argument: $1";;
  esac
done
[ -n "$KIND" ] && [ -d "$DIR" ] && [ -f "$ID" ] && [ -n "$TREF" ] && [ -n "$PREF" ] || export_fail "usage: (logical|objects) DIR --identity KEY --target-ref R --production-ref P"
[ "$TREF" != "$PREF" ] || export_fail "the target ref equals the production ref; refusing"
command -v age >/dev/null || export_fail "age is not installed"

secret_input DB_URL "TARGET database connection string (input hidden): "
url_matches_ref "$DB_URL" "$TREF" || export_fail "the target's host does not name '$TREF'; refusing"
case "$(host_of "$DB_URL")" in *"$PREF"*) export_fail "the target's host names the PRODUCTION ref; refusing";; esac
export_configure_commands
dec() { age -d -i "$ID" "$1"; }
sql() { "${PSQL_CMD[@]}" -qAtX -v ON_ERROR_STOP=1 "$@"; }

case "$KIND" in
  logical)
    hash_verify "$DIR" || export_fail "V1: a ciphertext does not match hashes.sha256; not restoring"
    TRUNC="$(sql <<'SQL'
select 'truncate ' || string_agg(format('%I.%I', schemaname, relname), ', ') || ' cascade;'
from pg_stat_user_tables
where schemaname = 'public'
   or (schemaname = 'storage' and relname in ('buckets', 'objects'))
   or (schemaname = 'auth' and relname <> 'schema_migrations');
SQL
)"
    export_log "loading rows in one transaction"
    {
      echo "begin;"
      echo "set session_replication_role = replica;"
      echo "$TRUNC"
      dec "$DIR/public-data.sql.age"
      dec "$DIR/auth-data.sql.age"
      dec "$DIR/storage-meta.sql.age"
      echo "commit;"
    } | sql >/dev/null || export_fail "the row load failed (one transaction: nothing was loaded)"
    export_log "V2: recompute the fingerprint and compare"
    AFTER="$(mktemp)"; BEFORE="$(mktemp)"; trap 'rm -f "$AFTER" "$BEFORE"' EXIT
    printf '%s\n' "$MANIFEST_SQL" | sql >"$AFTER"
    dec "$DIR/manifest.age" >"$BEFORE"
    compare_manifests "$BEFORE" "$AFTER" || export_fail "V2: the restored fingerprint differs from the export's"
    export_log "RESTORE PASS (logical): fingerprints identical for $(wc -l <"$AFTER" | tr -d ' ') table(s); storage.objects by count"
    ;;
  objects)
    [ -n "$STORAGE_URL" ] || export_fail "--storage-url is required for objects"
    url_matches_ref "$STORAGE_URL" "$TREF" || export_fail "the storage URL does not name '$TREF'; refusing"
    secret_input SERVICE_KEY "TARGET service-role key (input hidden): "
    hash_verify "$DIR" || export_fail "V1: a ciphertext does not match hashes.sha256; not restoring"
    MANIFEST=()
    while IFS= read -r line; do MANIFEST+=("$line"); done < <(dec "$DIR/manifest.age" | grep -v '^count=')
    bad=0
    for line in "${MANIFEST[@]}"; do
      idx="${line%%"$US"*}"; rest="${line#*"$US"}"; path="${rest%%"$US"*}"; want="${line##*"$US"}"
      url="$STORAGE_URL/storage/v1/object/$BUCKET/$(urlencode_path "$path")"
      dec "$DIR/objects/$idx.age" | curl -fsS -X PUT "$url" -H "Authorization: Bearer $SERVICE_KEY" -H "apikey: $SERVICE_KEY" \
        -H "x-upsert: true" -H "Content-Type: application/octet-stream" --data-binary @- >/dev/null || { echo "upload of object $idx failed"; bad=1; continue; }
      have="$(curl -fsS "$url" -H "Authorization: Bearer $SERVICE_KEY" -H "apikey: $SERVICE_KEY" | sha256sum | cut -d' ' -f1)" || { echo "read-back of object $idx failed"; bad=1; continue; }
      [ "$have" = "$want" ] || { echo "object $idx re-hashes differently after the restore"; bad=1; }
    done
    [ "$bad" = 0 ] || export_fail "object restore failed"
    export_log "RESTORE PASS (objects): ${#MANIFEST[@]} object(s) re-uploaded and re-hashed"
    ;;
  *) export_fail "kind must be logical or objects";;
esac
