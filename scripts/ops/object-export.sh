#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Encrypted export of Storage OBJECTS (RECOVERY-LAYERS-PLAN.md section 5, T-1).
# Layer 1 (Supabase's daily backup) does not carry object bytes; this does.
#
# In --out DIR, and never a plaintext file:
#   objects/NNNNNN.age   one encrypted object each (named by INDEX, not by path:
#                        a path carries a studio and client id)
#   manifest.age         manifest-version=2, then index, path, size, sha256 and CONTENT TYPE
#                        per object, plus the totals (held in memory
#                        until encrypted; no plaintext manifest file ever exists)
#   coverage.txt         COUNTS only (rows without an object, objects without a row)
#   hashes.sha256        V1: sha256 of every ciphertext
#   receipt.txt          V7 input
#
# The object list is read from storage.objects in ONE snapshot, held in memory
# only. Each object is downloaded over the Storage API, hashed while it streams
# and encrypted straight into `age`. Fails closed when
#   * the downloaded count differs from the listed count, or a downloaded size
#     differs from the listed size;
#   * a re-download of a random sample plus the largest object hashes differently;
#   * a URL names anything but the project ref the operator typed.
#
# SECRETS. The connection string and the service-role key are typed at prompts;
# neither is an argument, a file or stored.
#
# Usage:
#   object-export.sh --out DIR --recipient AGE_PUBLIC_KEY --expect-ref PROJECT_REF \
#                    --storage-url https://<ref>.supabase.co [--bucket treatment-images] [--sample 5]
#
# REHEARSAL (EXPORT_REHEARSAL=1 AND GITHUB_ACTIONS=true, CI only, synthetic):
# DB_URL and SERVICE_KEY may come from the environment; a loopback URL satisfies
# --expect-ref for the one declared rehearsal ref; EXPORT_TEST_HOOK_AFTER_LIST (a
# command) runs after the list is read, so the rehearsal can delete an object
# between listing and download (negative control). Outside a CI job every one of
# these is refused.
#
# NO SECRET IN ARGV. The password is split off the connection string and given to
# psql only as PGPASSWORD in that child's environment; the service-role key reaches
# curl through a private 0600 header file (-H @file).
# ---------------------------------------------------------------------------
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/ops/export-lib.sh
. "$HERE/export-lib.sh"

OUT="" RECIPIENT="" REF="" STORAGE_URL="" BUCKET="treatment-images" SAMPLE=5
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2;;
    --recipient) RECIPIENT="$2"; shift 2;;
    --expect-ref) REF="$2"; shift 2;;
    --storage-url) STORAGE_URL="${2%/}"; shift 2;;
    --bucket) BUCKET="$2"; shift 2;;
    --sample) SAMPLE="$2"; shift 2;;
    *) export_fail "unknown argument: $1";;
  esac
done
[ -n "$OUT" ] && [ -n "$RECIPIENT" ] && [ -n "$REF" ] && [ -n "$STORAGE_URL" ] || export_fail "usage: --out DIR --recipient KEY --expect-ref REF --storage-url URL"
case "$RECIPIENT" in age1*) ;; *) export_fail "the recipient must be an age PUBLIC key (age1...)";; esac
case "$BUCKET" in *[!a-z0-9_-]*|'') export_fail "bucket name must be [a-z0-9_-]+";; esac
case "$SAMPLE" in ''|*[!0-9]*) export_fail "--sample must be an integer";; esac
command -v age >/dev/null || export_fail "age is not installed"
command -v curl >/dev/null || export_fail "curl is not installed"
export_guard_rehearsal   # rehearsal switches exist only in the CI rehearsal
trap export_on_exit EXIT   # closes the session, removes secret files and TMP, deletes a partial output on any failure

secret_input DB_URL "Database connection string (input hidden): "
secret_input SERVICE_KEY "Service-role key (input hidden): "
url_matches_ref "$DB_URL" "$REF" || export_fail "the connection string's host does not name project ref '$REF'; refusing"
url_matches_ref "$STORAGE_URL" "$REF" || export_fail "the storage URL's host does not name project ref '$REF'; refusing"
export_configure_commands
make_auth_header_file   # the key reaches curl through a private 0600 file, never argv

if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then export_fail "$OUT exists and is not empty"; fi
[ -e "$OUT" ] || EXPORT_OUT_CREATED=1
EXPORT_OUT="$OUT"
mkdir -p "$OUT/objects" "$OUT/tmp"
TMP="$OUT/tmp"

T0=$(date +%s)
export_log "target hosts: $(host_of "$DB_URL") and $(host_of "$STORAGE_URL") (ref check passed)"
snap_open

# --- 1. the list, from storage.objects, in memory only ---------------------------
snap_query "select name || E'\\x1f' || coalesce((metadata->>'size'), '0') || E'\\x1f' || coalesce(metadata->>'mimetype', '') from storage.objects where bucket_id = '$BUCKET' order by name;"
LIST=("${SNAP_OUT[@]}")
N="${#LIST[@]}"
export_log "listed $N object(s) in bucket $BUCKET"
[ "$N" -ge 1 ] || export_fail "the bucket lists no object: nothing to export (an empty export is not a backup)"

# Coverage (counts only): rows with no object, objects with no row, both in the snapshot.
snap_query "select 'rows_total=' || (select count(*) from public.treatment_images where deleted_at is null and storage_bucket = '$BUCKET') || ' rows_without_object=' || (select count(*) from public.treatment_images ti where ti.deleted_at is null and ti.storage_bucket = '$BUCKET' and not exists (select 1 from storage.objects o where o.bucket_id = '$BUCKET' and o.name = ti.storage_path)) || ' objects_total=' || (select count(*) from storage.objects where bucket_id = '$BUCKET') || ' objects_without_row=' || (select count(*) from storage.objects o where o.bucket_id = '$BUCKET' and o.name not like '%.thumb.webp' and not exists (select 1 from public.treatment_images ti where ti.storage_bucket = '$BUCKET' and ti.storage_path = o.name));"
COV="${SNAP_OUT[0]:-}"
printf '%s\n' "$COV" >"$OUT/coverage.txt"
export_log "coverage: $COV"
snap_close

# Rehearsal only: change the world between the listing and the download.
if is_rehearsal && [ -n "${EXPORT_TEST_HOOK_AFTER_LIST:-}" ]; then
  export_log "rehearsal hook after the list"
  bash -c "$EXPORT_TEST_HOOK_AFTER_LIST"
fi

get() { # get PATH  -> object bytes on stdout; fails on any non-2xx
  curl -fsS "$STORAGE_URL/storage/v1/object/$BUCKET/$(urlencode_path "$1")" -H @"$AUTH_HDR_FILE"
}

# --- 2. download, hash while streaming, encrypt; manifest in memory --------------
MANIFEST=()   # in memory only: it holds PATHS (a studio and client id each), never a plaintext file
TOTAL=0 LARGEST_I=0 LARGEST_SIZE=-1
for i in "${!LIST[@]}"; do
  path="${LIST[$i]%%"$US"*}"; rest="${LIST[$i]#*"$US"}"; size="${rest%%"$US"*}"; mime="${rest#*"$US"}"
  idx="$(printf '%06d' "$i")"
  # A missing content type is a refusal, not a silent default: the restore must put the
  # object back with the type it had (Codex P2 4371272761). The path is not printed.
  [ -n "$mime" ] || export_fail "object $idx has no content type in storage.objects metadata; refusing (no default is invented)"
  [[ "$mime" =~ ^[a-z0-9][a-z0-9\!\#\$\&\^_.+-]*/[a-z0-9][a-z0-9\!\#\$\&\^_.+-]*$ ]] || export_fail "object $idx has an unsupported content type '$mime' (expected lowercase type/subtype); refusing"
  rm -f "$TMP/h.$idx" "$TMP/c.$idx"
  get "$path" \
    | tee >(sha256sum | cut -d' ' -f1 >"$TMP/h.$idx.tmp" && mv "$TMP/h.$idx.tmp" "$TMP/h.$idx") \
          >(wc -c | tr -d ' ' >"$TMP/c.$idx.tmp" && mv "$TMP/c.$idx.tmp" "$TMP/c.$idx") \
    | age -r "$RECIPIENT" -o "$OUT/objects/$idx.age" \
    || export_fail "object $idx could not be downloaded and encrypted"
  wait_marker "$TMP/h.$idx" || export_fail "hash of object $idx never completed"
  wait_marker "$TMP/c.$idx" || export_fail "byte count of object $idx never completed"
  got="$(tr -d '[:space:]' <"$TMP/c.$idx")"
  [ "$got" = "$size" ] || export_fail "object $idx downloaded $got byte(s), the list says $size"
  MANIFEST+=("$idx$US$path$US$size$US$(cat "$TMP/h.$idx")$US$mime")
  TOTAL=$((TOTAL + size))
  if [ "$size" -gt "$LARGEST_SIZE" ]; then LARGEST_SIZE="$size"; LARGEST_I="$i"; fi
done

DONE="$(find "$OUT/objects" -name '*.age' | wc -l | tr -d ' ')"
[ "$DONE" = "$N" ] || export_fail "$DONE object file(s) written, $N listed"
object_manifest_check <(printf '%s\n' "${MANIFEST[@]}") "$N" || export_fail "object manifest check failed"

# --- 3. re-download a random sample plus the largest, compare hashes (PLAN section 5) ----
# SAMPLE distinct indices drawn WITHOUT replacement from the whole 0..N-1 range (capped at N),
# plus the largest object once. Bounded by N; no $RANDOM (Codex P2 4371357978).
SEED="$(od -An -N4 -tu4 /dev/urandom | tr -d '[:space:]')"
picks="$(pick_sample "$N" "$SAMPLE" "$LARGEST_I" "$SEED")" || export_fail "could not choose the verification sample"
mapfile -t PICK <<<"$picks"
[ "${#PICK[@]}" -ge 1 ] && [ "${#PICK[@]}" -le "$N" ] || export_fail "the verification sample has ${#PICK[@]} object(s) out of $N"
for i in "${PICK[@]}"; do
  path="${LIST[$i]%%"$US"*}"; idx="$(printf '%06d' "$i")"
  want="$(manifest_field "${MANIFEST[$i]}" 4)"
  have="$(get "$path" | sha256sum | cut -d' ' -f1)" || export_fail "re-download of object $idx failed"
  [ "$have" = "$want" ] || export_fail "object $idx hashes differently on re-download"
done
export_log "sample re-download: ${#PICK[@]} object(s) (a random sample plus the largest, without replacement) matched"

# --- 4. manifest (encrypted), totals, hashes -------------------------------------------
{ printf 'manifest-version=%s\n' "$MANIFEST_VERSION"; printf '%s\n' "${MANIFEST[@]}"; printf 'count=%s total_bytes=%s\n' "$N" "$TOTAL"; } | age -r "$RECIPIENT" -o "$OUT/manifest.age"
rm -rf "$TMP"
(cd "$OUT" && sha256sum -- manifest.age objects/*.age >hashes.sha256)
{
  echo "export=objects"
  echo "created_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "bucket=$BUCKET"
  echo "objects=$N"
  echo "total_bytes=$TOTAL"
  echo "coverage: $COV"
  echo "duration_seconds=$(( $(date +%s) - T0 ))"
} >"$OUT/receipt.txt"
export_log "PASS: $N object(s), $TOTAL byte(s), manifest and hashes written"
