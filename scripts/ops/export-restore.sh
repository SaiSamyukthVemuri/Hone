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
# at prompts. REHEARSAL (EXPORT_REHEARSAL=1 AND GITHUB_ACTIONS=true, CI only) takes
# DB_URL / SERVICE_KEY from the environment, accepts a loopback target for the one
# declared rehearsal ref, and may use EXPORT_PSQL only in the allow-listed
# `docker exec` form; outside a CI job every one of these is refused.
# No secret is placed on a command line (password via PGPASSWORD in the child's
# environment, key via a private 0600 header file).
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
export_guard_rehearsal   # rehearsal switches exist only in the CI rehearsal
trap 'rm -f "${AFTER:-}" "${BEFORE:-}"; export_cleanup_secrets' EXIT

# The production ref the operator typed must be the project this checkout is
# linked to, when it is linked (Privacy PEER-1155 L1): a typo here is the only
# thing standing between a restore and the wrong project.
LINK_FILE="${EXPORT_PROJECT_REF_FILE:-supabase/.temp/project-ref}"
if [ -f "$LINK_FILE" ]; then
  LINKED="$(tr -d '[:space:]' <"$LINK_FILE")"
  [ "$LINKED" = "$PREF" ] || export_fail "--production-ref '$PREF' does not match $LINK_FILE ('$LINKED'); refusing"
fi

secret_input DB_URL "TARGET database connection string (input hidden): "
url_matches_ref "$DB_URL" "$TREF" || export_fail "the target's host does not name '$TREF'; refusing"
case "$(host_of "$DB_URL")" in *"$PREF"*) export_fail "the target's host names the PRODUCTION ref; refusing";; esac
export_configure_commands
dec() { age -d -i "$ID" "$1"; }
sql() { with_pgpass "${PSQL_CMD[@]}" -qAtX -v ON_ERROR_STOP=1 "$@"; }

case "$KIND" in
  logical)
    hash_verify "$DIR" || export_fail "V1: a ciphertext does not match hashes.sha256; not restoring"
    # Prove the key opens EVERY part before the database is touched (a wrong
    # identity must never reach the TRUNCATE below).
    for part in public-data auth-data storage-meta manifest; do
      dec "$DIR/$part.sql.age" >/dev/null 2>&1 || dec "$DIR/$part.age" >/dev/null 2>&1 || export_fail "the identity does not decrypt $part; not touching the database"
    done
    TRUNC="$(sql <<'SQL'
select 'truncate ' || string_agg(format('%I.%I', schemaname, relname), ', ') || ' cascade;'
from pg_stat_user_tables
where schemaname = 'public'
   or (schemaname = 'storage' and relname in ('buckets', 'objects'))
   or (schemaname = 'auth' and relname <> 'schema_migrations');
SQL
)"
    export_log "loading rows in one transaction"
    # COMMIT is sent only if every part decrypted to the end; any failure sends
    # ROLLBACK, so a truncation can never be committed without its rows (Codex P1).
    {
      echo "begin;"
      echo "set session_replication_role = replica;"
      echo "$TRUNC"
      if dec "$DIR/public-data.sql.age" && dec "$DIR/auth-data.sql.age" && dec "$DIR/storage-meta.sql.age"; then
        echo "commit;"
      else
        echo "rollback;"
        exit 1   # pipefail turns this into a failed load even though ROLLBACK itself succeeds
      fi
    } | sql >/dev/null || export_fail "the row load failed or was rolled back (one transaction: nothing was loaded)"
    export_log "V2: recompute the fingerprint and compare"
    AFTER="$(mktemp)"; BEFORE="$(mktemp)"
    printf '%s\n' "$MANIFEST_SQL" | sql >"$AFTER"
    dec "$DIR/manifest.age" >"$BEFORE"
    compare_manifests "$BEFORE" "$AFTER" || export_fail "V2: the restored fingerprint differs from the export's"
    export_log "RESTORE PASS (logical): fingerprints identical for $(wc -l <"$AFTER" | tr -d ' ') table(s); storage.objects by count"
    ;;
  objects)
    [ -n "$STORAGE_URL" ] || export_fail "--storage-url is required for objects"
    url_matches_ref "$STORAGE_URL" "$TREF" || export_fail "the storage URL does not name '$TREF'; refusing"
    secret_input SERVICE_KEY "TARGET service-role key (input hidden): "
    make_auth_header_file   # the key reaches curl through a private 0600 file, never argv
    hash_verify "$DIR" || export_fail "V1: a ciphertext does not match hashes.sha256; not restoring"
    MANIFEST=()
    while IFS= read -r line; do MANIFEST+=("$line"); done < <(dec "$DIR/manifest.age" | grep -v '^count=')
    bad=0
    for line in "${MANIFEST[@]}"; do
      idx="${line%%"$US"*}"; rest="${line#*"$US"}"; path="${rest%%"$US"*}"; want="${line##*"$US"}"
      url="$STORAGE_URL/storage/v1/object/$BUCKET/$(urlencode_path "$path")"
      dec "$DIR/objects/$idx.age" | curl -fsS -X PUT "$url" -H @"$AUTH_HDR_FILE" \
        -H "x-upsert: true" -H "Content-Type: application/octet-stream" --data-binary @- >/dev/null || { echo "upload of object $idx failed"; bad=1; continue; }
      have="$(curl -fsS "$url" -H @"$AUTH_HDR_FILE" | sha256sum | cut -d' ' -f1)" || { echo "read-back of object $idx failed"; bad=1; continue; }
      [ "$have" = "$want" ] || { echo "object $idx re-hashes differently after the restore"; bad=1; }
    done
    [ "$bad" = 0 ] || export_fail "object restore failed"
    export_log "RESTORE PASS (objects): ${#MANIFEST[@]} object(s) re-uploaded and re-hashed"
    ;;
  *) export_fail "kind must be logical or objects";;
esac
